/**
 * Dates, times and deadlines in task text (R28, design D24). Pure and
 * deterministic: everything is relative to the injected `nowMs`, in
 * America/Toronto (DST-safe through the engine's Toronto helpers).
 *
 * # What is recognized
 * - Times: `3pm`, `3 pm`, `3:30pm`, `15:00`, `15:30`, `noon`. A bare number
 *   ("at 7") is never a time; it needs am/pm, a `h:mm` colon form, or `noon`.
 *   (`midnight` is not parsed.)
 * - Time ranges: `3-4pm`, `3pm-4:30pm`, `9:00-10:15`, `9am to 10am`,
 *   `from 3 to 4pm`. A range yields a start time AND `durationMin`. A bare
 *   numeric range such as "2-3" is not a range.
 * - Days: `today`, `tonight`, `tomorrow`/`tmrw`, weekday names/abbreviations
 *   (sun, mon, tue/tues, wed, thu/thur/thurs, fri, sat), optionally with
 *   `on`, `this`, `next`.
 * - Dates: `Nov 12`, `Nov 12th`, `November 12, 2026`, `12 Nov`,
 *   `12th of November`, ISO `2026-11-12`, numeric `11/12` or `11/12/2026`
 *   (always MONTH/DAY). A month name needs a day number, so the verb
 *   "march" is left alone. Ordinal-only days ("on the 1st") are NOT parsed.
 * - Deadline words: `by`, `due`, `due on`, `before`, `until`, `till`,
 *   `deadline`, `no later than`, and the phrases `eod`/`end of day` and
 *   `eow`/`end of week` (which imply a deadline on their own). A deadline
 *   word counts only when it is directly followed by a date/time expression
 *   ("Read 2 chapters by hand" has no deadline).
 * - Connectors `at`, `@`, `on`, `from`, `starting`, `starts` directly before a
 *   recognized expression are removed with it.
 *
 * # Rules (decisions)
 * - Weekday semantics. A bare weekday (or `this <weekday>`) is the next
 *   occurrence, counting today when the stated time is still ahead or no time
 *   is stated; today's weekday with a time that has passed means next week.
 *   `next <weekday>` is that weekday in the Sunday-Saturday week AFTER the
 *   current one (so "next monday" on Fri 2026-11-06 is 2026-11-16, while
 *   "monday" is 2026-11-09).
 * - Past dates. A date before today is "past": the whole schedule is ignored
 *   (the recognized text is still removed from the title) with the note
 *   "Date in the past was ignored". A date WITHOUT a year earlier than today is
 *   read as next year only if it is more than 60 days in the past; otherwise
 *   it is past. A date with an explicit year is never rolled. Today's date
 *   with a time that already passed is NOT ignored: it stays a fixed start in
 *   the past (the planner reports it, R28.2).
 * - Fixed start: a day/date + time without a deadline word. Time only: today
 *   if still ahead, otherwise tomorrow. Day/date only: `onDay`.
 *   `tonight` without a time is 19:00 today when that is still ahead,
 *   otherwise `onDay` today.
 * - Deadlines (`dueAt`): day/date + time -> that instant; only a day/date ->
 *   17:00 that day; only a time -> today (tomorrow if passed). `eod` = 17:00
 *   today. `eow` = Friday 17:00 of the current week (next Friday when this
 *   week's Friday is already behind us). `tonight` as a deadline without a
 *   time is 22:00. A deadline at or before now is ignored with the note
 *   "Deadline in the past was ignored". Only the FIRST deadline expression is
 *   used; other date/time text on the line stays in the title. A time range
 *   inside a deadline expression contributes only its start time.
 * - Without a deadline word, the first time, first day and first date are
 *   used (a date wins over a weekday); extra expressions stay in the title.
 * - `Sunday school`-style titles are parsed (onDay Sunday); this is a known,
 *   documented ambiguity.
 * - The title never ends up empty: if removing the recognized text would
 *   empty it, the original text is returned and no schedule is produced.
 */

import {
  torontoDateKey,
  torontoInstant,
  torontoMinutesOfDay,
  torontoWeekday,
} from "@timeblocker/scheduling-engine";
import { cleanTitle } from "./titleClean.js";

/** Result of {@link extractSchedule}. */
export interface ScheduleParse {
  /** The text without the recognized schedule words (never empty). */
  title: string;
  /** Exact start, ISO instant (R28.2). */
  fixedStart?: string;
  /** A single day to schedule on, `YYYY-MM-DD` Toronto (R28.3). */
  onDay?: string;
  /** Hard deadline, ISO instant (R28.5). */
  dueAt?: string;
  /** Duration implied by a time range, minutes (not rounded or clamped). */
  durationMin?: number;
  /** Human-readable notes for the plan summary. */
  notes: string[];
}

export const NOTE_PAST_DATE = "Date in the past was ignored";
export const NOTE_PAST_DEADLINE = "Deadline in the past was ignored";
export const NOTE_FIXED_IGNORED = "Fixed time ignored for repeated tasks";

const TONIGHT_DEFAULT_MIN = 19 * 60;
const TONIGHT_DEADLINE_MIN = 22 * 60;
const END_OF_DAY_MIN = 17 * 60;
const ROLL_NEXT_YEAR_AFTER_DAYS = 60;

// --- Calendar helpers (pure integer date math, DST-free) ---------------------

interface Ymd {
  y: number;
  m: number;
  d: number;
}

const dayNumber = (a: Ymd): number => Date.UTC(a.y, a.m - 1, a.d) / 86_400_000;

function addDays(a: Ymd, n: number): Ymd {
  const t = new Date(Date.UTC(a.y, a.m - 1, a.d + n));
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
}

function validYmd(y: number, m: number, d: number): boolean {
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}

const pad2 = (n: number): string => String(n).padStart(2, "0");
const dayKey = (a: Ymd): string => `${a.y}-${pad2(a.m)}-${pad2(a.d)}`;

function instantIso(day: Ymd, minutes: number): string {
  return torontoInstant(day.y, day.m, day.d, Math.floor(minutes / 60), minutes % 60).toISOString();
}

// --- Token regexes -----------------------------------------------------------

const MONTH_PREFIXES = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const MONTH_WORD =
  "jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?";
const monthOf = (word: string): number => MONTH_PREFIXES.indexOf(word.slice(0, 3).toLowerCase()) + 1;

const WEEKDAY_WORD =
  "sunday|sun|monday|mon|tuesday|tues|tue|wednesday|wed|thursday|thurs|thur|thu|friday|fri|saturday|sat";
const weekdayOf = (word: string): number =>
  ["sun", "mon", "tue", "wed", "thu", "fri", "sat"].indexOf(word.slice(0, 3).toLowerCase());

// Units that make "Nov 5 minutes" / "1/2 hour" not a date.
const UNIT_AHEAD = String.raw`\s*(?:minutes?|mins?|hours?|hrs?|times|sessions?|pages?|chapters?|cups?|x\b)`;

const ISO_DATE_RE = /(?<![\w/.:-])(20\d{2})-(\d{2})-(\d{2})(?![\w/:])/g;
const NUMERIC_DATE_RE = new RegExp(
  String.raw`(?<![\w/.:-])(\d{1,2})/(\d{1,2})(?:/(20\d{2}))?(?![\w/:])(?!${UNIT_AHEAD})`,
  "gi",
);
const MONTH_DAY_RE = new RegExp(
  String.raw`(?<![a-z])(${MONTH_WORD})\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?![\w:])(?!\s*(?:am|pm)\b)(?!${UNIT_AHEAD})(?:,?\s+(20\d{2})(?![\w:]))?`,
  "gi",
);
const DAY_MONTH_RE = new RegExp(
  String.raw`(?<![\w/.:-])(\d{1,2})(?:st|nd|rd|th)?\s+(?:of\s+)?(${MONTH_WORD})\.?(?![a-z])(?:,?\s+(20\d{2})(?![\w:]))?`,
  "gi",
);
const RANGE_RE =
  /(?<![\w.:/-])(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*(?:-|–|—|to)\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)?(?![\w:])/gi;
const TIME_12H_RE = /(?<![\w.:/-])(\d{1,2})(?::(\d{2}))?\s*(am|pm)(?![a-z\d])/gi;
const TIME_24H_RE = /(?<![\w.:/-])([01]?\d|2[0-3]):([0-5]\d)(?![\w:])/g;
const NOON_RE = /(?<![\w])noon(?![\w])/gi;
const EOD_EOW_RE = /(?<![\w])(?:end\s+of\s+(?:the\s+)?(day|week)|(eod)|(eow))(?![\w])/gi;
const REL_DAY_RE = /(?<![\w])(today|tonight|tomorrow|tmrw)(?![\w])/gi;
const WEEKDAY_RE = new RegExp(
  String.raw`(?<![\w])(?:(this|next)\s+)?(${WEEKDAY_WORD})(?![a-z\d])`,
  "gi",
);
const DEADLINE_WORD_RE = /(?<![\w])(?:no\s+later\s+than|deadline|due|by|before|until|till)(?![\w])/gi;
/** Connectors directly in front of an expression; removed with it. */
const PREFIX_RE = /(?:(?<![\w])(?:at|on|from|starting|starts?)\s+|@\s*)+$/i;
/** Connector-ish words left dangling at the end of a title after removal. */
const DANGLING_END_RE = /(?:^|\s)(?:at|on|from|starting|starts?|by|due|before|until|till|deadline|no later than|@)$/i;

// --- Spans -------------------------------------------------------------------

type Kind = "time" | "day" | "date" | "eod" | "eow";

interface Span {
  start: number;
  end: number;
  kind: Kind;
  /** time: minutes since midnight. */
  min?: number;
  /** time from a range: implied duration. */
  durationMin?: number;
  /** day: relative word. */
  rel?: "today" | "tonight" | "tomorrow";
  /** day: weekday 0..6 and optional modifier. */
  weekday?: number;
  mod?: "this" | "next";
  /** date parts (year optional). */
  y?: number;
  m?: number;
  d?: number;
}

/** 12h/24h clock parts to minutes since midnight, or undefined if invalid. */
function clock(h: number, m: number, mer: string | undefined): number | undefined {
  if (m < 0 || m > 59) return undefined;
  if (mer) {
    if (h < 1 || h > 12) return undefined;
    return ((h % 12) + (mer === "pm" ? 12 : 0)) * 60 + m;
  }
  if (h < 0 || h > 23) return undefined;
  return h * 60 + m;
}

/** Resolve a clock range match into start minutes and duration, or undefined. */
function resolveRange(m: RegExpExecArray): { startMin: number; durationMin: number } | undefined {
  const sh = Number(m[1]);
  const sm = m[2] === undefined ? 0 : Number(m[2]);
  const mer1 = m[3]?.toLowerCase();
  const eh = Number(m[4]);
  const em = m[5] === undefined ? 0 : Number(m[5]);
  const mer2 = m[6]?.toLowerCase();
  // Needs a meridiem or a colon so "Study session 2-3" is not a range.
  if (!mer1 && !mer2 && m[2] === undefined && m[5] === undefined) return undefined;

  const done = (s: number | undefined, e: number | undefined) =>
    s !== undefined && e !== undefined && e > s ? { startMin: s, durationMin: e - s } : undefined;

  if (mer1 && mer2) return done(clock(sh, sm, mer1), clock(eh, em, mer2));
  if (mer2) {
    const e = clock(eh, em, mer2);
    const opposite = mer2 === "pm" ? "am" : "pm"; // "11-1pm" is 11am-1pm
    return done(clock(sh, sm, mer2), e) ?? done(clock(sh, sm, opposite), e);
  }
  if (mer1) return done(clock(sh, sm, mer1), clock(eh, em, mer1));
  return done(clock(sh, sm, undefined), clock(eh, em, undefined));
}

function collectSpans(text: string): Span[] {
  const spans: Span[] = [];
  const overlaps = (s: number, e: number): boolean => spans.some((x) => s < x.end && x.start < e);

  const collect = (re: RegExp, build: (m: RegExpExecArray) => Omit<Span, "start" | "end"> | undefined): void => {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      if (m[0].length === 0) {
        re.lastIndex++;
        continue;
      }
      const s = m.index;
      const e = s + m[0].length;
      if (overlaps(s, e)) continue;
      const built = build(m);
      if (!built) continue;
      // Pull in connectors like "at", "on", "from", "@" right before it.
      const windowStart = Math.max(0, s - 40);
      const pm = PREFIX_RE.exec(text.slice(windowStart, s));
      let start = s;
      if (pm && !overlaps(windowStart + pm.index, e)) start = windowStart + pm.index;
      spans.push({ start, end: e, ...built });
    }
  };

  const dateOf = (y: string | undefined, mo: number, d: number): Omit<Span, "start" | "end"> | undefined => {
    const year = y === undefined ? undefined : Number(y);
    // Validate against a leap year when no year is given ("Feb 29" is real).
    if (!validYmd(year ?? 2000, mo, d)) return undefined;
    return { kind: "date", y: year, m: mo, d };
  };

  collect(ISO_DATE_RE, (m) => dateOf(m[1], Number(m[2]), Number(m[3])));
  collect(NUMERIC_DATE_RE, (m) => dateOf(m[3], Number(m[1]), Number(m[2])));
  collect(MONTH_DAY_RE, (m) => dateOf(m[3], monthOf(m[1]!), Number(m[2])));
  collect(DAY_MONTH_RE, (m) => dateOf(m[3], monthOf(m[2]!), Number(m[1])));
  collect(RANGE_RE, (m) => {
    const r = resolveRange(m);
    return r ? { kind: "time", min: r.startMin, durationMin: r.durationMin } : undefined;
  });
  collect(TIME_12H_RE, (m) => {
    const min = clock(Number(m[1]), m[2] === undefined ? 0 : Number(m[2]), m[3]!.toLowerCase());
    return min === undefined ? undefined : { kind: "time", min };
  });
  collect(TIME_24H_RE, (m) => ({ kind: "time", min: Number(m[1]) * 60 + Number(m[2]) }));
  collect(NOON_RE, () => ({ kind: "time", min: 12 * 60 }));
  collect(EOD_EOW_RE, (m) => ({
    kind: m[1]?.toLowerCase() === "week" || m[3] !== undefined ? "eow" : "eod",
  }));
  collect(REL_DAY_RE, (m) => {
    const w = m[1]!.toLowerCase();
    return { kind: "day", rel: w === "tonight" ? "tonight" : w === "today" ? "today" : "tomorrow" };
  });
  collect(WEEKDAY_RE, (m) => ({
    kind: "day",
    weekday: weekdayOf(m[2]!),
    mod: m[1] ? (m[1].toLowerCase() as "this" | "next") : undefined,
  }));

  return spans.sort((a, b) => a.start - b.start);
}

// --- Resolution --------------------------------------------------------------

interface Clock {
  today: Ymd;
  weekday: number;
  nowMin: number;
}

/** A day/date reference resolved to a calendar day, or "past". */
type DayResult = { day: Ymd } | "past";

function resolveDay(span: Span, timeMin: number | undefined, c: Clock): DayResult {
  if (span.kind === "date") {
    const m = span.m!;
    const d = span.d!;
    let y = span.y;
    if (y === undefined) {
      y = c.today.y;
      const cand = { y, m, d };
      if (dayNumber(cand) < dayNumber(c.today) && dayNumber(c.today) - dayNumber(cand) > ROLL_NEXT_YEAR_AFTER_DAYS) {
        y += 1;
        if (!validYmd(y, m, d)) return "past"; // e.g. Feb 29 into a non-leap year
      }
    }
    const day = { y, m, d };
    return dayNumber(day) < dayNumber(c.today) ? "past" : { day };
  }
  if (span.rel === "tomorrow") return { day: addDays(c.today, 1) };
  if (span.rel) return { day: c.today };
  const wd = span.weekday!;
  if (span.mod === "next") {
    const nextSunday = addDays(c.today, 7 - c.weekday);
    return { day: addDays(nextSunday, wd) };
  }
  let delta = (wd - c.weekday + 7) % 7;
  if (delta === 0 && timeMin !== undefined && timeMin <= c.nowMin) delta = 7;
  return { day: addDays(c.today, delta) };
}

/** Time-only rule (R28.4): today if still ahead, otherwise tomorrow. */
function timeOnlyDay(timeMin: number, c: Clock): Ymd {
  return timeMin > c.nowMin ? c.today : addDays(c.today, 1);
}

// --- Public API --------------------------------------------------------------

/**
 * Extract the schedule (fixed start, single day, or deadline) from one task
 * line, relative to `nowMs` in America/Toronto. See the module comment for the
 * exact rules. Pure and deterministic.
 */
export function extractSchedule(text: string, nowMs: number): ScheduleParse {
  const none: ScheduleParse = { title: text, notes: [] };
  if (typeof text !== "string" || text.trim().length === 0 || !Number.isFinite(nowMs)) return none;

  const spans = collectSpans(text);
  if (spans.length === 0) return none;

  const nowDate = new Date(nowMs);
  const dayParts = torontoDateKey(nowDate).split("-").map(Number) as [number, number, number];
  const c: Clock = {
    today: { y: dayParts[0], m: dayParts[1], d: dayParts[2] },
    weekday: torontoWeekday(nowDate),
    nowMin: torontoMinutesOfDay(nowDate),
  };

  // Group neighbouring expressions ("Friday 5pm", "5pm on Friday").
  const clusters: Span[][] = [];
  for (const s of spans) {
    const last = clusters[clusters.length - 1];
    const prev = last?.[last.length - 1];
    if (last && prev && /^[\s,]*$/.test(text.slice(prev.end, s.start))) last.push(s);
    else clusters.push([s]);
  }

  // A deadline cluster follows a deadline word, or holds eod/eow.
  const wordSpans: Array<{ start: number; end: number }> = [];
  DEADLINE_WORD_RE.lastIndex = 0;
  for (let m: RegExpExecArray | null; (m = DEADLINE_WORD_RE.exec(text)) !== null; ) {
    wordSpans.push({ start: m.index, end: m.index + m[0].length });
  }
  let deadlineCluster: Span[] | undefined;
  let deadlineWord: { start: number; end: number } | undefined;
  for (const cl of clusters) {
    const word = wordSpans.find(
      (w) => w.end <= cl[0]!.start && /^[\s:]*$/.test(text.slice(w.end, cl[0]!.start)),
    );
    if (word || cl.some((s) => s.kind === "eod" || s.kind === "eow")) {
      deadlineCluster = cl;
      deadlineWord = word;
      break;
    }
  }

  const pool = deadlineCluster ?? spans.filter((s) => s.kind !== "eod" && s.kind !== "eow");
  const timeSpan = pool.find((s) => s.kind === "time");
  const dateSpan = pool.find((s) => s.kind === "date");
  const daySpan = pool.find((s) => s.kind === "day");
  const eodSpan = pool.find((s) => s.kind === "eod");
  const eowSpan = pool.find((s) => s.kind === "eow");
  const used = [timeSpan, dateSpan, daySpan, eodSpan, eowSpan].filter((s): s is Span => s !== undefined);
  if (used.length === 0) return none;

  const notes: string[] = [];
  const result: ScheduleParse = { title: text, notes };
  const dayRef = dateSpan ?? daySpan;
  const timeMin = timeSpan?.min;

  // Time-range interaction: a lone clock range ("Study 3-4pm") with no day,
  // date or deadline is left for `extractInlineDuration` (duration only).
  if (!deadlineCluster && !dayRef && timeSpan?.durationMin !== undefined) return none;

  if (deadlineCluster) {
    // --- Deadline (R28.5) ---------------------------------------------------
    let day: Ymd | undefined;
    let defaultMin = END_OF_DAY_MIN;
    let past = false;
    if (dayRef) {
      const r = resolveDay(dayRef, timeMin, c);
      if (r === "past") past = true;
      else day = r.day;
      if (dayRef.rel === "tonight") defaultMin = TONIGHT_DEADLINE_MIN;
    } else if (eowSpan) {
      const friday = addDays(c.today, 5 - c.weekday);
      day = dayNumber(friday) < dayNumber(c.today) ? addDays(friday, 7) : friday;
    } else if (eodSpan) {
      day = c.today;
    } else if (timeMin !== undefined) {
      day = timeOnlyDay(timeMin, c);
    }
    if (past) {
      notes.push(NOTE_PAST_DATE);
    } else if (day) {
      const iso = instantIso(day, timeMin ?? defaultMin);
      if (new Date(iso).getTime() <= nowMs) notes.push(NOTE_PAST_DEADLINE);
      else result.dueAt = iso;
    }
  } else {
    // --- Fixed start / single day (R28.2-R28.4) ------------------------------
    if (timeSpan?.durationMin !== undefined) result.durationMin = timeSpan.durationMin;
    if (dayRef) {
      const r = resolveDay(dayRef, timeMin, c);
      if (r === "past") {
        notes.push(NOTE_PAST_DATE);
      } else if (timeMin !== undefined) {
        result.fixedStart = instantIso(r.day, timeMin);
      } else if (dayRef.rel === "tonight" && TONIGHT_DEFAULT_MIN > c.nowMin) {
        result.fixedStart = instantIso(r.day, TONIGHT_DEFAULT_MIN);
      } else {
        result.onDay = dayKey(r.day);
      }
    } else if (timeMin !== undefined) {
      result.fixedStart = instantIso(timeOnlyDay(timeMin, c), timeMin);
    }
  }

  // --- Title: drop the used expressions and the deadline word ------------------
  const cuts = used.map((s) => ({ start: s.start, end: s.end }));
  if (deadlineWord && deadlineCluster) {
    cuts.push({ start: deadlineWord.start, end: Math.min(...used.map((s) => s.start)) });
  }
  cuts.sort((a, b) => a.start - b.start);
  let rest = "";
  let cursor = 0;
  for (const cut of cuts) {
    if (cut.start > cursor) rest += text.slice(cursor, cut.start);
    rest += " ";
    cursor = Math.max(cursor, cut.end);
  }
  rest += text.slice(cursor);
  let title = cleanTitle(rest);
  for (let prev = ""; prev !== title; ) {
    prev = title;
    title = cleanTitle(title.replace(DANGLING_END_RE, ""));
  }
  if (title.length === 0) return none; // never an empty title: keep the text, no schedule
  result.title = title;
  return result;
}

// --- Engine bridge -----------------------------------------------------------

/** Bounds the engine understands (see `Item` in @timeblocker/scheduling-engine). */
export interface EngineScheduleFields {
  fixedStartMs?: number;
  earliestMs?: number;
  latestEndMs?: number;
}

/**
 * Convert the stored schedule fields into engine `Item` fields: `fixedStart`
 * -> `fixedStartMs`; `onDay` -> `[earliestMs, latestEndMs]` = that Toronto day
 * `[00:00, 24:00)`; `dueAt` -> `latestEndMs` (the earlier of day end and
 * deadline when both are set). Invalid values are ignored.
 */
export function scheduleToEngineFields(s: {
  fixedStart?: string;
  onDay?: string;
  dueAt?: string;
}): EngineScheduleFields {
  const out: EngineScheduleFields = {};
  const fixed = s.fixedStart === undefined ? NaN : Date.parse(s.fixedStart);
  if (Number.isFinite(fixed)) out.fixedStartMs = fixed;
  const day = s.onDay !== undefined ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(s.onDay) : null;
  if (day && validYmd(Number(day[1]), Number(day[2]), Number(day[3]))) {
    const a = { y: Number(day[1]), m: Number(day[2]), d: Number(day[3]) };
    const next = addDays(a, 1);
    out.earliestMs = torontoInstant(a.y, a.m, a.d, 0, 0).getTime();
    out.latestEndMs = torontoInstant(next.y, next.m, next.d, 0, 0).getTime();
  }
  const due = s.dueAt === undefined ? NaN : Date.parse(s.dueAt);
  if (Number.isFinite(due)) out.latestEndMs = Math.min(out.latestEndMs ?? due, due);
  return out;
}
