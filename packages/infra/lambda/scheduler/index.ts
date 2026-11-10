/**
 * Scheduler-target Lambda: invoked by EventBridge Scheduler for the three
 * recurring jobs — 15-minute block/meeting reminders (R5), the Sunday
 * planning nudge, and the Saturday review (R9).
 *
 * The scheduled payload carries a `job` discriminator so a single function
 * can fan out to the right behavior. This handler wires concrete adapters
 * (DynamoDB, Google OAuth + Calendar over `fetch`, and the device push
 * channel) to the injected ports in `reminders.ts`; the reminder selection
 * and delivery logic lives there and in `@timeblocker/reminders`, unit-tested
 * without a network.
 *
 * The Saturday review and Sunday planning nudge are wired here (task 10): the
 * compilation and nudge logic live in `review.ts`, unit-tested without a
 * network.
 */

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
} from "@aws-sdk/lib-dynamodb";
import {
  GoogleCalendarClient,
  GoogleOAuthClient,
  DynamoDBTokenStore,
  type CalendarHttpClient,
  type HttpClient,
  type TokenTablePort,
} from "@timeblocker/calendar-integration";
import type {
  NotificationPort,
  ReminderNotification,
} from "@timeblocker/reminders";
import type { UsageSummary } from "@timeblocker/usage-metrics";
import {
  runReminders,
  type BlocksReader,
  type PersistedBlockRow,
} from "./reminders.js";
import {
  runSaturdayReview,
  runSundayPlanningNudge,
  type NudgeNotification,
  type NudgePort,
  type PersistedBlock,
  type ReviewBlocksReader,
  type ReviewBlocksWriter,
  type ReviewWriter,
  type UsageSummaryReader,
  type WeeklyReview,
} from "./review.js";

type SchedulerJob = "reminders" | "sunday-planning-nudge" | "saturday-review";

interface SchedulerEvent {
  job: SchedulerJob;
  /** Optional override for the current instant (used in tests/backfills). */
  now?: string;
}

// --- Environment -----------------------------------------------------------

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
}

// --- Google OAuth token store (DynamoDB settings table) --------------------

/** The settings-table key the single user's Google OAuth tokens live under. */
const OAUTH_TOKENS_KEY = "google-oauth-tokens";

/**
 * Adapt the settings-table document client to the token store's
 * {@link TokenTablePort}. Tokens are stored as the serialized payload on the
 * `value` field of the item keyed by `settingKey` (the table's partition key),
 * encrypted at rest by the table's AWS-managed key. Only the reminders branch
 * talks to Google, so only it builds a token store.
 */
function makeTokenTablePort(
  doc: DynamoDBDocumentClient,
  tableName: string,
): TokenTablePort {
  return {
    async getTokenItem(settingKey) {
      const res = await doc.send(
        new GetCommand({ TableName: tableName, Key: { settingKey } }),
      );
      const row = res.Item as { value?: string } | undefined;
      return row?.value ?? null;
    },
    async putTokenItem(settingKey, value) {
      await doc.send(
        new PutCommand({
          TableName: tableName,
          Item: { settingKey, value },
        }),
      );
    },
  };
}

// --- Google HTTP adapters (global fetch, Node 22 runtime) ------------------

const oauthHttp: HttpClient = {
  async postForm(url, form) {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(form).toString(),
    });
    const body = await res.json().catch(() => ({}));
    return { status: res.status, body };
  },
};

const calendarHttp: CalendarHttpClient = {
  async get(url, accessToken) {
    const res = await fetch(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const body = await res.json().catch(() => ({}));
    return { status: res.status, body };
  },
  async post(url, accessToken, payload) {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });
    const body = await res.json().catch(() => ({}));
    return { status: res.status, body };
  },
  async put(url, accessToken, payload) {
    const res = await fetch(url, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });
    const body = await res.json().catch(() => ({}));
    return { status: res.status, body };
  },
};

// --- DynamoDB blocks reader ------------------------------------------------

function makeBlocksReader(
  doc: DynamoDBDocumentClient,
  tableName: string,
): BlocksReader {
  return {
    async readWeekBlocks(weekId) {
      const res = await doc.send(
        new QueryCommand({
          TableName: tableName,
          KeyConditionExpression: "weekId = :w",
          ExpressionAttributeValues: { ":w": weekId },
        }),
      );
      const rows = (res.Items ?? []) as Array<
        PersistedBlockRow & { blockId?: string }
      >;
      return rows.map((r) => ({
        id: r.id ?? r.blockId ?? "",
        itemId: r.itemId,
        start: r.start,
        end: r.end,
        title: r.title,
        text: r.text,
      }));
    },
  };
}

// --- DynamoDB review adapters ----------------------------------------------

/**
 * Reads the full persisted block rows for a week (status + category), used by
 * the Saturday review to classify blocks into finished/partial/missed and to
 * find fitness blocks that never happened (R8.1, R9.1).
 */
function makeReviewBlocksReader(
  doc: DynamoDBDocumentClient,
  tableName: string,
): ReviewBlocksReader {
  return {
    async readWeekBlocks(weekId) {
      const res = await doc.send(
        new QueryCommand({
          TableName: tableName,
          KeyConditionExpression: "weekId = :w",
          ExpressionAttributeValues: { ":w": weekId },
        }),
      );
      const rows = (res.Items ?? []) as Array<
        PersistedBlock & { blockId?: string }
      >;
      return rows.map((r) => ({
        id: r.id ?? r.blockId ?? "",
        itemId: r.itemId,
        start: r.start,
        end: r.end,
        category: r.category,
        status: r.status,
        weekId: r.weekId,
        title: r.title,
        text: r.text,
        moveReason: r.moveReason,
        color: r.color,
        calendarEventId: r.calendarEventId,
      }));
    },
  };
}

/** Persists a block whose status changed during the review (fitness-missed). */
function makeReviewBlocksWriter(
  doc: DynamoDBDocumentClient,
  tableName: string,
): ReviewBlocksWriter {
  return {
    async saveBlock(block) {
      await doc.send(
        new PutCommand({
          TableName: tableName,
          Item: { ...block, blockId: block.id },
        }),
      );
    },
  };
}

/** Persists the compiled weekly review to the reviews table (keyed by weekId). */
function makeReviewWriter(
  doc: DynamoDBDocumentClient,
  tableName: string,
): ReviewWriter {
  return {
    async saveReview(review: WeeklyReview) {
      await doc.send(
        new PutCommand({ TableName: tableName, Item: { ...review } }),
      );
    },
  };
}

/**
 * Reads the week's on-device usage summary signal. The device posts only the
 * aggregate `UsageSummary` (R7.3); it is stored on the week's reviews row under
 * `usageSummary` and read back here to show screen time + distraction level in
 * the review (R9.2). Returns null when none was reported for the week.
 */
function makeUsageSummaryReader(
  doc: DynamoDBDocumentClient,
  tableName: string,
): UsageSummaryReader {
  return {
    async readWeekSummary(weekId) {
      const res = await doc.send(
        new GetCommand({ TableName: tableName, Key: { weekId } }),
      );
      const row = res.Item as { usageSummary?: UsageSummary } | undefined;
      return row?.usageSummary ?? null;
    },
  };
}

// --- Sunday nudge push port ------------------------------------------------

/**
 * Resolve the Sunday-nudge push port. Mirrors the reminders push port: when
 * `PUSH_ENDPOINT` is configured the nudge is POSTed there (the channel the
 * Android handler renders); otherwise delivery is logged so the branch stays
 * functional in environments without a push provider wired up yet.
 */
function makeNudgePort(): NudgePort {
  const endpoint = process.env.PUSH_ENDPOINT;
  if (!endpoint) {
    return {
      async deliver(notification: NudgeNotification) {
        console.info("[sunday-nudge] deliver (no PUSH_ENDPOINT configured)", {
          id: notification.id,
          title: notification.title,
        });
      },
    };
  }
  return {
    async deliver(notification: NudgeNotification) {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(notification),
      });
      if (!res.ok) {
        throw new Error(`nudge delivery failed with status ${res.status}`);
      }
    },
  };
}

// --- Push notification port ------------------------------------------------

/**
 * Resolve the device push port. When `PUSH_ENDPOINT` is configured the
 * notification is POSTed to it (the channel the Android actionable-notification
 * handler renders); otherwise delivery is logged so the branch stays functional
 * in environments without a push provider wired up yet. The actionable buttons
 * ("I'm in" / "Skip" / "Move it") travel in the payload for the device to
 * render (R5.2).
 */
function makeNotificationPort(): NotificationPort {
  const endpoint = process.env.PUSH_ENDPOINT;
  if (!endpoint) {
    return {
      async deliver(notification: ReminderNotification) {
        console.info("[reminders] deliver (no PUSH_ENDPOINT configured)", {
          id: notification.id,
          kind: notification.kind,
          startsAt: notification.startsAt,
          actions: notification.actions.map((a) => a.id),
        });
      },
    };
  }
  return {
    async deliver(notification: ReminderNotification) {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(notification),
      });
      if (!res.ok) {
        throw new Error(`push delivery failed with status ${res.status}`);
      }
    },
  };
}

// --- Reminders branch ------------------------------------------------------

async function handleReminders(event: SchedulerEvent): Promise<unknown> {
  const blocksTable = requireEnv("BLOCKS_TABLE");
  const settingsTable = requireEnv("SETTINGS_TABLE");

  const doc = DynamoDBDocumentClient.from(new DynamoDBClient({}));

  const tokenStore = new DynamoDBTokenStore(
    makeTokenTablePort(doc, settingsTable),
    OAUTH_TOKENS_KEY,
  );
  const oauth = new GoogleOAuthClient(
    {
      clientId: requireEnv("GOOGLE_CLIENT_ID"),
      clientSecret: requireEnv("GOOGLE_CLIENT_SECRET"),
      redirectUri: requireEnv("GOOGLE_REDIRECT_URI"),
    },
    oauthHttp,
    tokenStore,
  );
  const calendar = new GoogleCalendarClient(oauth, calendarHttp);

  const result = await runReminders(
    { now: event.now },
    {
      blocks: makeBlocksReader(doc, blocksTable),
      calendar,
      notifier: makeNotificationPort(),
    },
  );

  return {
    statusCode: 200,
    body: JSON.stringify({
      job: "reminders",
      selected: result.selected.length,
      delivered: result.delivered.length,
      failures: result.failures,
    }),
  };
}

// --- Saturday review branch (R8.1, R9) -------------------------------------

async function handleSaturdayReview(event: SchedulerEvent): Promise<unknown> {
  const blocksTable = requireEnv("BLOCKS_TABLE");
  const reviewsTable = requireEnv("REVIEWS_TABLE");

  const doc = DynamoDBDocumentClient.from(new DynamoDBClient({}));

  const review = await runSaturdayReview(
    { now: event.now },
    {
      blocks: makeReviewBlocksReader(doc, blocksTable),
      blocksWriter: makeReviewBlocksWriter(doc, blocksTable),
      reviews: makeReviewWriter(doc, reviewsTable),
      usage: makeUsageSummaryReader(doc, reviewsTable),
    },
  );

  return {
    statusCode: 200,
    body: JSON.stringify({
      job: "saturday-review",
      weekId: review.weekId,
      finished: review.finished.length,
      partial: review.partial.length,
      missed: review.missed.length,
      movedToNextWeek: review.movedToNextWeek.length,
      fitnessMissed: review.fitnessMissedCount,
      screenTimeMin: review.screenTimeMin,
      distractionLevel: review.distractionLevel,
    }),
  };
}

// --- Sunday planning nudge branch (R9) -------------------------------------

async function handleSundayPlanningNudge(
  event: SchedulerEvent,
): Promise<unknown> {
  const notification = await runSundayPlanningNudge(
    { now: event.now },
    { nudge: makeNudgePort() },
  );

  return {
    statusCode: 200,
    body: JSON.stringify({
      job: "sunday-planning-nudge",
      delivered: notification.id,
    }),
  };
}

// --- Handler ---------------------------------------------------------------

export const handler = async (event: SchedulerEvent): Promise<unknown> => {
  switch (event?.job) {
    case "reminders":
      try {
        return await handleReminders(event);
      } catch (err) {
        return {
          statusCode: 500,
          body: JSON.stringify({
            job: "reminders",
            message: "reminders job failed",
            error: err instanceof Error ? err.message : String(err),
          }),
        };
      }
    case "saturday-review":
      try {
        return await handleSaturdayReview(event);
      } catch (err) {
        return {
          statusCode: 500,
          body: JSON.stringify({
            job: "saturday-review",
            message: "saturday review job failed",
            error: err instanceof Error ? err.message : String(err),
          }),
        };
      }
    case "sunday-planning-nudge":
      try {
        return await handleSundayPlanningNudge(event);
      } catch (err) {
        return {
          statusCode: 500,
          body: JSON.stringify({
            job: "sunday-planning-nudge",
            message: "sunday planning nudge job failed",
            error: err instanceof Error ? err.message : String(err),
          }),
        };
      }
    default:
      return {
        statusCode: 400,
        body: JSON.stringify({
          message: "unknown scheduler job",
          job: event?.job,
        }),
      };
  }
};
