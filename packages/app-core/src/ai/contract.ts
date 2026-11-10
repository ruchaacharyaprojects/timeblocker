/**
 * AI service contract (design D28, R33.2, R34): request/response types and the
 * validators the phone applies to every reply. They mirror the server's
 * checks; a reply that fails them is discarded (R33.2).
 *
 * Validators never throw: they return the cleaned value or `undefined`.
 */
import { CATEGORIES, TASK_KINDS, type TaskKind } from "@timeblocker/flows";
import type { Category } from "@timeblocker/scheduling-engine";

// --- Limits (D28) ---------------------------------------------------------------

export const AI_MAX_TITLES = 40;
export const AI_MAX_TITLE_CHARS = 200;
export const AI_MAX_JOB_CHARS = 6000;
export const AI_MAX_QUESTION_CHARS = 600;
export const AI_MAX_BACKGROUND_CHARS = 3000;
export const AI_MAX_INTENT_CHARS = 300;
export const AI_MAX_TITLE_FIELD_CHARS = 200;
/** Drafts are cut to this many words (R34.3, R34.5). */
export const AI_MAX_DRAFT_WORDS = 120;
export const AI_MAX_STUDY_STEPS = 6;

const MAX_POINTS = 8;
const MAX_POINT_TEXT = 600;
const MAX_QUOTE = 400;
const MAX_MISSING = 12;
const MAX_LINE = 400;
const MAX_CHECKLIST = 12;
const MAX_SUBJECT = 200;
const MAX_BODY_CHARS = 2000;

// --- Types ----------------------------------------------------------------------

export type { TaskKind };

/** One entry of a parse-tasks reply: exactly one per title, in order. */
export interface ParseTasksItem {
  index: number;
  category: Category;
  kind: TaskKind;
}

export type ApplicationHelpMode = "application" | "email" | "study";

export interface ApplicationHelpRequest {
  mode: ApplicationHelpMode;
  title?: string;
  /** Job posting, up to 6,000 characters. */
  job?: string;
  /** Question to answer, up to 600 characters. */
  question?: string;
  /** User's background, up to 3,000 characters. */
  background?: string;
  /** One-line intent for email/study, up to 300 characters. */
  intent?: string;
}

export interface TalkingPoint {
  text: string;
  /** Short quote copied from the user's background (verified on the server). */
  quote: string;
}

export interface ApplicationPointsResponse {
  points: TalkingPoint[];
  /** "Add your own example for: ..." lines for points that could not be verified. */
  missing: string[];
  draft: string;
  checklist?: string[];
}

export interface EmailDraftResponse {
  subject: string;
  body: string;
}

export interface StudyStepsResponse {
  steps: string[];
}

export type ApplicationHelpResponse =
  | ApplicationPointsResponse
  | EmailDraftResponse
  | StudyStepsResponse;

export type AiFailureReason =
  | "disabled"
  | "not-configured"
  | "no-token"
  | "offline"
  | "timeout"
  | "rejected"
  | "forbidden"
  | "throttled"
  | "server"
  | "invalid-reply";

/** Outcome of an AI call; AI calls never throw for expected failures. */
export type AiResult<T> = { ok: true; value: T } | { ok: false; reason: AiFailureReason };

// --- Helpers --------------------------------------------------------------------

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** A string within `max` chars, trimmed; `undefined` if not a string or too long. */
function cappedString(v: unknown, max: number, allowEmpty = false): string | undefined {
  if (typeof v !== "string") return undefined;
  const t = v.trim();
  if (t.length > max) return undefined;
  if (t.length === 0 && !allowEmpty) return undefined;
  return t;
}

/** Trim and cut to at most `maxWords` whitespace-separated words. */
export function limitWords(text: string, maxWords: number = AI_MAX_DRAFT_WORDS): string {
  const trimmed = text.trim();
  const words = trimmed.split(/\s+/);
  if (trimmed.length === 0 || words.length <= maxWords) return trimmed;
  // Cut at the end of the last allowed word, keeping the original spacing and line breaks.
  let count = 0;
  const re = /\S+/g;
  let end = trimmed.length;
  for (let m = re.exec(trimmed); m; m = re.exec(trimmed)) {
    count++;
    if (count === maxWords) {
      end = m.index + m[0].length;
      break;
    }
  }
  return trimmed.slice(0, end);
}

function stringList(v: unknown, maxItems: number, maxChars: number, minItems = 0): string[] | undefined {
  if (!Array.isArray(v) || v.length > maxItems || v.length < minItems) return undefined;
  const out: string[] = [];
  for (const entry of v) {
    const s = cappedString(entry, maxChars);
    if (s === undefined) return undefined;
    out.push(s);
  }
  return out;
}

// --- parse-tasks ----------------------------------------------------------------

/**
 * Validate a parse-tasks reply: `{ items: [...] }` with exactly `expectedCount`
 * entries in order (`index` = position), a known category and a known kind
 * each. Anything else yields `undefined`.
 */
export function validateParseTasksResponse(
  data: unknown,
  expectedCount: number,
): ParseTasksItem[] | undefined {
  if (!isRecord(data) || !Array.isArray(data.items)) return undefined;
  if (!Number.isInteger(expectedCount) || expectedCount < 1 || expectedCount > AI_MAX_TITLES) return undefined;
  if (data.items.length !== expectedCount) return undefined;
  const out: ParseTasksItem[] = [];
  for (let i = 0; i < data.items.length; i++) {
    const entry: unknown = data.items[i];
    if (!isRecord(entry)) return undefined;
    if (entry.index !== i) return undefined;
    if (typeof entry.category !== "string" || !CATEGORIES.includes(entry.category as Category)) return undefined;
    if (typeof entry.kind !== "string" || !TASK_KINDS.includes(entry.kind as TaskKind)) return undefined;
    out.push({ index: i, category: entry.category as Category, kind: entry.kind as TaskKind });
  }
  return out;
}

// --- application-help -----------------------------------------------------------

/**
 * Validate an application-help reply for `mode`:
 * - application: `{points[{text, quote}], missing[], draft, checklist?}`;
 * - email: `{subject, body}` (body cut to 120 words);
 * - study: `{steps}` with 1 to 6 steps.
 * Drafts are trimmed and cut to 120 words. Anything else yields `undefined`.
 */
export function validateApplicationHelpResponse(
  mode: ApplicationHelpMode,
  data: unknown,
): ApplicationHelpResponse | undefined {
  if (!isRecord(data)) return undefined;
  switch (mode) {
    case "application": {
      if (!Array.isArray(data.points) || data.points.length > MAX_POINTS) return undefined;
      const points: TalkingPoint[] = [];
      for (const p of data.points as unknown[]) {
        if (!isRecord(p)) return undefined;
        const text = cappedString(p.text, MAX_POINT_TEXT);
        const quote = cappedString(p.quote, MAX_QUOTE);
        if (text === undefined || quote === undefined) return undefined;
        points.push({ text, quote });
      }
      const missing = stringList(data.missing, MAX_MISSING, MAX_LINE);
      if (missing === undefined) return undefined;
      const draft = cappedString(data.draft, MAX_BODY_CHARS, true);
      if (draft === undefined) return undefined;
      const result: ApplicationPointsResponse = { points, missing, draft: limitWords(draft) };
      if (data.checklist !== undefined) {
        const checklist = stringList(data.checklist, MAX_CHECKLIST, MAX_LINE);
        if (checklist === undefined) return undefined;
        result.checklist = checklist;
      }
      return result;
    }
    case "email": {
      const subject = cappedString(data.subject, MAX_SUBJECT);
      const body = cappedString(data.body, MAX_BODY_CHARS);
      if (subject === undefined || body === undefined) return undefined;
      return { subject, body: limitWords(body) };
    }
    case "study": {
      const steps = stringList(data.steps, AI_MAX_STUDY_STEPS, MAX_LINE, 1);
      return steps === undefined ? undefined : { steps };
    }
    default:
      return undefined;
  }
}

/** Cut a request's free-text fields to the documented caps (never sends more). */
export function clampApplicationHelpRequest(req: ApplicationHelpRequest): ApplicationHelpRequest {
  const out: ApplicationHelpRequest = { mode: req.mode };
  const put = (key: "title" | "job" | "question" | "background" | "intent", max: number) => {
    const v = req[key];
    if (typeof v === "string" && v.trim().length > 0) out[key] = v.trim().slice(0, max);
  };
  put("title", AI_MAX_TITLE_FIELD_CHARS);
  put("job", AI_MAX_JOB_CHARS);
  put("question", AI_MAX_QUESTION_CHARS);
  put("background", AI_MAX_BACKGROUND_CHARS);
  put("intent", AI_MAX_INTENT_CHARS);
  return out;
}

/** Whether `mode` is a known application-help mode. */
export function isApplicationHelpMode(mode: unknown): mode is ApplicationHelpMode {
  return mode === "application" || mode === "email" || mode === "study";
}
