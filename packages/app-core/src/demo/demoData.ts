/**
 * Deterministic demo data generators (R24). Pure: no I/O, no clock reads, no
 * `Math.random`. Every generator draws from a seeded mulberry32 PRNG whose
 * seed derives from a stable key (week id or night date), so the same input
 * always yields the same output and a given week or night looks the same no
 * matter when it is generated.
 */
import {
  torontoDateKey,
  torontoInstant,
  torontoMinutesOfDay,
  type Category,
} from "@timeblocker/scheduling-engine";
import {
  healthSleepScore,
  nightsEndedBefore,
  sleepUsageMin,
  type AppUsageRecord,
  type UsageWindow,
} from "@timeblocker/usage-metrics";
import type { DeviceBlock, DeviceBlockStatus, SleepScore } from "../models.js";
import { weekIdAt } from "../notifications/service.js";
import { BASE32HEX_ALPHABET, type SleepSession } from "../ports.js";
import { shiftWeekId } from "../services/history.js";

/** Id prefix of every demo block (R24.2, R24.5). */
export const DEMO_ID_PREFIX = "demo-";

/** Common distraction apps added to settings when none are set (R24.2). */
export const DEMO_DISTRACTION_APPS: readonly string[] = [
  "com.instagram.android",
  "com.google.android.youtube",
  "com.zhiliaoapp.musically",
];

const MIN_MS = 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

// --- PRNG ---------------------------------------------------------------------------

/** mulberry32: small, fast, seedable PRNG returning floats in [0, 1). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** FNV-1a hash of a string to a 32-bit unsigned integer. */
function hashString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Fixed base seed; mixed with a per-week or per-night key. */
const DEMO_SEED = 0x7b10c4;

const seeded = (key: string) => mulberry32((hashString(key) ^ DEMO_SEED) >>> 0);

type Rng = () => number;
const chance = (rng: Rng, p: number) => rng() < p;
const pick = <T>(rng: Rng, items: readonly T[]): T => items[Math.floor(rng() * items.length)]!;
/** Integer in [lo, hi] on a grid of `step`. */
function onGrid(rng: Rng, lo: number, hi: number, step: number): number {
  const n = Math.floor((hi - lo) / step) + 1;
  return lo + Math.floor(rng() * Math.max(1, n)) * step;
}

// --- Dates -----------------------------------------------------------------------------

function parseKey(key: string): { y: number; m: number; d: number } {
  const [y, m, d] = key.split("-").map(Number) as [number, number, number];
  return { y, m, d };
}

function addDays(key: string, days: number): string {
  const { y, m, d } = parseKey(key);
  return new Date(Date.UTC(y, m - 1, d) + days * DAY_MS).toISOString().slice(0, 10);
}

/** Instant of a Toronto date plus minutes of day; minutes >= 1440 roll into the next date. */
function instantAt(dateKey: string, minuteOfDay: number): number {
  const key = minuteOfDay >= 1440 ? addDays(dateKey, 1) : dateKey;
  const min = minuteOfDay >= 1440 ? minuteOfDay - 1440 : minuteOfDay;
  const { y, m, d } = parseKey(key);
  return torontoInstant(y, m, d, Math.floor(min / 60), min % 60).getTime();
}

// --- Blocks ------------------------------------------------------------------------------

/** Earliest start and latest end of a demo block (Toronto minutes of day). */
const DAY_START_MIN = 7 * 60;
const DAY_END_MIN = 21 * 60 + 30;
const GAP_MIN = 10;

type Group =
  | "work-am"
  | "work-pm"
  | "work-eve"
  | "fitness-eve"
  | "fitness-am"
  | "selfdev-eve"
  | "selfdev-aft"
  | "self-care"
  | "misc";

interface GroupSpec {
  category: Category;
  /** Start window, Toronto minutes of day (15-minute grid). */
  from: number;
  to: number;
  /** Duration choices, minutes. */
  durMin: number;
  durMax: number;
  titles: readonly string[];
}

const WORK_TITLES = ["Project report", "Email the client", "Review slides", "Budget spreadsheet", "Team prep"];
const SELFDEV_TITLES = ["Study cloud course", "Read a chapter", "Practice coding", "Language lesson"];
const FITNESS_TITLES = ["Gym", "Run", "Swim"];
const SELFCARE_TITLES = ["Meditate", "Meal prep", "Journal"];
const MISC_TITLES = ["Laundry", "Groceries", "Tidy up", "Pay bills"];

const GROUPS: Record<Group, GroupSpec> = {
  "work-am": { category: "work", from: 8 * 60, to: 11 * 60, durMin: 60, durMax: 120, titles: WORK_TITLES },
  "work-pm": { category: "work", from: 13 * 60, to: 15 * 60 + 30, durMin: 60, durMax: 90, titles: WORK_TITLES },
  "work-eve": { category: "work", from: 18 * 60, to: 20 * 60 + 15, durMin: 60, durMax: 90, titles: WORK_TITLES },
  "fitness-eve": { category: "fitness", from: 17 * 60, to: 18 * 60 + 30, durMin: 45, durMax: 45, titles: FITNESS_TITLES },
  "fitness-am": { category: "fitness", from: 9 * 60, to: 11 * 60, durMin: 45, durMax: 45, titles: FITNESS_TITLES },
  "selfdev-eve": { category: "self-development", from: 19 * 60, to: 20 * 60 + 15, durMin: 45, durMax: 90, titles: SELFDEV_TITLES },
  "selfdev-aft": { category: "self-development", from: 13 * 60, to: 15 * 60 + 45, durMin: 45, durMax: 90, titles: SELFDEV_TITLES },
  "self-care": { category: "self-care", from: 7 * 60, to: 16 * 60, durMin: 20, durMax: 30, titles: SELFCARE_TITLES },
  misc: { category: "misc", from: 10 * 60, to: 17 * 60, durMin: 30, durMax: 45, titles: MISC_TITLES },
};

/** Probability a group appears on a weekday (Mon-Fri) or a weekend day. */
const WEEKDAY_PLAN: ReadonlyArray<readonly [Group, number]> = [
  ["fitness-eve", 0.35],
  ["work-am", 1],
  ["work-eve", 0.25],
  ["work-pm", 0.1],
  ["selfdev-eve", 0.3],
  ["selfdev-aft", 0.1],
  ["self-care", 0.2],
  ["misc", 0.15],
];
const WEEKEND_PLAN: ReadonlyArray<readonly [Group, number]> = [
  ["fitness-eve", 0.5],
  ["fitness-am", 0.15],
  ["misc", 0.6],
  ["self-care", 0.3],
  ["selfdev-aft", 0.3],
  ["selfdev-eve", 0.1],
];

/** Fewest and most blocks generated per week. */
export const DEMO_MIN_BLOCKS_PER_WEEK = 12;
export const DEMO_MAX_BLOCKS_PER_WEEK = 16;

/** Groups that may be added to reach the weekly minimum, or dropped to reach the maximum. */
const FILLER_GROUPS: readonly Group[] = ["misc", "self-care", "selfdev-aft"];

interface Planned {
  day: number; // 0 = Sunday
  group: Group;
  startMin: number;
  durMin: number;
  title: string;
}

/** Place a group in a day without overlapping `taken`; shifts through the whole start window. */
function place(
  rng: Rng,
  group: Group,
  taken: ReadonlyArray<{ s: number; e: number }>,
): { startMin: number; durMin: number; title: string } | undefined {
  const spec = GROUPS[group];
  const durMin = onGrid(rng, spec.durMin, spec.durMax, 15) || spec.durMin;
  const slots: number[] = [];
  for (let s = spec.from; s <= spec.to; s += 15) slots.push(s);
  const offset = Math.floor(rng() * slots.length);
  for (let i = 0; i < slots.length; i++) {
    const s = slots[(offset + i) % slots.length]!;
    const e = s + durMin;
    if (s < DAY_START_MIN || e > DAY_END_MIN) continue;
    if (taken.some((t) => s < t.e + GAP_MIN && t.s < e + GAP_MIN)) continue;
    return { startMin: s, durMin, title: pick(rng, spec.titles) };
  }
  return undefined;
}

function planWeek(rng: Rng): Planned[] {
  const planned: Planned[] = [];
  const takenByDay: Array<Array<{ s: number; e: number }>> = Array.from({ length: 7 }, () => []);
  const add = (day: number, group: Group): boolean => {
    const taken = takenByDay[day]!;
    const p = place(rng, group, taken);
    if (!p) return false;
    taken.push({ s: p.startMin, e: p.startMin + p.durMin });
    planned.push({ day, group, ...p });
    return true;
  };

  for (let day = 0; day < 7; day++) {
    const plan = day === 0 || day === 6 ? WEEKEND_PLAN : WEEKDAY_PLAN;
    let fitnessDone = false;
    for (const [group, p] of plan) {
      if (!chance(rng, p)) continue;
      if (group.startsWith("fitness")) {
        if (fitnessDone) continue; // one fitness block per day
        fitnessDone = true;
      }
      add(day, group);
    }
  }

  // Trim down to the maximum by dropping filler blocks, then anything but work/fitness.
  while (planned.length > DEMO_MAX_BLOCKS_PER_WEEK) {
    let pool = planned.filter((p) => FILLER_GROUPS.includes(p.group));
    if (pool.length === 0) pool = planned.filter((p) => p.group !== "work-am" && !p.group.startsWith("fitness"));
    if (pool.length === 0) pool = planned;
    const victim = pick(rng, pool);
    planned.splice(planned.indexOf(victim), 1);
  }
  // Pad up to the minimum with filler blocks on random days.
  for (let tries = 0; planned.length < DEMO_MIN_BLOCKS_PER_WEEK && tries < 200; tries++) {
    add(Math.floor(rng() * 7), pick(rng, FILLER_GROUPS));
  }
  return planned;
}

/** Statuses by time-of-day patterns (R24.2). */
function statusFor(rng: Rng, group: Group): DeviceBlockStatus {
  const roll = rng();
  const generic = (done: number): DeviceBlockStatus => {
    if (roll < done) return "done";
    const rest = (roll - done) / (1 - done); // 0..1 across the non-done share
    if (rest < 0.1) return "partial";
    if (rest < 0.75) return "missed";
    return "skipped";
  };
  switch (group) {
    case "work-am":
      // 85% done, 5% partial, 6% missed, 4% skipped
      return roll < 0.85 ? "done" : roll < 0.9 ? "partial" : roll < 0.96 ? "missed" : "skipped";
    case "work-eve":
      // 25% done, 55% missed, 20% skipped
      return roll < 0.25 ? "done" : roll < 0.8 ? "missed" : "skipped";
    case "work-pm":
      return generic(0.55);
    case "fitness-eve":
      return generic(0.8);
    case "fitness-am":
      return generic(0.3);
    case "selfdev-eve":
      return generic(0.7);
    case "selfdev-aft":
      return generic(0.45);
    default:
      return generic(0.65);
  }
}

function eventId(rng: Rng): string {
  let out = "";
  for (let i = 0; i < 26; i++) out += BASE32HEX_ALPHABET[Math.floor(rng() * 32)]!;
  return out;
}

/** Blocks for one past week, sorted by start. */
function blocksForWeek(weekId: string, nowMs: number): DeviceBlock[] {
  const rng = seeded(`blocks:${weekId}`);
  const planned = planWeek(rng).sort((a, b) => a.day - b.day || a.startMin - b.startMin);
  return planned.map((p, i) => {
    const dateKey = addDays(weekId, p.day);
    const startMs = instantAt(dateKey, p.startMin);
    const endMs = instantAt(dateKey, p.startMin + p.durMin);
    const n = i + 1;
    return {
      id: `${DEMO_ID_PREFIX}${weekId}-${n}`,
      itemId: `demo-item-${weekId}-${n}`,
      start: new Date(startMs).toISOString(),
      end: new Date(endMs).toISOString(),
      category: GROUPS[p.group].category,
      status: statusFor(rng, p.group),
      weekId,
      title: p.title,
      text: p.title,
      calendarEventId: eventId(rng),
      calendarSynced: true,
      promptedMeetingIds: [],
      usagePrompted: false,
      updatedAt: nowMs,
    };
  });
}

/**
 * About 12-16 blocks for each of the `weeks` weeks BEFORE the week containing
 * `nowMs` (never the current week), oldest week first. Completion depends on
 * time of day: work started 08-12 is mostly done, work started in the evening
 * mostly missed, fitness at 17-19 mostly done. Blocks never overlap, sit in
 * 07:00-21:30 Toronto, and there is at most one fitness block per day.
 */
export function generateDemoBlocks(nowMs: number, weeks = 8): DeviceBlock[] {
  const current = weekIdAt(nowMs);
  const out: DeviceBlock[] = [];
  for (let k = Math.max(0, Math.floor(weeks)); k >= 1; k--) {
    out.push(...blocksForWeek(shiftWeekId(current, k), nowMs));
  }
  return out;
}

// --- Usage ---------------------------------------------------------------------------------

/** Night windows start at 20:00 or later, or at 06:59 or earlier (Toronto). */
function isNightStart(startMs: number): boolean {
  const hour = Math.floor(torontoMinutesOfDay(new Date(startMs)) / 60);
  return hour >= 20 || hour <= 6;
}

/** [lo, hi] minutes of use per hour, per app, on a typical waking hour. */
const DAYTIME_RATES: ReadonlyArray<readonly [string, number, number, number]> = [
  // package, min per hour (lo, hi), launches per hour
  ["com.instagram.android", 2, 6, 3],
  ["com.google.android.youtube", 2, 7, 1.5],
  ["com.zhiliaoapp.musically", 1, 5, 2],
  ["com.whatsapp", 1, 3, 4],
  ["com.android.chrome", 1, 4, 2],
  ["com.google.android.apps.maps", 0.2, 1, 0.5],
];

/** Cap `records` so their total never exceeds the window length. */
function capToWindow(records: AppUsageRecord[], lengthMs: number): AppUsageRecord[] {
  const total = records.reduce((s, r) => s + r.foregroundTimeMs, 0);
  if (total <= lengthMs || total === 0) return records;
  const k = lengthMs / total;
  return records.map((r) => ({ ...r, foregroundTimeMs: Math.floor(r.foregroundTimeMs * k) }));
}

/**
 * Synthetic app usage for a window, deterministic from the window start.
 * Night windows (start 20:00-06:59 Toronto) total 0-10 min on most nights and
 * 25-70 min on about one night in four. Daytime windows list distraction and
 * everyday apps scaled to the window length. Never exceeds the window length.
 */
export function demoUsageRecords(window: UsageWindow): AppUsageRecord[] {
  const length = Math.max(0, window.endMs - window.startMs);
  if (length === 0) return [];

  if (isNightStart(window.startMs)) {
    // The night belongs to the date it started on: shift back 6 h so 00:30 maps to the evening before.
    const nightKey = torontoDateKey(new Date(window.startMs - 6 * HOUR_MS));
    const rng = seeded(`usage-night:${nightKey}`);
    const heavy = chance(rng, 0.25);
    const totalMin = heavy ? onGrid(rng, 25, 70, 1) : onGrid(rng, 0, 10, 1);
    if (totalMin === 0) return [];
    const apps = ["com.instagram.android", "com.google.android.youtube", "com.zhiliaoapp.musically", "com.whatsapp"];
    const weights = apps.map(() => rng() + 0.2);
    const sum = weights.reduce((a, b) => a + b, 0);
    const records = apps.map((packageName, i) => ({
      packageName,
      foregroundTimeMs: Math.floor((totalMin * MIN_MS * weights[i]!) / sum),
      launchCount: 1 + Math.floor(rng() * 3),
    }));
    return capToWindow(records, length);
  }

  const rng = seeded(`usage-day:${torontoDateKey(new Date(window.startMs))}`);
  // Heavier days and quieter days; hours scale the totals.
  const dayFactor = 0.7 + rng() * 0.8;
  const hours = length / HOUR_MS;
  const records = DAYTIME_RATES.map(([packageName, lo, hi, launches]) => {
    const perHour = lo + rng() * (hi - lo);
    return {
      packageName,
      foregroundTimeMs: Math.max(1, Math.floor(perHour * dayFactor * hours * MIN_MS)),
      launchCount: Math.max(1, Math.round(launches * hours)),
    };
  });
  return capToWindow(records, length);
}

// --- Sleep -----------------------------------------------------------------------------------

/** A demo night: its date key and Health Connect style session. */
interface DemoNight {
  dateKey: string;
  session: SleepSession;
}

/** The session for the night that starts on `dateKey`. */
function sessionForNight(dateKey: string): SleepSession {
  const rng = seeded(`sleep:${dateKey}`);
  // Bedtime 22:15 to 00:30 (as minutes since the evening's midnight: 1335..1470).
  const bedMin = onGrid(rng, 22 * 60 + 15, 24 * 60 + 30, 5);
  const durationMin = onGrid(rng, 5 * 60 + 45, 8 * 60 + 30, 5);
  const awakeMin = onGrid(rng, 10, 45, 1);
  const startMs = instantAt(dateKey, bedMin);
  return {
    startMs,
    endMs: startMs + durationMin * MIN_MS,
    asleepMin: durationMin - awakeMin,
  };
}

/** Fully ended nights before `nowMs`, oldest first; a night counts only when its session has ended. */
function demoNights(nowMs: number, nights: number): DemoNight[] {
  return nightsEndedBefore(nowMs, nights)
    .map((dateKey) => ({ dateKey, session: sessionForNight(dateKey) }))
    .filter((n) => n.session.endMs <= nowMs)
    .reverse();
}

/**
 * One session per fully ended night for the last `nights` nights, oldest
 * first: bedtime 22:15-00:30, 5h45-8h30 in bed, 10-45 min of it awake.
 */
export function demoSleepSessions(nowMs: number, nights = 14): SleepSession[] {
  return demoNights(nowMs, nights).map((n) => n.session);
}

/**
 * Sleep scores for the last `nights` fully ended nights, computed through the
 * real {@link healthSleepScore} and {@link demoUsageRecords} over each session
 * window, so they match what the live pipeline produces for the same data.
 * Flagged `demo: true`, source `health+usage`.
 */
export function demoSleepScores(nowMs: number, nights = 14): SleepScore[] {
  return demoNights(nowMs, nights).map(({ dateKey, session }) => {
    const phoneMin = sleepUsageMin(demoUsageRecords({ startMs: session.startMs, endMs: session.endMs }));
    return {
      dateKey,
      usageMin: phoneMin,
      asleepMin: session.asleepMin,
      score: healthSleepScore({ asleepMin: session.asleepMin, phoneMin }),
      scoredAt: nowMs,
      source: "health+usage" as const,
      demo: true,
    };
  });
}
