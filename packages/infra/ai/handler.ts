import {
  converseTool,
  createClient,
  DEFAULT_MODEL_ID,
  ModelError,
  MODEL_TIMEOUT_MS,
  type BedrockLike,
  type ToolDef,
} from "./bedrock.js";
import {
  LIMITS,
  type AiErrorCode,
  type ApplicationHelpApplicationResponse,
  type ApplicationHelpEmailResponse,
  type ApplicationHelpRequest,
  type ApplicationHelpStudyResponse,
  type ParseTasksResponse,
} from "./contract.js";
import { capWords, verifyPoints } from "./grounding.js";
import {
  DRAFT_SYSTEM,
  DRAFT_TOOL,
  EMAIL_SYSTEM,
  EMAIL_TOOL,
  PARSE_SYSTEM,
  PARSE_TOOL,
  POINTS_SYSTEM,
  POINTS_TOOL,
  STUDY_SYSTEM,
  STUDY_TOOL,
  draftUserMessage,
  emailUserMessage,
  parseUserMessage,
  pointsUserMessage,
  studyUserMessage,
} from "./prompts.js";
import {
  validateApplicationHelpRequest,
  validateModelDraft,
  validateModelEmail,
  validateModelParseTasks,
  validateModelPoints,
  validateModelSteps,
  validateParseTasksRequest,
} from "./validate.js";

/** Minimal API Gateway HTTP API (payload v2) event shape used here. */
export interface HttpApiEvent {
  rawPath?: string;
  body?: string | null;
  isBase64Encoded?: boolean;
  requestContext?: {
    http?: { method?: string };
    authorizer?: { jwt?: { claims?: Record<string, unknown> } };
  };
}
export interface HttpApiResult {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
}

export interface HandlerDeps {
  client: BedrockLike;
  modelId: string;
  allowedSubs: string[];
  /** Total time budget for all model calls of one request (Lambda timeout is 25 s). */
  budgetMs?: number;
  now?: () => number;
}

export const PARSE_MAX_TOKENS = 700;
export const HELP_MAX_TOKENS = 900;
export const DRAFT_MAX_TOKENS = 400;
const REQUEST_BUDGET_MS = 22_000;

const STATUS: Record<AiErrorCode, number> = {
  invalid_request: 400,
  forbidden: 403,
  throttled: 429,
  model_error: 502,
  timeout: 504,
  not_found: 404,
  method_not_allowed: 405,
  internal: 500,
};

const HEADERS = { "content-type": "application/json", "cache-control": "no-store" };

function json(statusCode: number, body: unknown): HttpApiResult {
  return { statusCode, headers: { ...HEADERS }, body: JSON.stringify(body) };
}
function error(code: AiErrorCode, statusOverride?: number): HttpApiResult {
  return json(statusOverride ?? STATUS[code], { error: code });
}

export function parseAllowedSubs(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "");
}

interface CallArgs {
  system: string;
  user: string;
  tool: ToolDef;
  maxTokens: number;
}

interface Usage {
  inputTokens: number;
  outputTokens: number;
  modelMs: number;
}

export function makeHandler(deps: HandlerDeps): (event: HttpApiEvent) => Promise<HttpApiResult> {
  const now = deps.now ?? Date.now;
  return async (event) => {
    const route = event.rawPath ?? "";
    const usage: Usage = { inputTokens: 0, outputTokens: 0, modelMs: 0 };
    let result: HttpApiResult;
    try {
      result = await dispatch(event, deps, usage, now);
    } catch (e) {
      if (e instanceof ModelError) {
        result = error(e.kind);
      } else {
        result = error("internal");
      }
    }
    // Only route, status, model latency and token counts are ever logged.
    console.log(
      JSON.stringify({
        route,
        status: result.statusCode,
        latencyMs: usage.modelMs,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
      }),
    );
    return result;
  };
}

async function dispatch(
  event: HttpApiEvent,
  deps: HandlerDeps,
  usage: Usage,
  now: () => number,
): Promise<HttpApiResult> {
  const path = event.rawPath;
  if (path !== "/ai/parse-tasks" && path !== "/ai/application-help") return error("not_found");
  if (event.requestContext?.http?.method !== "POST") return error("method_not_allowed");

  // Allow-list check happens before the body is touched.
  const sub = event.requestContext?.authorizer?.jwt?.claims?.["sub"];
  if (typeof sub !== "string" || sub === "" || !deps.allowedSubs.includes(sub)) return error("forbidden");

  const raw = readBody(event);
  if (raw === undefined) return error("invalid_request");
  if (raw === "too_large") return error("invalid_request", 413);
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return error("invalid_request");
  }

  const deadline = now() + (deps.budgetMs ?? REQUEST_BUDGET_MS);
  const call = async (args: CallArgs) => {
    const started = now();
    try {
      return await converseTool({
        ...args,
        client: deps.client,
        modelId: deps.modelId,
        timeoutMs: Math.min(MODEL_TIMEOUT_MS, deadline - started),
      });
    } finally {
      usage.modelMs += now() - started;
    }
  };
  const track = <T extends { inputTokens: number; outputTokens: number }>(r: T): T => {
    usage.inputTokens += r.inputTokens;
    usage.outputTokens += r.outputTokens;
    return r;
  };

  if (path === "/ai/parse-tasks") {
    const req = validateParseTasksRequest(body);
    if (!req.ok) return error("invalid_request");
    const r = track(
      await call({ system: PARSE_SYSTEM, user: parseUserMessage(req.value.titles), tool: PARSE_TOOL, maxTokens: PARSE_MAX_TOKENS }),
    );
    const items = validateModelParseTasks(r.input, req.value.titles.length);
    if (!items.ok) return error("model_error");
    const out: ParseTasksResponse = { items: items.value };
    return json(200, out);
  }

  const req = validateApplicationHelpRequest(body);
  if (!req.ok) return error("invalid_request");
  const a = req.value;
  if (a.mode === "email") {
    const r = track(
      await call({ system: EMAIL_SYSTEM, user: emailUserMessage(a), tool: EMAIL_TOOL, maxTokens: HELP_MAX_TOKENS }),
    );
    const v = validateModelEmail(r.input);
    if (!v.ok) return error("model_error");
    const out: ApplicationHelpEmailResponse = {
      subject: v.value.subject,
      body: capWords(v.value.body, LIMITS.emailWords),
    };
    return json(200, out);
  }
  if (a.mode === "study") {
    const r = track(
      await call({ system: STUDY_SYSTEM, user: studyUserMessage(a), tool: STUDY_TOOL, maxTokens: HELP_MAX_TOKENS }),
    );
    const v = validateModelSteps(r.input);
    if (!v.ok) return error("model_error");
    const out: ApplicationHelpStudyResponse = { steps: v.value.steps };
    return json(200, out);
  }
  return json(200, await applicationFlow(a, call, track));
}

async function applicationFlow(
  a: ApplicationHelpRequest,
  call: (args: CallArgs) => ReturnType<typeof converseTool>,
  track: <T extends { inputTokens: number; outputTokens: number }>(r: T) => T,
): Promise<ApplicationHelpApplicationResponse> {
  const background = a.background ?? "";
  const questionEmpty = (a.question ?? "").trim() === "";

  // Step 1: points with verbatim quotes (skipped when there is no background to quote from).
  let verified: { text: string; quote: string }[] = [];
  let missing: string[] = [];
  if (background.trim() !== "") {
    const r = track(
      await call({ system: POINTS_SYSTEM, user: pointsUserMessage(a), tool: POINTS_TOOL, maxTokens: HELP_MAX_TOKENS }),
    );
    const pts = validateModelPoints(r.input);
    if (!pts.ok) throw new ModelError("model_error");
    ({ verified, missing } = verifyPoints(pts.value, background));
  }

  // Step 2: draft from verified points only (or a checklist when no question was given).
  let draft = "";
  let checklist: string[] = [];
  if (verified.length > 0 || questionEmpty) {
    const r = track(
      await call({ system: DRAFT_SYSTEM, user: draftUserMessage(a, verified), tool: DRAFT_TOOL, maxTokens: DRAFT_MAX_TOKENS }),
    );
    const d = validateModelDraft(r.input);
    if (!d.ok) throw new ModelError("model_error");
    draft = verified.length > 0 ? capWords(d.value.draft, LIMITS.draftWords) : "";
    checklist = questionEmpty ? d.value.checklist : [];
  }

  const out: ApplicationHelpApplicationResponse = { points: verified, missing, draft };
  if (checklist.length > 0) out.checklist = checklist;
  return out;
}

function readBody(event: HttpApiEvent): string | "too_large" | undefined {
  if (typeof event.body !== "string" || event.body === "") return undefined;
  // Cheap guard before decoding: base64 is ~4/3 larger than the payload.
  if (event.body.length > LIMITS.bodyBytes * 2) return "too_large";
  const text = event.isBase64Encoded ? Buffer.from(event.body, "base64").toString("utf8") : event.body;
  if (Buffer.byteLength(text, "utf8") > LIMITS.bodyBytes) return "too_large";
  return text;
}

// ---------- Lambda entry ----------

let cached: ((event: HttpApiEvent) => Promise<HttpApiResult>) | undefined;

export async function handler(event: HttpApiEvent): Promise<HttpApiResult> {
  cached ??= makeHandler({
    client: createClient(process.env["AWS_REGION"]),
    modelId: process.env["MODEL_ID"] || DEFAULT_MODEL_ID,
    allowedSubs: parseAllowedSubs(process.env["ALLOWED_SUBS"]),
  });
  return cached(event);
}
