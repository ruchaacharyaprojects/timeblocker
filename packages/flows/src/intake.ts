/**
 * Intake orchestration (R1) — pure of AWS/Google specifics.
 *
 * Moved from `packages/infra/lambda/intake/intake.ts` into `@timeblocker/flows`
 * so the infra Lambda and the on-device app share one implementation.
 *
 * This module turns a pasted/typed to-do list into a reviewable set of
 * candidate items, lets the user confirm or edit each item, and gates all
 * scheduling behind an explicit confirmation. It mirrors the planning Lambda's
 * shape: every side effect (DynamoDB reads/writes, triggering the planning
 * function) lives behind a small injected port, so the parse logic and the
 * confirmation gate are unit-testable with in-memory fakes — no network, no
 * AWS. There is no Bedrock (or any ML model) in v1: the input is parsed by a
 * pure {@link parseItemList} function.
 *
 * Flow:
 *   1. extractItems — parse the pasted/typed payload into candidate
 *      `IntakeItem`s with suggested duration/priority/category, and persist
 *      them as UNCONFIRMED (R1.1). On a malformed/empty payload the result is
 *      surfaced for manual entry and nothing is ever auto-scheduled (design.md
 *      error handling).
 *   2. confirmItems — apply the user's edits to duration/priority/category,
 *      mark the items confirmed (R1.2), persist them, and only then trigger
 *      planning (R1.3). The planning Lambda reads items where
 *      confirmed === true, so confirmation is the single scheduling gate.
 *
 * Everything that touches the network or AWS is injected by the handler in
 * `index.ts`.
 */

import type { Category } from "@timeblocker/scheduling-engine";
import {
  estimateCandidate,
  type EstimateSource,
  type HistoryEntry,
} from "./estimate.js";

// --- Domain model ----------------------------------------------------------

/** The five categories the reviewer may assign (design.md Item model). */
export const CATEGORIES: readonly Category[] = [
  "fitness",
  "self-care",
  "work",
  "self-development",
  "misc",
];

/** What a task is, set by the optional AI list reader (R33.1). */
export type TaskKind = "task" | "application" | "email" | "study" | "workout" | "errand" | "other";

/** All task kinds, for validators. */
export const TASK_KINDS: readonly TaskKind[] = [
  "task",
  "application",
  "email",
  "study",
  "workout",
  "errand",
  "other",
];

/** Default suggested duration when the input gives no usable hint, minutes. */
export const DEFAULT_DURATION_MIN = 30;
/** Default suggested priority (lower = more important; 1 = highest). */
export const DEFAULT_PRIORITY = 3;
/** Default suggested category when none can be inferred. */
export const DEFAULT_CATEGORY: Category = "misc";

/** Clamp bounds for a sane suggested duration (minutes). */
const MIN_DURATION_MIN = 5;
const MAX_DURATION_MIN = 8 * 60;
/** Clamp bounds for priority (1 = highest). */
const MIN_PRIORITY = 1;
const MAX_PRIORITY = 5;

/**
 * An item as persisted during intake (design.md Item model). It carries the
 * `confirmed` gate and the `weekId` it belongs to. The planning Lambda only
 * ever reads rows where `confirmed === true` (R1.3).
 */
export interface IntakeItem {
  id: string;
  text: string;
  durationMin: number;
  /** 1 = highest priority. */
  priority: number;
  category: Category;
  confirmed: boolean;
  weekId: string;
  /** Shared by every item expanded from one counted line (R20.5). */
  seriesId?: string;
  /** 1-based position within the series. */
  seriesIndex?: number;
  /** Number of items in the series. */
  seriesSize?: number;
  /** Exact start, ISO instant (R28.2). */
  fixedStart?: string;
  /** Single day to schedule on, YYYY-MM-DD Toronto (R28.3). */
  onDay?: string;
  /** Hard deadline, ISO instant (R28.5). */
  dueAt?: string;
  /** Notes for the plan summary (R28.6, R28.7). */
  scheduleNotes?: string[];
  /** Kind of task, set only by the AI list reader (R33.1). */
  kind?: TaskKind;
}

/**
 * A single parsed candidate before validation/clamping (R1.1). Any of the
 * suggested fields may be missing or nonsensical; `extractItems` normalizes
 * them into a valid `IntakeItem`. `confidence` (0..1), when the source
 * provides it, lets the client flag low-confidence rows for correction.
 */
export interface ParsedItem {
  text: string;
  durationMin?: number;
  priority?: number;
  category?: string;
  confidence?: number;
  /** Explicit repeat count (1..14), from JSON `count`/`times` or the pipe form. */
  count?: number;
  /** Validated schedule fields (ISO / YYYY-MM-DD), see R28. */
  fixedStart?: string;
  onDay?: string;
  dueAt?: string;
}

/** The parser's result: the parsed candidates plus an overall confidence. */
export interface ParsedItems {
  items: ParsedItem[];
  /** Overall confidence in the parse, 0..1, when the source reports it. */
  confidence?: number;
}

/**
 * A candidate surfaced on the review screen (R1.2). It is a normalized,
 * ready-to-persist `IntakeItem` (always unconfirmed at this stage) plus the
 * `lowConfidence` hint so the UI can highlight guesses that need a careful
 * look (design.md: surface raw guesses for manual correction).
 */
export interface ReviewCandidate {
  item: IntakeItem;
  lowConfidence: boolean;
}

/** Below this confidence a candidate is flagged for manual correction. */
export const LOW_CONFIDENCE_THRESHOLD = 0.6;

// --- Input parsing (R1.1) --------------------------------------------------

/**
 * Coerce an unknown field into a finite number, or undefined. Accepts numbers
 * and numeric strings so both JSON and pipe-delimited text share one path.
 */
function toOptionalNumber(raw: unknown): number | undefined {
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  if (typeof raw === "string" && raw.trim().length > 0) {
    const n = Number(raw.trim());
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

/** Coerce an unknown field into a non-empty trimmed string, or undefined. */
function toOptionalString(raw: unknown): string | undefined {
  if (typeof raw === "string" && raw.trim().length > 0) return raw.trim();
  return undefined;
}

/** Coerce a stated count into an integer 1..14, or undefined. */
function toCount(raw: unknown): number | undefined {
  const n = toOptionalNumber(raw);
  if (n === undefined || !Number.isInteger(n) || n < 1 || n > 14) return undefined;
  return n;
}

/** A parseable instant as a normalized ISO string, or undefined. */
function toIsoInstant(raw: unknown): string | undefined {
  const s = toOptionalString(raw);
  if (s === undefined) return undefined;
  const t = Date.parse(s);
  return Number.isFinite(t) ? new Date(t).toISOString() : undefined;
}

/** A valid YYYY-MM-DD calendar day, or undefined. */
function toDayKey(raw: unknown): string | undefined {
  const s = toOptionalString(raw);
  const m = s === undefined ? null : /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return undefined;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.getUTCFullYear() === Number(m[1]) &&
    d.getUTCMonth() === Number(m[2]) - 1 &&
    d.getUTCDate() === Number(m[3])
    ? s
    : undefined;
}

function applySchedule(item: ParsedItem, fixed: unknown, day: unknown, due: unknown): void {
  const f = toIsoInstant(fixed);
  if (f !== undefined) item.fixedStart = f;
  const o = toDayKey(day);
  if (o !== undefined) item.onDay = o;
  const d = toIsoInstant(due);
  if (d !== undefined) item.dueAt = d;
}

/** Map one loosely-typed object (from JSON) into a {@link ParsedItem}. */
function objectToParsedItem(obj: Record<string, unknown>): ParsedItem | null {
  const text = toOptionalString(obj.text);
  if (!text) return null;
  const item: ParsedItem = { text };
  const durationMin = toOptionalNumber(obj.durationMin);
  if (durationMin !== undefined) item.durationMin = durationMin;
  const priority = toOptionalNumber(obj.priority);
  if (priority !== undefined) item.priority = priority;
  const category = toOptionalString(obj.category);
  if (category !== undefined) item.category = category;
  const confidence = toOptionalNumber(obj.confidence);
  if (confidence !== undefined) item.confidence = confidence;
  const count = toCount(obj.count ?? obj.times);
  if (count !== undefined) item.count = count;
  applySchedule(item, obj.fixedStart, obj.onDay, obj.dueAt);
  return item;
}

/**
 * Parse one plain-text line into a {@link ParsedItem}. A line is either just
 * the item text, or the pipe-delimited form "text | minutes | priority |
 * category | count" — only the fields present are filled in. Empty lines yield null.
 */
function lineToParsedItem(line: string): ParsedItem | null {
  const trimmed = line.trim();
  if (trimmed.length === 0) return null;
  if (!trimmed.includes("|")) {
    return { text: trimmed };
  }
  const [textPart, minutesPart, priorityPart, categoryPart, countPart, fixedPart, dayPart, duePart] = trimmed
    .split("|")
    .map((p) => p.trim());
  const text = textPart;
  if (!text) return null;
  const item: ParsedItem = { text };
  const durationMin = toOptionalNumber(minutesPart);
  if (durationMin !== undefined) item.durationMin = durationMin;
  const priority = toOptionalNumber(priorityPart);
  if (priority !== undefined) item.priority = priority;
  const category = toOptionalString(categoryPart);
  if (category !== undefined) item.category = category;
  const count = toCount(countPart);
  if (count !== undefined) item.count = count;
  applySchedule(item, fixedPart, dayPart, duePart);
  return item;
}

/**
 * Parse a raw pasted/typed payload into {@link ParsedItems} (R1.1). Replaces
 * the old OCR step with a pure, dependency-free parser. Two input formats are
 * supported:
 *
 *   1. JSON — either a JSON array of item objects, e.g.
 *      `[{"text":"Finish report","durationMin":90,"priority":1,
 *        "category":"work","confidence":0.9}]`, or a JSON object wrapping them
 *      as `{"items":[...], "confidence":0.9}`. Every field except `text` is
 *      optional and defaulted later by the normalizers.
 *   2. Plain text — one item per line. Each non-empty line becomes a candidate
 *      with just `text`, or, when the line uses the pipe-delimited form
 *      "text | minutes | priority | category", with those fields parsed.
 *
 * JSON is attempted first; anything that is not valid item JSON falls back to
 * the line parser. A payload that yields no usable items returns an empty
 * `items` array, which {@link extractItems} surfaces as `ocrFailed: true`
 * exactly like the old OCR-failure path (manual entry, never auto-scheduled).
 */
export function parseItemList(raw: string): ParsedItems {
  if (typeof raw !== "string" || raw.trim().length === 0) {
    return { items: [] };
  }

  const trimmed = raw.trim();

  // 1. JSON path. A payload whose first non-space character is `[` or `{` is
  // treated as JSON: it must parse as a valid item list, otherwise it is
  // malformed and yields no items (it is NOT fed to the line parser, which
  // would mangle broken JSON into junk text items).
  if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      return { items: [] };
    }
    let rawItems: unknown;
    let confidence: number | undefined;
    if (Array.isArray(parsed)) {
      rawItems = parsed;
    } else if (parsed && typeof parsed === "object") {
      const obj = parsed as Record<string, unknown>;
      rawItems = obj.items;
      confidence = toOptionalNumber(obj.confidence);
    }
    if (Array.isArray(rawItems)) {
      const items = rawItems
        .filter(
          (e): e is Record<string, unknown> =>
            !!e && typeof e === "object" && !Array.isArray(e),
        )
        .map(objectToParsedItem)
        .filter((i): i is ParsedItem => i !== null);
      return confidence === undefined ? { items } : { items, confidence };
    }
    // Valid JSON but not an item list — treat as malformed.
    return { items: [] };
  }

  // 2. Plain text, one item per line (optionally pipe-delimited).
  const items = trimmed
    .split(/\r?\n/)
    .map(lineToParsedItem)
    .filter((i): i is ParsedItem => i !== null);
  return { items };
}

// --- Intake validation (R1.1, R11.4-R11.6) ---------------------------------

/** Maximum accepted paste-box length, characters (R11.4). */
export const MAX_INTAKE_CHARS = 20_000;
/** Maximum number of items one submission may produce (R11.5, R11.6). */
export const MAX_INTAKE_ITEMS = 100;

/** Why an intake submission was rejected (R11.6). */
export type IntakeRejectionReason =
  | "too-long"
  | "empty"
  | "malformed-json"
  | "no-items"
  | "too-many-items";

/**
 * A normalized candidate ready for the review screen (R1.2). It has no id or
 * week yet; those are assigned when the draft is persisted.
 */
export interface IntakeCandidate {
  text: string;
  durationMin: number;
  priority: number;
  category: Category;
  lowConfidence: boolean;
  /** How many separate tasks this line creates, 1..14 (R20.2). Default 1. */
  count: number;
  /** Where duration and category came from (always set by new code). */
  source?: EstimateSource;
  /**
   * Set when a stated total over 180 min was split into `count` sessions
   * (R22.1): the original total in minutes (capped at 2400).
   */
  splitFromTotalMin?: number;
  /** Exact start, ISO instant (R28.2). Dropped when count > 1. */
  fixedStart?: string;
  /** Single day, YYYY-MM-DD Toronto (R28.3). Dropped when count > 1. */
  onDay?: string;
  /** Hard deadline, ISO instant (R28.5); priority is forced to 1. */
  dueAt?: string;
  /** Notes for the plan summary. */
  scheduleNotes?: string[];
  /** Kind of task, set only by the AI list reader (R33.1). */
  kind?: TaskKind;
}

/** A line that is not a schedulable task (R22.3). */
export interface IgnoredLine {
  text: string;
  reason: "sleep";
}

/** Lines about sleeping, napping or bedtime are never scheduled (R22.3). */
const SLEEP_RE = /\b(sleep|sleeping|nap|bed ?time)\b/i;

export type IntakeValidationResult =
  | { ok: true; candidates: IntakeCandidate[]; ignored: IgnoredLine[] }
  | { ok: false; reason: IntakeRejectionReason };

/**
 * Validate a raw intake submission (pure). Checks run in this order:
 * `too-long` (> 20,000 chars), `empty` (empty or whitespace only),
 * `malformed-json` (first non-space char is `[` or `{` and `JSON.parse`
 * fails), `no-items` (nothing usable parsed), `too-many-items` (> 100).
 * Otherwise returns the parsed candidates, in input order, normalized with
 * the defaults (duration 30, priority 3, category misc). Plain text: each
 * non-blank line is one item (R11.4).
 */
export function validateIntakeInput(
  raw: string,
  history?: { blocks: HistoryEntry[]; events: HistoryEntry[] },
  nowMs: number = Date.now(),
): IntakeValidationResult {
  if (typeof raw !== "string") return { ok: false, reason: "empty" };
  if (raw.length > MAX_INTAKE_CHARS) return { ok: false, reason: "too-long" };

  const trimmed = raw.trim();
  if (trimmed.length === 0) return { ok: false, reason: "empty" };

  if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
    try {
      JSON.parse(trimmed);
    } catch {
      return { ok: false, reason: "malformed-json" };
    }
  }

  const parsed = parseItemList(raw);
  const nonEmpty = parsed.items.filter((c) => c.text.trim().length > 0);
  const ignored: IgnoredLine[] = [];
  const usable = nonEmpty.filter((c) => {
    if (SLEEP_RE.test(c.text)) {
      ignored.push({ text: c.text.trim(), reason: "sleep" });
      return false;
    }
    return true;
  });
  if (usable.length === 0) return { ok: false, reason: "no-items" };
  if (usable.length > MAX_INTAKE_ITEMS) {
    return { ok: false, reason: "too-many-items" };
  }

  // Unstated fields stay undefined until estimation (R15.6). Without history
  // the estimate falls back to inline durations, keywords and defaults.
  const blocks = history?.blocks ?? [];
  const events = history?.events ?? [];
  const candidates = usable.map((c): IntakeCandidate => {
    const est = estimateCandidate(
      {
        text: c.text.trim(),
        durationMin: c.durationMin,
        priority: c.priority,
        category: c.category,
        count: c.count,
        fixedStart: c.fixedStart,
        onDay: c.onDay,
        dueAt: c.dueAt,
      },
      blocks,
      events,
      nowMs,
    );
    // An explicit low per-item/overall confidence still flags the row.
    const conf = c.confidence ?? parsed.confidence;
    const lowConfidence =
      est.lowConfidence || (conf !== undefined && conf < LOW_CONFIDENCE_THRESHOLD);
    return { ...est, lowConfidence };
  });
  // R20.6: the 100-item limit applies to the expanded total.
  const expanded = candidates.reduce((sum, c) => sum + c.count, 0);
  if (expanded > MAX_INTAKE_ITEMS) {
    return { ok: false, reason: "too-many-items" };
  }
  return { ok: true, candidates, ignored };
}

// --- Injected ports --------------------------------------------------------

/** Persists and reads intake items for a week (DynamoDB items table). */
export interface ItemsStore {
  /** Write the given (unconfirmed or confirmed) items, upserting by id. */
  putItems(items: IntakeItem[]): Promise<void>;
  /** Read every item for a week, confirmed or not. */
  readItems(weekId: string): Promise<IntakeItem[]>;
}

/** Triggers the planning Lambda for a week after confirmation (R1.3). */
export interface PlanningTrigger {
  triggerPlanning(weekId: string): Promise<void>;
}

/** Generates stable, unique ids for new items (injected for determinism). */
export interface IdGenerator {
  next(): string;
}

export interface IntakeDeps {
  items: ItemsStore;
  planning: PlanningTrigger;
  ids: IdGenerator;
}

// --- Normalization ---------------------------------------------------------

function clamp(value: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, value));
}

/** Coerce an arbitrary duration guess into a sane minute count. */
export function normalizeDuration(raw: number | undefined): number {
  if (raw === undefined || !Number.isFinite(raw) || raw <= 0) {
    return DEFAULT_DURATION_MIN;
  }
  return clamp(Math.round(raw), MIN_DURATION_MIN, MAX_DURATION_MIN);
}

/** Coerce an arbitrary priority guess into 1..5 (1 = highest). */
export function normalizePriority(raw: number | undefined): number {
  if (raw === undefined || !Number.isFinite(raw)) return DEFAULT_PRIORITY;
  return clamp(Math.round(raw), MIN_PRIORITY, MAX_PRIORITY);
}

/** Map a category guess to a known `Category`, defaulting to misc. */
export function normalizeCategory(raw: string | undefined): Category {
  if (!raw) return DEFAULT_CATEGORY;
  const key = raw.trim().toLowerCase();
  const match = CATEGORIES.find((c) => c === key);
  return match ?? DEFAULT_CATEGORY;
}

/**
 * Turn one parsed candidate into a normalized, unconfirmed `IntakeItem`.
 * Text is trimmed; everything else is clamped to safe defaults so a garbled
 * guess still produces an editable row rather than being dropped.
 */
export function toIntakeItem(
  candidate: ParsedItem,
  weekId: string,
  id: string,
): IntakeItem {
  return {
    id,
    text: candidate.text.trim(),
    durationMin: normalizeDuration(candidate.durationMin),
    priority: normalizePriority(candidate.priority),
    category: normalizeCategory(candidate.category),
    // The gate (R1.3): freshly extracted items are never confirmed.
    confirmed: false,
    weekId,
  };
}

function isLowConfidence(
  candidate: ParsedItem,
  overall: number | undefined,
): boolean {
  const c = candidate.confidence ?? overall;
  // Unknown confidence is treated as low so the user is nudged to check it.
  if (c === undefined) return true;
  return c < LOW_CONFIDENCE_THRESHOLD;
}

// --- Extraction (R1.1) -----------------------------------------------------

export interface ExtractRequest {
  /** The raw pasted/typed payload (JSON item list or plain text lines). */
  itemsText: string;
  /** The week the extracted items belong to (YYYY-MM-DD of the Sunday). */
  weekId: string;
}

export interface ExtractResult {
  weekId: string;
  /** Review rows: normalized items plus a low-confidence hint (R1.2). */
  candidates: ReviewCandidate[];
  /**
   * True when the payload was malformed or produced nothing usable (design.md
   * fallback). The field keeps the `ocrFailed` name for API compatibility; it
   * now means "couldn't parse the pasted/typed list — add items manually".
   */
  ocrFailed: boolean;
}

/**
 * Parse the pasted/typed payload, persist the items as UNCONFIRMED, and return
 * review candidates for the review screen (R1.1 → R1.2).
 *
 * Robustness (design.md): if the payload is malformed or yields no items, this
 * resolves with an empty candidate list and `ocrFailed: true` rather than
 * throwing, so the UI can show a "couldn't read it — add items manually"
 * state. Nothing is ever scheduled here; items are written unconfirmed and the
 * scheduling gate (R1.3) is only crossed by {@link confirmItems}.
 */
export async function extractItems(
  request: ExtractRequest,
  deps: IntakeDeps,
): Promise<ExtractResult> {
  const result = parseItemList(request.itemsText);

  const usable = (result.items ?? []).filter(
    (c) => typeof c.text === "string" && c.text.trim().length > 0,
  );

  if (usable.length === 0) {
    return { weekId: request.weekId, candidates: [], ocrFailed: true };
  }

  const candidates: ReviewCandidate[] = usable.map((c) => ({
    item: toIntakeItem(c, request.weekId, deps.ids.next()),
    lowConfidence: isLowConfidence(c, result.confidence),
  }));

  // Persist the extracted items unconfirmed so the review screen and the
  // later confirm step read from a durable source of truth.
  await deps.items.putItems(candidates.map((c) => c.item));

  return { weekId: request.weekId, candidates, ocrFailed: false };
}

// --- Review edits + confirmation gate (R1.2, R1.3) -------------------------

/**
 * A user edit to a single item on the review screen (R1.2). `id` selects the
 * item; any provided field overrides the parsed suggestion. All fields are
 * optional so an unchanged item can be confirmed with just its id.
 */
export interface ItemEdit {
  id: string;
  text?: string;
  durationMin?: number;
  priority?: number;
  category?: Category;
}

export interface ConfirmRequest {
  weekId: string;
  /**
   * The ids the user confirmed, with any edits. Only these items are marked
   * confirmed; omitted items stay unconfirmed and are not scheduled (R1.3).
   */
  edits: ItemEdit[];
}

export interface ConfirmResult {
  weekId: string;
  /** The items that were marked confirmed and persisted. */
  confirmed: IntakeItem[];
  /** Whether planning was triggered (only when at least one item confirmed). */
  planningTriggered: boolean;
}

/** Apply an edit to an item, re-normalizing any changed numeric fields. */
export function applyEdit(item: IntakeItem, edit: ItemEdit): IntakeItem {
  const next: IntakeItem = { ...item };
  if (edit.text !== undefined) next.text = edit.text.trim();
  if (edit.durationMin !== undefined) {
    next.durationMin = normalizeDuration(edit.durationMin);
  }
  if (edit.priority !== undefined) {
    next.priority = normalizePriority(edit.priority);
  }
  if (edit.category !== undefined) {
    next.category = normalizeCategory(edit.category);
  }
  return next;
}

/**
 * Confirm the reviewed items and, only then, trigger planning (R1.2 → R1.3).
 *
 * This is the scheduling gate. It:
 *   1. loads the week's persisted (unconfirmed) items,
 *   2. applies the user's edits to the confirmed ids and sets
 *      `confirmed: true` on exactly those rows,
 *   3. persists the updated rows, and
 *   4. triggers the planning Lambda — but only if at least one item was
 *      actually confirmed, so an empty confirmation never schedules anything.
 *
 * Items the user did not confirm remain `confirmed: false` and are therefore
 * invisible to planning (which reads `confirmed === true`), satisfying "SHALL
 * NOT schedule any item until the user confirms the review" (R1.3).
 */
export async function confirmItems(
  request: ConfirmRequest,
  deps: IntakeDeps,
): Promise<ConfirmResult> {
  const stored = await deps.items.readItems(request.weekId);
  const byId = new Map(stored.map((i) => [i.id, i]));

  const editById = new Map(request.edits.map((e) => [e.id, e]));

  const confirmed: IntakeItem[] = [];
  for (const [id, edit] of editById) {
    const existing = byId.get(id);
    // Ignore ids that don't belong to this week's extracted items.
    if (!existing) continue;
    const edited = applyEdit(existing, edit);
    edited.confirmed = true;
    confirmed.push(edited);
  }

  if (confirmed.length > 0) {
    await deps.items.putItems(confirmed);
  }

  // The gate (R1.3): planning only runs once something is confirmed.
  let planningTriggered = false;
  if (confirmed.length > 0) {
    await deps.planning.triggerPlanning(request.weekId);
    planningTriggered = true;
  }

  return {
    weekId: request.weekId,
    confirmed,
    planningTriggered,
  };
}
