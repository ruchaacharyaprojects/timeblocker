/**
 * Intake Lambda (R1): turns a pasted/typed to-do list into reviewable items
 * and gates all scheduling behind explicit confirmation.
 *
 * This handler only wires concrete adapters (DynamoDB for the items table and
 * a Lambda invoke to trigger planning) to the injected ports in `intake.ts`;
 * all of the parse logic and the confirmation gate live there and are
 * unit-tested without a network. There is no Bedrock (or any ML model) in v1:
 * the pasted/typed list is parsed by the pure `parseItemList` function.
 *
 * It serves two actions on `POST /intake`, selected by the request body:
 *   { action: "extract", weekId, itemsText } → parse + persist UNCONFIRMED
 *   { action: "confirm", weekId, edits }       → mark confirmed + plan (R1.3)
 *
 * The planning Lambda reads items where `confirmed === true`, so planning is
 * only ever triggered after a successful `confirm` (R1.3).
 */

import { randomUUID } from "node:crypto";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  QueryCommand,
  BatchWriteCommand,
} from "@aws-sdk/lib-dynamodb";
import { LambdaClient, InvokeCommand } from "@aws-sdk/client-lambda";
import {
  extractItems,
  confirmItems,
  type IdGenerator,
  type IntakeDeps,
  type IntakeItem,
  type ItemEdit,
  type ItemsStore,
  type PlanningTrigger,
} from "./intake.js";

// --- Environment -----------------------------------------------------------

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
}

// --- DynamoDB items adapter ------------------------------------------------

function makeItemsStore(
  doc: DynamoDBDocumentClient,
  tableName: string,
): ItemsStore {
  return {
    async putItems(items: IntakeItem[]): Promise<void> {
      // BatchWrite caps at 25 items per request; chunk accordingly. The table
      // is keyed by (weekId, itemId), so we mirror `id` into `itemId`.
      for (let i = 0; i < items.length; i += 25) {
        const chunk = items.slice(i, i + 25);
        await doc.send(
          new BatchWriteCommand({
            RequestItems: {
              [tableName]: chunk.map((it) => ({
                PutRequest: { Item: { ...it, itemId: it.id } },
              })),
            },
          }),
        );
      }
    },
    async readItems(weekId: string): Promise<IntakeItem[]> {
      const res = await doc.send(
        new QueryCommand({
          TableName: tableName,
          KeyConditionExpression: "weekId = :w",
          ExpressionAttributeValues: { ":w": weekId },
        }),
      );
      const rows = (res.Items ?? []) as Array<
        IntakeItem & { itemId?: string }
      >;
      return rows.map((r) => ({
        id: r.id ?? r.itemId ?? "",
        text: r.text,
        durationMin: r.durationMin,
        priority: r.priority,
        category: r.category,
        confirmed: r.confirmed === true,
        weekId: r.weekId,
      }));
    },
  };
}

// --- Planning trigger adapter ----------------------------------------------

function makePlanningTrigger(
  lambda: LambdaClient,
  functionName: string,
): PlanningTrigger {
  return {
    async triggerPlanning(weekId: string): Promise<void> {
      // Fire planning asynchronously (Event) so confirmation returns promptly;
      // planning reads confirmed items for the week on its own.
      await lambda.send(
        new InvokeCommand({
          FunctionName: functionName,
          InvocationType: "Event",
          Payload: new TextEncoder().encode(JSON.stringify({ weekId })),
        }),
      );
    },
  };
}

// --- id generator ----------------------------------------------------------

const uuidIds: IdGenerator = { next: () => randomUUID() };

// --- Request parsing -------------------------------------------------------

interface ApiGatewayLike {
  body?: string | null;
}

type IntakeAction =
  | { action: "extract"; weekId: string; itemsText: string }
  | { action: "confirm"; weekId: string; edits: ItemEdit[] };

function parseBody(event: unknown): unknown {
  const evt = event as ApiGatewayLike;
  if (evt && typeof evt.body === "string" && evt.body.length > 0) {
    try {
      return JSON.parse(evt.body);
    } catch {
      return undefined;
    }
  }
  // Allow direct invocation with the request shape too.
  return event;
}

function parseAction(raw: unknown): IntakeAction | { error: string } {
  if (!raw || typeof raw !== "object") return { error: "missing request body" };
  const r = raw as Record<string, unknown>;
  const weekId = typeof r.weekId === "string" ? r.weekId : "";
  if (!weekId) return { error: "weekId is required" };

  if (r.action === "extract") {
    // Accept either `itemsText` or `itemsPayload` as the raw pasted/typed
    // list (JSON item array/object, or plain text lines).
    const payload =
      typeof r.itemsText === "string"
        ? r.itemsText
        : typeof r.itemsPayload === "string"
          ? r.itemsPayload
          : undefined;
    if (payload === undefined || payload.length === 0) {
      return { error: "itemsText is required for extract" };
    }
    return { action: "extract", weekId, itemsText: payload };
  }
  if (r.action === "confirm") {
    const edits = Array.isArray(r.edits) ? (r.edits as ItemEdit[]) : [];
    return { action: "confirm", weekId, edits };
  }
  return { error: "action must be 'extract' or 'confirm'" };
}

// --- Handler ---------------------------------------------------------------

export const handler = async (event: unknown): Promise<unknown> => {
  const itemsTable = requireEnv("ITEMS_TABLE");
  const planningFn = requireEnv("PLANNING_FUNCTION_NAME");

  const doc = DynamoDBDocumentClient.from(new DynamoDBClient({}));
  const deps: IntakeDeps = {
    items: makeItemsStore(doc, itemsTable),
    planning: makePlanningTrigger(new LambdaClient({}), planningFn),
    ids: uuidIds,
  };

  const parsed = parseAction(parseBody(event));
  if ("error" in parsed) {
    return {
      statusCode: 400,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: parsed.error }),
    };
  }

  try {
    if (parsed.action === "extract") {
      const result = await extractItems(
        { itemsText: parsed.itemsText, weekId: parsed.weekId },
        deps,
      );
      return {
        statusCode: 200,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(result),
      };
    }

    const result = await confirmItems(
      { weekId: parsed.weekId, edits: parsed.edits },
      deps,
    );
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
        message: "intake failed",
        error: err instanceof Error ? err.message : String(err),
      }),
    };
  }
};
