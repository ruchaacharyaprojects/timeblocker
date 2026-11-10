/**
 * Calendar-sync Lambda (R4 / R6.1): reads the week's Google Calendar events
 * and watches for new meetings that overlap existing scheduled blocks. For
 * each conflicted block it raises the "Will you miss this block?" prompt
 * (R6.1). A "Yes" answer routes into the shared reschedule flow, which moves
 * the block to the next valid slot and offers Undo (R6.2).
 *
 * The handler accepts two actions via the request body's `action` field:
 *   - "detect" (default): run the meeting-conflict detection sweep for the
 *     week and raise a prompt per conflicted block.
 *   - "answer": the user tapped Yes/No on a raised prompt; route it into the
 *     reschedule orchestration.
 *
 * Google OAuth tokens live in the DynamoDB settings table (encrypted at rest).
 * This handler only wires concrete adapters (Google OAuth + Calendar over
 * `fetch`, DynamoDB, and the device push channel) to the injected ports in
 * `detect.ts` and `reschedule.ts`; the detection and reschedule logic lives
 * there and is unit-tested without a network.
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
import {
  runMeetingConflictDetection,
  runMeetingConflictAnswer,
  type DetectionDeps,
  type PromptRaiser,
  type WeekBlocksReader,
} from "./detect.js";
import {
  DEFAULT_SETTINGS,
  type BlocksReader,
  type BlocksWriter,
  type PersistedBlock,
  type RescheduleSettings,
  type SettingsReader,
} from "../reschedule/reschedule.js";
import type { NativeMissPrompt } from "../reschedule/prompt.js";

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
 * encrypted at rest by the table's AWS-managed key.
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

// --- DynamoDB adapters -----------------------------------------------------

const SETTINGS_KEY = "planning";

/** Map a stored blocks-table row to a {@link PersistedBlock}. */
function rowToBlock(
  row: PersistedBlock & { blockId?: string },
  fallbackId = "",
): PersistedBlock {
  return {
    id: row.id ?? row.blockId ?? fallbackId,
    itemId: row.itemId,
    start: row.start,
    end: row.end,
    category: row.category,
    color: row.color,
    calendarEventId: row.calendarEventId,
    status: row.status,
    weekId: row.weekId,
    title: row.title,
    text: row.text,
  };
}

/** Reads all persisted blocks for a week (for the detection sweep). */
function makeWeekBlocksReader(
  doc: DynamoDBDocumentClient,
  tableName: string,
): WeekBlocksReader {
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
      return rows.map((r) => rowToBlock(r));
    },
  };
}

/** Reads a single persisted block (for the reschedule answer path). */
function makeBlocksReader(
  doc: DynamoDBDocumentClient,
  tableName: string,
): BlocksReader {
  return {
    async readBlock(weekId, blockId) {
      const res = await doc.send(
        new GetCommand({
          TableName: tableName,
          Key: { weekId, blockId },
        }),
      );
      const row = res.Item as
        | (PersistedBlock & { blockId?: string })
        | undefined;
      if (!row) return null;
      return rowToBlock(row, blockId);
    },
  };
}

function makeBlocksWriter(
  doc: DynamoDBDocumentClient,
  tableName: string,
): BlocksWriter {
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

function makeSettingsReader(
  doc: DynamoDBDocumentClient,
  tableName: string,
): SettingsReader {
  return {
    async readSettings() {
      const res = await doc.send(
        new GetCommand({
          TableName: tableName,
          Key: { settingKey: SETTINGS_KEY },
        }),
      );
      const stored = res.Item as Partial<RescheduleSettings> | undefined;
      if (!stored) return DEFAULT_SETTINGS;
      return { holidays: stored.holidays ?? DEFAULT_SETTINGS.holidays };
    },
  };
}

// --- Device push prompt raiser ---------------------------------------------

/**
 * Resolve the prompt raiser. When `PUSH_ENDPOINT` is configured the "Will you
 * miss this block?" prompt is POSTed to it (the channel the Android actionable
 * -notification handler renders the Yes/No prompt from); otherwise the prompt
 * is logged so the branch stays functional in environments without a push
 * provider wired up yet (R6.1). The Yes/No actions travel in the payload.
 */
function makePromptRaiser(): PromptRaiser {
  const endpoint = process.env.PUSH_ENDPOINT;
  if (!endpoint) {
    return {
      async presentPrompt(prompt: NativeMissPrompt) {
        console.info("[calendar-sync] raise prompt (no PUSH_ENDPOINT configured)", {
          id: prompt.id,
          blockId: prompt.blockId,
          trigger: prompt.trigger,
          actions: prompt.actions.map((a) => a.id),
        });
      },
    };
  }
  return {
    async presentPrompt(prompt: NativeMissPrompt) {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(prompt),
      });
      if (!res.ok) {
        throw new Error(`prompt delivery failed with status ${res.status}`);
      }
    },
  };
}

// --- Request parsing -------------------------------------------------------

type CalendarSyncAction = "detect" | "answer";

interface ApiGatewayLike {
  body?: string | null;
}

interface CalendarSyncRequest {
  action: CalendarSyncAction;
  /** detect: any instant inside the week to check (defaults to now). */
  weekOf?: string;
  /** answer: the block the prompt was raised for. */
  blockId?: string;
  weekId?: string;
  answer?: "yes" | "no";
  now?: string;
}

function parseRequest(event: unknown): CalendarSyncRequest {
  const evt = event as ApiGatewayLike;
  let parsed: Partial<CalendarSyncRequest> | undefined;
  if (evt && typeof evt.body === "string" && evt.body.length > 0) {
    try {
      parsed = JSON.parse(evt.body) as Partial<CalendarSyncRequest>;
    } catch {
      parsed = undefined;
    }
  } else {
    parsed = event as Partial<CalendarSyncRequest>;
  }

  const action: CalendarSyncAction = parsed?.action === "answer" ? "answer" : "detect";
  if (action === "answer") {
    if (!parsed?.blockId || !parsed?.weekId) {
      throw new Error("answer action requires blockId and weekId");
    }
  }
  return {
    action,
    weekOf: parsed?.weekOf,
    blockId: parsed?.blockId,
    weekId: parsed?.weekId,
    answer: parsed?.answer,
    now: parsed?.now,
  };
}

// --- Shared wiring ---------------------------------------------------------

function makeCalendarClient(
  doc: DynamoDBDocumentClient,
  settingsTable: string,
): GoogleCalendarClient {
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
  return new GoogleCalendarClient(oauth, calendarHttp);
}

// --- Handler ---------------------------------------------------------------

export const handler = async (event: unknown): Promise<unknown> => {
  const blocksTable = requireEnv("BLOCKS_TABLE");
  const settingsTable = requireEnv("SETTINGS_TABLE");

  let request: CalendarSyncRequest;
  try {
    request = parseRequest(event);
  } catch (err) {
    return {
      statusCode: 400,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: "invalid calendar-sync request",
        error: err instanceof Error ? err.message : String(err),
      }),
    };
  }

  const doc = DynamoDBDocumentClient.from(new DynamoDBClient({}));
  const calendar = makeCalendarClient(doc, settingsTable);

  try {
    if (request.action === "answer") {
      const outcome = await runMeetingConflictAnswer(
        {
          blockId: request.blockId!,
          weekId: request.weekId!,
          answer: request.answer,
          now: request.now,
        },
        {
          blocks: makeBlocksReader(doc, blocksTable),
          blocksWriter: makeBlocksWriter(doc, blocksTable),
          settings: makeSettingsReader(doc, settingsTable),
          calendar,
        },
      );
      return {
        statusCode: 200,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(outcome),
      };
    }

    const deps: DetectionDeps = {
      blocks: makeWeekBlocksReader(doc, blocksTable),
      calendar,
      prompt: makePromptRaiser(),
    };
    const result = await runMeetingConflictDetection(
      { weekOf: request.weekOf },
      deps,
    );
    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        weekId: result.weekId,
        conflicts: result.conflicts.length,
        raised: result.raised.map((r) => r.prompt.id),
      }),
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: "calendar-sync failed",
        error: err instanceof Error ? err.message : String(err),
      }),
    };
  }
};
