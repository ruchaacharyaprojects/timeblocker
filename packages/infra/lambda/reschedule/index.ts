/**
 * Reschedule Lambda (R6): drives the "Will you miss this block?" flow. On a
 * "yes" answer it moves the block to the next valid slot in the same
 * Sunday-Saturday week, updating the Google Calendar event in place and
 * persisting the new slot with status "moved", and returns an Undo payload
 * that restores the previous slot (R6.1, R6.2). When no slot fits it returns
 * the "nothing fits" flow reusing the planning alert (R6.3).
 *
 * This handler only wires concrete adapters (Google OAuth + Calendar over
 * `fetch`, DynamoDB) to the injected ports in `reschedule.ts`; all of the flow
 * logic lives there and is unit-tested without a network. Google OAuth tokens
 * live in the DynamoDB settings table (encrypted at rest), loaded and
 * refreshed through a {@link DynamoDBTokenStore}.
 */

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
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
  runReschedule,
  DEFAULT_SETTINGS,
  type BlocksReader,
  type BlocksWriter,
  type PersistedBlock,
  type RescheduleRequest,
  type RescheduleSettings,
  type SettingsReader,
} from "./reschedule.js";

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
      return {
        id: row.id ?? row.blockId ?? blockId,
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

// --- Handler ---------------------------------------------------------------

interface ApiGatewayLike {
  body?: string | null;
}

function parseRequest(event: unknown): RescheduleRequest {
  const read = (src: Partial<RescheduleRequest> | undefined) => ({
    blockId: src?.blockId,
    weekId: src?.weekId,
    answer: src?.answer,
    now: src?.now,
  });

  const evt = event as ApiGatewayLike;
  let parsed: Partial<RescheduleRequest> | undefined;
  if (evt && typeof evt.body === "string" && evt.body.length > 0) {
    try {
      parsed = JSON.parse(evt.body) as Partial<RescheduleRequest>;
    } catch {
      parsed = undefined;
    }
  } else {
    parsed = event as Partial<RescheduleRequest>;
  }

  const { blockId, weekId, answer, now } = read(parsed);
  if (!blockId || !weekId) {
    throw new Error("reschedule request requires blockId and weekId");
  }
  return { blockId, weekId, answer, now };
}

export const handler = async (event: unknown): Promise<unknown> => {
  const blocksTable = requireEnv("BLOCKS_TABLE");
  const settingsTable = requireEnv("SETTINGS_TABLE");

  let request: RescheduleRequest;
  try {
    request = parseRequest(event);
  } catch (err) {
    return {
      statusCode: 400,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: "invalid reschedule request",
        error: err instanceof Error ? err.message : String(err),
      }),
    };
  }

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

  try {
    const outcome = await runReschedule(request, {
      blocks: makeBlocksReader(doc, blocksTable),
      blocksWriter: makeBlocksWriter(doc, blocksTable),
      settings: makeSettingsReader(doc, settingsTable),
      calendar,
    });

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(outcome),
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: "reschedule failed",
        error: err instanceof Error ? err.message : String(err),
      }),
    };
  }
};
