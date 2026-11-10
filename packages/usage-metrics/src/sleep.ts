/**
 * Sleep window and sleep score (R19, D16). Pure and dependency-free.
 *
 * usage-metrics has no dependency on the scheduling engine, so the small
 * America/Toronto helpers below mirror `scheduling-engine/src/timezone.ts`
 * (Intl based, DST-safe, no date library).
 */

import type { AppUsageRecord, UsageWindow } from "./types.js";

/** Sleep starts at 22:00 Toronto. Same constant as the planner (R3.4). */
export const SLEEP_START_MIN = 22 * 60;
/** Sleep ends (wake time) at 06:30 Toronto the next day (R3.4). */
export const SLEEP_END_MIN = 6 * 60 + 30;

/** Packages whose foreground time never counts as phone use at night (R19.2). */
export const SLEEP_EXCLUDED_PACKAGES: readonly string[] = [
  "com.timeblocker.app",
  "com.android.systemui",
];

const TZ = "America/Toronto";
const MIN_MS = 60_000;
const DAY_MS = 86_400_000;

const fmt = new Intl.DateTimeFormat("en-US", {
  timeZone: TZ,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});

interface Wall {
  y: number;
  m: number;
  d: number;
  h: number;
  mi: number;
  s: number;
}

function wallClock(ms: number): Wall {
  const map: Record<string, string> = {};
  for (const p of fmt.formatToParts(new Date(ms))) {
    if (p.type !== "literal") map[p.type] = p.value;
  }
  let h = Number(map.hour);
  if (h === 24) h = 0;
  return {
    y: Number(map.year),
    m: Number(map.month),
    d: Number(map.day),
    h,
    mi: Number(map.minute),
    s: Number(map.second),
  };
}

function offsetMin(ms: number): number {
  const w = wallClock(ms);
  return Math.round((Date.UTC(w.y, w.m - 1, w.d, w.h, w.mi, w.s) - ms) / MIN_MS);
}

/** Toronto wall clock (date + minutes of day) to an instant, DST-safe. */
function torontoInstantMs(y: number, m: number, d: number, minuteOfDay: number): number {
  const naive = Date.UTC(y, m - 1, d, 0, minuteOfDay, 0);
  let off = offsetMin(naive);
  let inst = naive - off * MIN_MS;
  const off2 = offsetMin(inst);
  if (off2 !== off) {
    off = off2;
    inst = naive - off * MIN_MS;
  }
  return inst;
}

function parseDateKey(dateKey: string): { y: number; m: number; d: number } {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateKey);
  if (!match) throw new RangeError(`Invalid dateKey: ${dateKey}`);
  return { y: Number(match[1]), m: Number(match[2]), d: Number(match[3]) };
}

function keyFromUtcMs(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** Add `days` calendar days to a `YYYY-MM-DD` key (pure calendar math). */
function addDays(dateKey: string, days: number): string {
  const { y, m, d } = parseDateKey(dateKey);
  return keyFromUtcMs(Date.UTC(y, m - 1, d) + days * DAY_MS);
}

/**
 * The sleep window of the night that STARTS on `dateKey` (`YYYY-MM-DD`,
 * Toronto): 22:00 that date to 06:30 the next date, as Toronto instants.
 * Throws RangeError on a malformed key.
 */
export function nightWindow(dateKey: string): UsageWindow {
  const { y, m, d } = parseDateKey(dateKey);
  const next = parseDateKey(addDays(dateKey, 1));
  return {
    startMs: torontoInstantMs(y, m, d, SLEEP_START_MIN),
    endMs: torontoInstantMs(next.y, next.m, next.d, SLEEP_END_MIN),
  };
}

/**
 * Sleep score = clamp(round(100 - 1.5 * usageMin), 0, 100) (R19.2).
 * NaN or negative usage is treated as "no use" and scores 100; +Infinity
 * scores 0.
 */
export function sleepScore(usageMin: number): number {
  if (Number.isNaN(usageMin) || usageMin <= 0) return 100;
  const raw = Math.round(100 - 1.5 * usageMin);
  return Math.min(100, Math.max(0, raw));
}

/**
 * Minutes of phone use in the window: sum of foreground time of all records
 * except the excluded packages, rounded to whole minutes. Non-finite or
 * negative durations are ignored.
 */
export function sleepUsageMin(records: readonly AppUsageRecord[]): number {
  let ms = 0;
  for (const r of records) {
    if (SLEEP_EXCLUDED_PACKAGES.includes(r.packageName)) continue;
    if (Number.isFinite(r.foregroundTimeMs) && r.foregroundTimeMs > 0) {
      ms += r.foregroundTimeMs;
    }
  }
  return Math.round(ms / MIN_MS);
}

// --- Health-aware scoring (R25) ---------------------------------------------------

/** A night's session must start no earlier than 18:00 Toronto of its date (R25.2). */
export const HEALTH_SESSION_EARLIEST_START_MIN = 18 * 60;
/** ... and before 04:00 Toronto of the next date (R25.2). */
export const HEALTH_SESSION_LATEST_START_MIN = 4 * 60;
/** ... and must last at least 3 hours (R25.2). */
export const HEALTH_SESSION_MIN_LENGTH_MS = 3 * 3_600_000;
/** Asleep time that earns the full duration score (8 h). */
export const HEALTH_TARGET_ASLEEP_MIN = 480;
/** Read window end: 12:00 Toronto of the next date. */
const HEALTH_READ_END_MIN = 12 * 60;

/**
 * The window to read health sessions for the night that starts on `dateKey`:
 * 18:00 that date (Toronto) to 12:00 the next date, as instants. Wider than
 * the allowed start range so a long session that starts at 03:59 is included.
 */
export function healthReadWindow(dateKey: string): UsageWindow {
  const { y, m, d } = parseDateKey(dateKey);
  const next = parseDateKey(addDays(dateKey, 1));
  return {
    startMs: torontoInstantMs(y, m, d, HEALTH_SESSION_EARLIEST_START_MIN),
    endMs: torontoInstantMs(next.y, next.m, next.d, HEALTH_READ_END_MIN),
  };
}

/**
 * The night's session: the one with the most asleep minutes among sessions
 * that start in [18:00 Toronto of `dateKey`, 04:00 Toronto of the next date]
 * and last at least 3 hours (end - start). Ties go to the earlier session.
 * Returns `undefined` when none qualifies. Throws RangeError on a bad key.
 */
export function selectNightSession<
  S extends { startMs: number; endMs: number; asleepMin: number },
>(dateKey: string, sessions: readonly S[]): S | undefined {
  const { y, m, d } = parseDateKey(dateKey);
  const next = parseDateKey(addDays(dateKey, 1));
  const from = torontoInstantMs(y, m, d, HEALTH_SESSION_EARLIEST_START_MIN);
  const to = torontoInstantMs(next.y, next.m, next.d, HEALTH_SESSION_LATEST_START_MIN);
  let best: S | undefined;
  for (const s of sessions) {
    if (!(s.startMs >= from && s.startMs <= to)) continue;
    if (!(s.endMs - s.startMs >= HEALTH_SESSION_MIN_LENGTH_MS)) continue;
    if (!Number.isFinite(s.asleepMin)) continue;
    if (!best || s.asleepMin > best.asleepMin || (s.asleepMin === best.asleepMin && s.startMs < best.startMs)) {
      best = s;
    }
  }
  return best;
}

/**
 * Health-based sleep score (R25.3):
 * clamp(round(100 * min(asleepMin, 480) / 480) - round(1.5 * phoneMin), 0, 100).
 * Negative or NaN inputs count as 0.
 */
export function healthSleepScore(input: { asleepMin: number; phoneMin: number }): number {
  const asleep = Number.isFinite(input.asleepMin) && input.asleepMin > 0 ? input.asleepMin : 0;
  const phone = Number.isFinite(input.phoneMin) && input.phoneMin > 0 ? input.phoneMin : 0;
  const base = Math.round((100 * Math.min(asleep, HEALTH_TARGET_ASLEEP_MIN)) / HEALTH_TARGET_ASLEEP_MIN);
  return Math.min(100, Math.max(0, base - Math.round(1.5 * phone)));
}

/**
 * Date keys of the most recent `count` nights whose window has ended
 * (`endMs <= nowMs`), newest first.
 */
export function nightsEndedBefore(nowMs: number, count: number): string[] {
  const out: string[] = [];
  if (!(count > 0)) return out;
  const w = wallClock(nowMs);
  let key = addDays(
    `${String(w.y).padStart(4, "0")}-${String(w.m).padStart(2, "0")}-${String(w.d).padStart(2, "0")}`,
    -1,
  );
  // Last night ends at 06:30 today; if that is still in the future, go back.
  if (nightWindow(key).endMs > nowMs) key = addDays(key, -1);
  for (let i = 0; i < count; i++) {
    out.push(key);
    key = addDays(key, -1);
  }
  return out;
}
