/**
 * Planning Lambda (R2): runs the pure scheduling engine against the week's
 * Google Calendar events and the fixed R3 constraints, writes the placed
 * blocks to the calendar, persists them, and returns placed + unplaced items
 * — including the shrink / drop / roll-to-next-week alert for anything that
 * fits nowhere (R2.3).
 *
 * This handler only wires concrete adapters (Google OAuth + Calendar over
 * `fetch`, DynamoDB) to the injected ports in `plan.ts`; all of the planning
 * logic lives there and is unit-tested without a network. Google OAuth tokens
 * live in the DynamoDB settings table (encrypted at rest), loaded and
 * refreshed through a {@link DynamoDBTokenStore}.
 */

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  QueryCommand,
  GetCommand,
  PutCommand,
  BatchWriteCommand,
} from "@aws-sdk/lib-dynamodb";
import {
  GoogleCalendarClient,
  GoogleOAuthClient,
  DynamoDBTokenStore,
  type CalendarHttpClient,
  type HttpClient,
  type TokenTablePort,
} from "@timeblocker/calendar-integration";
import type { Item } from "@timeblocker/scheduling-engine";
import {
  runPlanning,
  DEFAULT_SETTINGS,
  type BlocksWriter,
  type ItemsReader,
  type PersistedBlock,
  type PlanningRequest,
  type PlanningSettings,
  type SettingsReader,
} from "./plan.js";

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

function makeItemsReader(
  doc: DynamoDBDocumentClient,
  tableName: string,
): ItemsReader {
  return {
    async readConfirmedItems(weekId) {
      const res = await doc.send(
        new QueryCommand({
          TableName: tableName,
          KeyConditionExpression: "weekId = :w",
          ExpressionAttributeValues: { ":w": weekId },
        }),
      );
      const rows = (res.Items ?? []) as Array<
        Item & { itemId: string; confirmed?: boolean }
      >;
      return rows
        .filter((r) => r.confirmed === true)
        .map((r) => ({
          id: r.id ?? r.itemId,
          text: r.text,
          durationMin: r.durationMin,
          priority: r.priority,
          category: r.category,
        }));
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
      const stored = res.Item as Partial<PlanningSettings> | undefined;
      if (!stored) return DEFAULT_SETTINGS;
      return {
        planningMode: stored.planningMode ?? DEFAULT_SETTINGS.planningMode,
        holidays: stored.holidays ?? DEFAULT_SETTINGS.holidays,
      };
    },
  };
}

function makeBlocksWriter(
  doc: DynamoDBDocumentClient,
  tableName: string,
): BlocksWriter {
  return {
    async saveBlocks(blocks) {
      // DynamoDB BatchWrite caps at 25 items per request; chunk accordingly.
      for (let i = 0; i < blocks.length; i += 25) {
        const chunk = blocks.slice(i, i + 25);
        await doc.send(
          new BatchWriteCommand({
            RequestItems: {
              [tableName]: chunk.map((b: PersistedBlock) => ({
                PutRequest: { Item: { ...b, blockId: b.id } },
              })),
            },
          }),
        );
      }
    },
  };
}

// --- Handler ---------------------------------------------------------------

interface ApiGatewayLike {
  body?: string | null;
}

function parseRequest(event: unknown): PlanningRequest {
  const evt = event as ApiGatewayLike;
  if (evt && typeof evt.body === "string" && evt.body.length > 0) {
    try {
      const parsed = JSON.parse(evt.body) as PlanningRequest;
      return { weekOf: parsed.weekOf, now: parsed.now };
    } catch {
      return {};
    }
  }
  // Allow direct invocation with the request shape too.
  const direct = event as PlanningRequest;
  return { weekOf: direct?.weekOf, now: direct?.now };
}

export const handler = async (event: unknown): Promise<unknown> => {
  const itemsTable = requireEnv("ITEMS_TABLE");
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

  try {
    const result = await runPlanning(parseRequest(event), {
      items: makeItemsReader(doc, itemsTable),
      settings: makeSettingsReader(doc, settingsTable),
      calendar,
      blocks: makeBlocksWriter(doc, blocksTable),
    });

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(result),
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: "planning failed",
        error: err instanceof Error ? err.message : String(err),
      }),
    };
  }
};
