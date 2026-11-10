import {
  CATEGORIES,
  KINDS,
  LIMITS,
  MODES,
  type AiCategory,
  type AiKind,
  type ApplicationHelpRequest,
  type ParseTasksItem,
  type ParseTasksRequest,
  type TalkingPoint,
} from "./contract.js";

export type Checked<T> = { ok: true; value: T } | { ok: false };

const fail = { ok: false } as const;
const ok = <T>(value: T): Checked<T> => ({ ok: true, value });

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function onlyKeys(o: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(o).every((k) => allowed.includes(k));
}

function optString(o: Record<string, unknown>, key: string, max: number): Checked<string | undefined> {
  const v = o[key];
  if (v === undefined) return ok(undefined);
  if (typeof v !== "string" || v.length > max) return fail;
  return ok(v);
}

const has = (s: string | undefined): boolean => s !== undefined && s.trim() !== "";

// ---------- Requests ----------

export function validateParseTasksRequest(body: unknown): Checked<ParseTasksRequest> {
  if (!isRecord(body) || !onlyKeys(body, ["titles"])) return fail;
  const t = body["titles"];
  if (!Array.isArray(t) || t.length < 1 || t.length > LIMITS.titlesMax) return fail;
  for (const x of t) {
    if (typeof x !== "string" || x.trim() === "" || x.length > LIMITS.titleChars) return fail;
  }
  return ok({ titles: t as string[] });
}

export function validateApplicationHelpRequest(body: unknown): Checked<ApplicationHelpRequest> {
  if (!isRecord(body) || !onlyKeys(body, ["mode", "title", "job", "question", "background", "intent"])) {
    return fail;
  }
  const mode = body["mode"];
  if (typeof mode !== "string" || !(MODES as readonly string[]).includes(mode)) return fail;
  const title = optString(body, "title", LIMITS.titleFieldChars);
  const job = optString(body, "job", LIMITS.jobChars);
  const question = optString(body, "question", LIMITS.questionChars);
  const background = optString(body, "background", LIMITS.backgroundChars);
  const intent = optString(body, "intent", LIMITS.intentChars);
  if (!title.ok || !job.ok || !question.ok || !background.ok || !intent.ok) return fail;
  const req: ApplicationHelpRequest = { mode: mode as ApplicationHelpRequest["mode"] };
  if (title.value !== undefined) req.title = title.value;
  if (job.value !== undefined) req.job = job.value;
  if (question.value !== undefined) req.question = question.value;
  if (background.value !== undefined) req.background = background.value;
  if (intent.value !== undefined) req.intent = intent.value;
  // Each mode needs something to work from.
  if (mode === "application" && !(has(req.job) || has(req.question) || has(req.title))) return fail;
  if ((mode === "email" || mode === "study") && !(has(req.title) || has(req.intent))) return fail;
  return ok(req);
}

// ---------- Model replies (tool input) ----------

export function validateModelParseTasks(input: unknown, count: number): Checked<ParseTasksItem[]> {
  if (!isRecord(input) || !Array.isArray(input["items"])) return fail;
  const items = input["items"] as unknown[];
  if (items.length !== count) return fail;
  const out: ParseTasksItem[] = [];
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (!isRecord(it)) return fail;
    if (it["index"] !== i) return fail;
    const c = it["category"];
    const k = it["kind"];
    if (typeof c !== "string" || !(CATEGORIES as readonly string[]).includes(c)) return fail;
    if (typeof k !== "string" || !(KINDS as readonly string[]).includes(k)) return fail;
    out.push({ index: i, category: c as AiCategory, kind: k as AiKind });
  }
  return ok(out);
}

function nonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.trim() !== "";
}

export function validateModelPoints(input: unknown): Checked<TalkingPoint[]> {
  if (!isRecord(input) || !Array.isArray(input["points"])) return fail;
  const out: TalkingPoint[] = [];
  for (const p of input["points"] as unknown[]) {
    if (!isRecord(p) || !nonEmptyString(p["text"]) || typeof p["quote"] !== "string") return fail;
    out.push({ text: p["text"].trim().slice(0, 300), quote: p["quote"].slice(0, 500) });
  }
  return ok(out.slice(0, LIMITS.pointsMax));
}

export function validateModelDraft(input: unknown): Checked<{ draft: string; checklist: string[] }> {
  if (!isRecord(input) || typeof input["draft"] !== "string") return fail;
  let checklist: string[] = [];
  const c = input["checklist"];
  if (c !== undefined) {
    if (!Array.isArray(c) || !c.every(nonEmptyString)) return fail;
    checklist = (c as string[]).slice(0, LIMITS.checklistMax).map((s) => s.trim().slice(0, 140));
  }
  return ok({ draft: input["draft"], checklist });
}

export function validateModelEmail(input: unknown): Checked<{ subject: string; body: string }> {
  if (!isRecord(input) || !nonEmptyString(input["subject"]) || !nonEmptyString(input["body"])) return fail;
  return ok({ subject: input["subject"].trim().slice(0, 150), body: input["body"] });
}

export function validateModelSteps(input: unknown): Checked<{ steps: string[] }> {
  if (!isRecord(input) || !Array.isArray(input["steps"])) return fail;
  const s = input["steps"] as unknown[];
  if (s.length < 1 || !s.every(nonEmptyString)) return fail;
  return ok({ steps: (s as string[]).slice(0, LIMITS.studyStepsMax).map((x) => x.trim().slice(0, 240)) });
}
