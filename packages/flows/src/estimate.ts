/**
 * Intake estimation (R15, design D12). Pure: no I/O, no repository access.
 *
 * Turns an item whose duration/category/priority may be unstated into a fully
 * specified {@link IntakeCandidate}, using (in order of precedence) what the
 * user stated, what text hints at, past blocks, past calendar events, and
 * finally per-category defaults.
 */

import type { Category } from "@timeblocker/scheduling-engine";
import type { IntakeCandidate } from "./intake.js";
import { cleanTitle } from "./titleClean.js";
import { extractSchedule, NOTE_FIXED_IGNORED } from "./schedule.js";

// --- Constants -------------------------------------------------------------

/** Category order used for tie-breaking (matches `CATEGORIES` in intake.ts). */
const CATEGORY_ORDER: readonly Category[] = [
  "fitness",
  "self-care",
  "work",
  "self-development",
  "misc",
];

const MIN_MIN = 5;
const MAX_MIN = 480;
const DEFAULT_PRIORITY_VALUE = 3;

/** Default duration per category when nothing else is known (R15.4). */
export const CATEGORY_DEFAULT_DURATION_MIN: Readonly<Record<Category, number>> =
  {
    work: 60,
    "self-development": 45,
    fitness: 45,
    "self-care": 30,
    misc: 30,
  };

// --- Types -----------------------------------------------------------------

/** One past block or past calendar event, flattened for estimation. */
export interface HistoryEntry {
  title: string;
  category: Category;
  durationMin: number;
  /** Block status; entries with status "skipped" are ignored for durations. */
  status?: string;
}

/** Where each estimated value came from. */
export interface EstimateSource {
  duration: "stated" | "history" | "calendar" | "default";
  category: "stated" | "history" | "keyword" | "default";
}

/** A candidate before estimation; `undefined` means "not stated". */
export interface RawCandidate {
  text: string;
  durationMin?: number;
  category?: string;
  priority?: number;
  /** Explicit count (1..14); wins over a count stated in the text. */
  count?: number;
  /** Explicit schedule fields (pipe/JSON forms); they win over text-derived ones. */
  fixedStart?: string;
  onDay?: string;
  dueAt?: string;
}

// --- Helpers ---------------------------------------------------------------

/** Largest total accepted from inline text (R22.1), minutes. */
export const MAX_TOTAL_MIN = 2400;
/** Totals above this become a series of sessions (R22.1), minutes. */
export const SPLIT_THRESHOLD_MIN = 180;
/** Longest single session produced by a split (R22.1), minutes. */
export const MAX_SESSION_MIN = 120;

/** Round to the nearest 5 minutes and clamp to 5..`max` (default 480). */
function roundClamp(minutes: number, max: number = MAX_MIN): number {
  const rounded = Math.round(minutes / 5) * 5;
  return Math.min(max, Math.max(MIN_MIN, rounded));
}

/**
 * Split a long total (> 180 min) into sessions of at most 120 min (R22.1):
 * `count = min(14, ceil(total/120))`, per-session minutes rounded to 5 and
 * clamped to 5..120. Totals of 180 or less are returned as one block.
 */
export function splitTotal(totalMin: number): { count: number; durationMin: number } {
  const total = Math.min(MAX_TOTAL_MIN, totalMin);
  if (total <= SPLIT_THRESHOLD_MIN) {
    return { count: 1, durationMin: roundClamp(total) };
  }
  const count = Math.min(MAX_COUNT, Math.ceil(total / MAX_SESSION_MIN));
  return { count, durationMin: roundClamp(total / count, MAX_SESSION_MIN) };
}

/**
 * Tidy a title after removing count/duration text: drop empty brackets,
 * collapse spaces, and strip leading/trailing separators (R22.2).
 */
// (`cleanTitle` lives in ./titleClean.ts so schedule.ts can share it.)

// --- Inline duration extraction (R15.2) -------------------------------------

interface Found {
  start: number;
  end: number;
  minutes: number;
  /** Allow "at" as a dangling lead-in (only for clock ranges). */
  range: boolean;
}

const NUM = String.raw`(\d+(?:\.\d+)?)`;
const LB = String.raw`(?<![\w.:])`;

const RANGE_RE = new RegExp(
  String.raw`${LB}(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*(?:-|–|—|to)\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)?(?![\w:])`,
  "gi",
);
const HOURS_MINS_RE = new RegExp(
  String.raw`${LB}${NUM}\s*(?:hours?|hrs?|h)\s*(\d{1,2})\s*(?:minutes?|mins?|m)(?![a-z])`,
  "gi",
);
// "1h30": minutes attached directly to the hour unit, no unit on the minutes.
const HOURS_ATTACHED_RE = new RegExp(
  String.raw`${LB}(\d+)\s*h(\d{2})(?![\w])`,
  "gi",
);
const HOURS_RE = new RegExp(
  String.raw`${LB}${NUM}\s*(?:hours?|hrs?|h)(?![a-z\d])`,
  "gi",
);
const MINS_RE = new RegExp(
  String.raw`${LB}${NUM}\s*(?:minutes?|mins?|m)(?![a-z\d])`,
  "gi",
);

/** Convert 12h/24h clock parts to minutes since midnight, or undefined. */
function clock(
  h: number,
  m: number,
  mer: "am" | "pm" | undefined,
): number | undefined {
  if (m < 0 || m > 59) return undefined;
  if (mer) {
    if (h < 1 || h > 12) return undefined;
    return ((h % 12) + (mer === "pm" ? 12 : 0)) * 60 + m;
  }
  if (h < 0 || h > 23) return undefined;
  return h * 60 + m;
}

function rangeMinutes(m: RegExpExecArray): number | undefined {
  const sh = Number(m[1]);
  const sm = m[2] === undefined ? 0 : Number(m[2]);
  const mer1 = m[3]?.toLowerCase() as "am" | "pm" | undefined;
  const eh = Number(m[4]);
  const em = m[5] === undefined ? 0 : Number(m[5]);
  const mer2 = m[6]?.toLowerCase() as "am" | "pm" | undefined;

  // Require a meridiem or a colon somewhere so "Chapter 2-3" is not a range.
  const hasColon = m[2] !== undefined || m[5] !== undefined;
  if (!mer1 && !mer2 && !hasColon) return undefined;

  if (mer1 && mer2) {
    const s = clock(sh, sm, mer1);
    const e = clock(eh, em, mer2);
    if (s === undefined || e === undefined || e <= s) return undefined;
    return e - s;
  }
  if (mer2) {
    // Start has no meridiem: try the end's meridiem first, then the opposite
    // (so "11-1pm" is 11am-1pm).
    const e = clock(eh, em, mer2);
    if (e === undefined) return undefined;
    const opposite = mer2 === "pm" ? "am" : "pm";
    for (const mer of [mer2, opposite] as const) {
      const s = clock(sh, sm, mer);
      if (s !== undefined && e > s) return e - s;
    }
    return undefined;
  }
  if (mer1) {
    // End has no meridiem: assume it shares the start's.
    const s = clock(sh, sm, mer1);
    const e = clock(eh, em, mer1);
    if (s === undefined || e === undefined || e <= s) return undefined;
    return e - s;
  }
  // Both bare 24h-style clock times with a colon, e.g. 9:00-10:15.
  const s = clock(sh, sm, undefined);
  const e = clock(eh, em, undefined);
  if (s === undefined || e === undefined || e <= s) return undefined;
  return e - s;
}

function lastMatch(
  text: string,
  re: RegExp,
  toMinutes: (m: RegExpExecArray) => number | undefined,
  range: boolean,
): Found | undefined {
  re.lastIndex = 0;
  let found: Found | undefined;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const minutes = toMinutes(m);
    if (minutes !== undefined && Number.isFinite(minutes) && minutes > 0) {
      found = { start: m.index, end: m.index + m[0].length, minutes, range };
    }
    if (m[0].length === 0) re.lastIndex++;
  }
  return found;
}

/**
 * Find a duration stated in `text` and strip it from the title (R15.2).
 *
 * Supports "30 min/mins/minutes", "45m", "1h", "1 hr", "2 hrs", "1.5 hours",
 * "1h30", "1h 30m", "for 2 hrs", "(90m)" and clock ranges ("3-4pm",
 * "3pm-4:30pm", "9:00-10:15", "9am to 10am"). A bare number is never a
 * duration. The result is rounded to 5 minutes and clamped to 5..2400 (the
 * caller splits totals over 180 or clamps per session to 480). If
 * stripping would empty the title, the original text is kept as the title.
 * The last match of the highest-priority pattern is used.
 */
export function extractInlineDuration(text: string): {
  title: string;
  durationMin?: number;
} {
  const found =
    lastMatch(text, RANGE_RE, rangeMinutes, true) ??
    lastMatch(text, HOURS_MINS_RE, (m) => Number(m[1]) * 60 + Number(m[2]), false) ??
    lastMatch(text, HOURS_ATTACHED_RE, (m) => Number(m[1]) * 60 + Number(m[2]), false) ??
    lastMatch(text, HOURS_RE, (m) => Number(m[1]) * 60, false) ??
    lastMatch(text, MINS_RE, (m) => Number(m[1]), false);
  if (!found) return { title: text };

  let before = text.slice(0, found.start);
  let after = text.slice(found.end);

  // Swallow wrapping parentheses: "(90m)".
  const open = /\(\s*$/.exec(before);
  const close = /^\s*\)/.exec(after);
  if (open && close) {
    before = before.slice(0, open.index);
    after = after.slice(close[0].length);
  }

  // Remove dangling lead-ins left in front of the match.
  const lead = found.range
    ? /(?:\s+(?:for|at)|\s*[@\-–—,])?\s*$/i
    : /(?:\s+for|\s*[@\-–—,])?\s*$/i;
  before = before.replace(/^for\s*$/i, "").replace(lead, "");

  const title = cleanTitle(`${before} ${after}`);

  return {
    title: title.length > 0 ? title : text,
    durationMin: roundClamp(found.minutes, MAX_TOTAL_MIN),
  };
}

// --- Inline count extraction (R20.2, R20.3) ----------------------------------

/** Smallest and largest accepted count (R20.2). */
export const MIN_COUNT = 1;
export const MAX_COUNT = 14;

const WORD_NUMBERS: Readonly<Record<string, number>> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7,
};
const COUNT_WORDS: Readonly<Record<string, number>> = {
  once: 1, twice: 2, thrice: 3,
};

const NUM_TOKEN = String.raw`(\d{1,3}|one|two|three|four|five|six|seven)`;
// Optional "a week" / "per week" / "this week" / "each week" / "/week" tail.
const WEEK_TAIL = String.raw`(?:\s*/\s*week|\s+(?:a|per|this|each)\s+week)?`;
const CB = String.raw`(?<![\w.])`;

// "3x", "3 x", "3x a week", "3x/week"
const COUNT_NX_RE = new RegExp(
  String.raw`${CB}${NUM_TOKEN}\s*x(?![\w])${WEEK_TAIL}`,
  "gi",
);
// "x3", "x 3"
const COUNT_XN_RE = new RegExp(
  String.raw`(?<![\w])x\s*(\d{1,3})(?![\w.:])${WEEK_TAIL}`,
  "gi",
);
// "3 times", "three times a week", "3 sessions"
const COUNT_TIMES_RE = new RegExp(
  String.raw`${CB}${NUM_TOKEN}\s*(?:times|sessions?)(?![\w])${WEEK_TAIL}`,
  "gi",
);
// "3 days a week", "3 days per week"
const COUNT_DAYS_RE = new RegExp(
  String.raw`${CB}${NUM_TOKEN}\s*days?\s+(?:a|per|this|each)\s+week(?![\w])`,
  "gi",
);
// "once" / "twice" / "thrice": only before a week phrase, at the end of the
// text, before a comma/semicolon/period, or right before an inline duration.
const COUNT_WORD_RE = new RegExp(
  String.raw`(?<![\w])(once|twice|thrice)(?![\w])(?:\s+(?:a|per|this|each)\s+week(?![\w])|(?=[\s.,;!?]*$)|(?=\s*[,;.])|(?=\s+(?:for\s+)?\d+(?:\.\d+)?\s*(?:hours?|hrs?|h|minutes?|mins?|m)(?![a-z\d])))`,
  "gi",
);

function wordOrNumber(token: string): number {
  const lower = token.toLowerCase();
  return WORD_NUMBERS[lower] ?? Number(lower);
}

interface CountFound {
  start: number;
  end: number;
  count: number;
}

function countMatches(
  text: string,
  re: RegExp,
  toCount: (m: RegExpExecArray) => number,
): CountFound[] {
  re.lastIndex = 0;
  const out: CountFound[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const count = toCount(m);
    if (Number.isInteger(count) && count >= MIN_COUNT && count <= MAX_COUNT) {
      out.push({ start: m.index, end: m.index + m[0].length, count });
    }
    if (m[0].length === 0) re.lastIndex++;
  }
  return out;
}

/**
 * Find a repeat count stated in `text` and strip it from the title (R20.2).
 *
 * Recognized (case-insensitive, whole token): "3x", "3 x", "x3", "x 3",
 * "3 times", "3 sessions", "3 days a/per/this/each week", the words one..seven
 * before "times", and "once"/"twice"/"thrice". A "a week"/"per week"/"this
 * week"/"each week"/"/week" right after a count phrase is stripped with it.
 *
 * "once"/"twice"/"thrice" count only when followed by a week phrase, the end
 * of the text, a comma/semicolon/period, or an inline duration; so "Call mom
 * once she is home" is left alone. The number must be 1..14 (otherwise the
 * phrase is ignored and stays in the title). Bare numbers never count. When
 * several phrases match, the last one wins. If stripping would empty the
 * title, the original text is kept and no count is returned.
 */
export function extractCount(text: string): { title: string; count?: number } {
  const all = [
    ...countMatches(text, COUNT_NX_RE, (m) => wordOrNumber(m[1]!)),
    ...countMatches(text, COUNT_XN_RE, (m) => Number(m[1])),
    ...countMatches(text, COUNT_TIMES_RE, (m) => wordOrNumber(m[1]!)),
    ...countMatches(text, COUNT_DAYS_RE, (m) => wordOrNumber(m[1]!)),
    ...countMatches(text, COUNT_WORD_RE, (m) => COUNT_WORDS[m[1]!.toLowerCase()]!),
  ];
  if (all.length === 0) return { title: text };
  const found = all.reduce((best, c) =>
    c.start > best.start || (c.start === best.start && c.end > best.end) ? c : best,
  );

  let before = text.slice(0, found.start);
  let after = text.slice(found.end);

  // Swallow wrapping parentheses: "(3x)".
  const open = /\(\s*$/.exec(before);
  const close = /^\s*\)/.exec(after);
  if (open && close) {
    before = before.slice(0, open.index);
    after = after.slice(close[0].length);
  }

  const title = cleanTitle(`${before} ${after}`);

  if (title.length === 0) return { title: text };
  return { title, count: found.count };
}

// --- Similarity (R15.3) -----------------------------------------------------

const FILLER = new Set([
  "a", "an", "the", "to", "for", "of", "and", "my", "with", "on", "at", "in",
  "up", "out", "do", "some",
]);

function stem(word: string): string {
  if (word.length > 3 && word.endsWith("s") && !/(ss|us)$/.test(word)) {
    return word.slice(0, -1);
  }
  return word;
}

/** "(i of n)" series suffix added to counted tasks (R20.5); not real text. */
const SERIES_SUFFIX_RE = /\(\s*\d+\s+of\s+\d+\s*\)/g;

function words(text: string): string[] {
  return text
    .replace(SERIES_SUFFIX_RE, " ")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .split(" ")
    .filter((w) => w.length > 0 && !FILLER.has(w))
    .map(stem);
}

/**
 * Shared-word share of two titles: |A∩B| / max(|A|,|B|) over distinct words
 * after lowercasing, removing punctuation, dropping filler words and
 * stripping a plural "s". 0 when either set is empty.
 */
export function similarity(a: string, b: string): number {
  const sa = new Set(words(a));
  const sb = new Set(words(b));
  if (sa.size === 0 || sb.size === 0) return 0;
  let shared = 0;
  for (const w of sa) if (sb.has(w)) shared++;
  return shared / Math.max(sa.size, sb.size);
}

/** Titles are similar when they share at least half of their words. */
export function isSimilar(a: string, b: string): boolean {
  return similarity(a, b) >= 0.5;
}

// --- Category keywords (R15.5) ----------------------------------------------

const KEYWORDS: Readonly<Record<Category, readonly string[]>> = {
  fitness: [
    "gym", "run", "running", "jog", "workout", "yoga", "stretch", "stretching",
    "walk", "swim", "lift", "lifting", "cardio", "pilates", "hike", "exercise",
  ],
  "self-care": [
    "meditate", "meditation", "shower", "skincare", "sleep", "nap", "journal",
    "bath", "self care", "self-care",
  ],
  work: [
    "email", "report", "meeting", "client", "invoice", "slides", "deck",
    "presentation", "review", "standup", "project", "meeting prep",
  ],
  "self-development": [
    "read", "reading", "study", "studying", "course", "practice", "learn",
    "lecture", "homework", "leetcode", "tutorial",
  ],
  misc: [],
};

/** Normalise to space-padded stemmed words for whole-word phrase matching. */
function padded(text: string): string {
  return ` ${text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .split(" ")
    .filter((w) => w.length > 0)
    .map(stem)
    .join(" ")} `;
}

const KEYWORD_PHRASES: ReadonlyArray<[Category, string[]]> = CATEGORY_ORDER.map(
  (c) => [c, [...new Set(KEYWORDS[c].map((k) => padded(k)))]],
);

/**
 * Infer a category from keywords (whole word, case-insensitive). The category
 * with the most distinct keyword matches wins; ties go to the earlier one in
 * fitness, self-care, work, self-development order. `undefined` if none.
 */
export function inferCategory(text: string): Category | undefined {
  const hay = padded(text);
  let best: Category | undefined;
  let bestCount = 0;
  for (const [category, phrases] of KEYWORD_PHRASES) {
    const count = phrases.filter((p) => hay.includes(p)).length;
    if (count > bestCount) {
      best = category;
      bestCount = count;
    }
  }
  return best;
}

// --- Estimation (R15.2 - R15.6) ---------------------------------------------

function usable(e: HistoryEntry): boolean {
  return Number.isFinite(e.durationMin) && e.durationMin > 0;
}

/**
 * Median of the similar entries' durations (done/partial only when any exist, else all but skipped), rounded to 5.
 * For an even count the two middle values are averaged, then rounded
 * (37.5 -> 40). Undefined when no entry is similar.
 */
function medianDuration(title: string, history: HistoryEntry[]): number | undefined {
  const similar = history.filter((e) => usable(e) && isSimilar(title, e.title));
  // R23.4: prefer blocks that ended done/partial; otherwise all but skipped.
  const completed = similar.filter((e) => e.status === "done" || e.status === "partial");
  const values = (completed.length > 0 ? completed : similar.filter((e) => e.status !== "skipped"))
    .map((e) => e.durationMin)
    .sort((x, y) => x - y);
  if (values.length === 0) return undefined;
  const mid = Math.floor(values.length / 2);
  const median =
    values.length % 2 === 1 ? values[mid]! : (values[mid - 1]! + values[mid]!) / 2;
  return roundClamp(median);
}

/**
 * Most common category among similar past blocks (skipped blocks still
 * count). Ties go to the category seen first in the input, so pass history
 * most recent first.
 */
function historyCategory(title: string, history: HistoryEntry[]): Category | undefined {
  const counts = new Map<Category, number>();
  for (const e of history) {
    if (!isSimilar(title, e.title)) continue;
    counts.set(e.category, (counts.get(e.category) ?? 0) + 1);
  }
  let best: Category | undefined;
  let bestCount = 0;
  for (const [category, count] of counts) {
    // Map preserves first-insertion order, so strict ">" keeps the earliest.
    if (count > bestCount) {
      best = category;
      bestCount = count;
    }
  }
  return best;
}

function statedCategory(raw: string | undefined): Category | undefined {
  if (!raw) return undefined;
  const key = raw.trim().toLowerCase();
  return CATEGORY_ORDER.find((c) => c === key);
}

/**
 * Fill in the unstated fields of `candidate`.
 *
 * The title has any inline count stripped first (R20.2); `count` is the
 * stated count, else the inline one, else 1.
 *
 * Duration precedence: stated > inline text > median of similar blocks >
 * median of similar events > category default. Category precedence: stated >
 * most common among similar blocks > keywords > "misc". Priority: stated or 3.
 * The title has any inline duration/range stripped.
 *
 * `lowConfidence` is false only when the duration is stated/from history and
 * the category is not the default.
 */
export function estimateCandidate(
  candidate: RawCandidate,
  blockHistory: HistoryEntry[],
  eventHistory: HistoryEntry[],
  nowMs?: number,
): IntakeCandidate {
  // R28: schedule words first (only when a clock is supplied), then count,
  // then inline duration, all on the remaining title.
  const sched =
    nowMs === undefined
      ? undefined
      : extractSchedule(candidate.text.trim(), nowMs);
  const counted = extractCount(sched ? sched.title : candidate.text.trim());
  const textDuration = extractInlineDuration(counted.title);
  const extracted =
    textDuration.durationMin === undefined && sched?.durationMin !== undefined
      ? {
          title: textDuration.title,
          durationMin: roundClamp(sched.durationMin, MAX_TOTAL_MIN),
        }
      : textDuration;
  const title = extracted.title;
  const stated_ = candidate.count;
  let count =
    stated_ !== undefined &&
    Number.isInteger(stated_) &&
    stated_ >= MIN_COUNT &&
    stated_ <= MAX_COUNT
      ? stated_
      : (counted.count ?? 1);

  // Category first: the default duration depends on it.
  const stated = statedCategory(candidate.category);
  let category: Category;
  let categorySource: EstimateSource["category"];
  if (stated) {
    category = stated;
    categorySource = "stated";
  } else {
    const fromHistory = historyCategory(title, blockHistory);
    const fromKeyword = fromHistory ? undefined : inferCategory(title);
    if (fromHistory) {
      category = fromHistory;
      categorySource = "history";
    } else if (fromKeyword) {
      category = fromKeyword;
      categorySource = "keyword";
    } else {
      category = "misc";
      categorySource = "default";
    }
  }

  let durationMin: number;
  let durationSource: EstimateSource["duration"];
  const explicit = candidate.durationMin;
  if (explicit !== undefined && Number.isFinite(explicit) && explicit > 0) {
    durationMin = Math.min(MAX_MIN, Math.max(MIN_MIN, Math.round(explicit)));
    durationSource = "stated";
  } else if (extracted.durationMin !== undefined) {
    durationMin = extracted.durationMin;
    durationSource = "stated";
  } else {
    const fromBlocks = medianDuration(title, blockHistory);
    const fromEvents = fromBlocks === undefined ? medianDuration(title, eventHistory) : undefined;
    if (fromBlocks !== undefined) {
      durationMin = fromBlocks;
      durationSource = "history";
    } else if (fromEvents !== undefined) {
      durationMin = fromEvents;
      durationSource = "calendar";
    } else {
      durationMin = CATEGORY_DEFAULT_DURATION_MIN[category];
      durationSource = "default";
    }
  }

  // R22.1: a stated total over 3 h with no count becomes a series of sessions.
  let splitFromTotalMin: number | undefined;
  if (durationSource === "stated") {
    if (count === 1 && durationMin > SPLIT_THRESHOLD_MIN) {
      const split = splitTotal(durationMin);
      splitFromTotalMin = Math.min(MAX_TOTAL_MIN, durationMin);
      count = split.count;
      durationMin = split.durationMin;
    } else {
      // Per-session duration keeps the old 480 cap when a count is given.
      durationMin = Math.min(MAX_MIN, durationMin);
    }
  }

  const p = candidate.priority;
  const priority =
    p !== undefined && Number.isFinite(p)
      ? Math.min(5, Math.max(1, Math.round(p)))
      : DEFAULT_PRIORITY_VALUE;

  // Schedule fields: explicit (pipe/JSON) values win over text-derived ones.
  const notes = [...(sched?.notes ?? [])];
  let fixedStart = candidate.fixedStart ?? sched?.fixedStart;
  let onDay = candidate.onDay ?? sched?.onDay;
  const dueAt = candidate.dueAt ?? sched?.dueAt;
  if (fixedStart && onDay) onDay = undefined;
  if (count > 1 && (fixedStart || onDay)) {
    fixedStart = undefined;
    onDay = undefined;
    notes.push(NOTE_FIXED_IGNORED);
  }
  const finalPriority = dueAt ? 1 : priority;

  const source: EstimateSource = { duration: durationSource, category: categorySource };
  return {
    text: title,
    durationMin,
    priority: finalPriority,
    category,
    count,
    ...(fixedStart ? { fixedStart } : {}),
    ...(onDay ? { onDay } : {}),
    ...(dueAt ? { dueAt } : {}),
    ...(notes.length > 0 ? { scheduleNotes: notes } : {}),
    lowConfidence:
      !(
        (durationSource === "stated" || durationSource === "history") &&
        categorySource !== "default"
      ),
    source,
    ...(splitFromTotalMin !== undefined ? { splitFromTotalMin } : {}),
  };
}
