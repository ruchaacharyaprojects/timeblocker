/**
 * TimeBlocker scheduling engine — pure, deterministic, no network or I/O.
 *
 * Public surface (per design.md):
 *   weekBounds(date)                               -> Week
 *   freeWindows(week, busyEvents, constraints, now) -> FreeWindow[]
 *   place(items, freeWindows, mode)                -> PlacementResult
 *   reschedule(block, week, busy, constraints, options?) -> Slot | "no-fit"
 */

import {
  torontoInstant,
  torontoWeekday,
  torontoDateKey,
  torontoMinutesOfDay,
} from "./timezone.js";
import {
  normalize,
  subtract,
  clamp,
  durationMin,
  type MsInterval,
} from "./intervals.js";
import {
  daysOfWeek,
  schedulableWindows,
  constraintBusyIntervals,
  MIN_GAP_MIN,
} from "./constraints.js";
import {
  NO_FIT,
  type Week,
  type FreeWindow,
  type BusyEvent,
  type Constraints,
  type Item,
  type PlanningMode,
  type PlacementResult,
  type PlacedItem,
  type UnplacedItem,
  type Slot,
  type Block,
  type NoFit,
  type RescheduleOptions,
} from "./types.js";

/** Friday-night cutoff for heavy work (R3.12): nothing heavy after 17:00. */
const FRIDAY_HEAVY_WORK_CUTOFF_MIN = 17 * 60;

// ---------------------------------------------------------------------------
// weekBounds
// ---------------------------------------------------------------------------

/**
 * Return the Sunday-Saturday bounds (America/Toronto) for the week that
 * contains `date`. `sunday` is 00:00 of that week's Sunday; `saturday` is
 * 00:00 of the following Sunday (exclusive end of Saturday night). R6.2/R6.3
 * rescheduling never crosses these bounds.
 */
export function weekBounds(date: Date | string): Week {
  const instant = typeof date === "string" ? new Date(date) : date;
  const key = torontoDateKey(instant);
  const [y, m, d] = key.split("-").map(Number);
  const midnight = torontoInstant(y, m, d, 0, 0);
  const weekday = torontoWeekday(midnight); // 0 = Sunday

  // Walk back to Sunday midnight (DST-safe by snapping each step).
  let sundayInstant = midnight;
  for (let i = 0; i < weekday; i++) {
    const prevApprox = new Date(sundayInstant.getTime() - 23 * 60 * 60 * 1000);
    const pk = torontoDateKey(prevApprox);
    const [py, pm, pd] = pk.split("-").map(Number);
    sundayInstant = torontoInstant(py, pm, pd, 0, 0);
  }

  // Following Sunday midnight = exclusive end of the week.
  let endInstant = sundayInstant;
  for (let i = 0; i < 7; i++) {
    const nextApprox = new Date(endInstant.getTime() + 25 * 60 * 60 * 1000);
    const nk = torontoDateKey(nextApprox);
    const [ny, nm, nd] = nk.split("-").map(Number);
    endInstant = torontoInstant(ny, nm, nd, 0, 0);
  }

  return {
    sunday: sundayInstant.toISOString(),
    saturday: endInstant.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// freeWindows
// ---------------------------------------------------------------------------

function toMs(i: { start: string; end: string }): MsInterval {
  return { start: new Date(i.start).getTime(), end: new Date(i.end).getTime() };
}

/**
 * Build free windows for the week by taking the R3.7 schedulable windows and
 * subtracting the fixed constraints (R3.1-R3.6, R3.10, R3.11), the real
 * calendar events, and any time before `now`. Gaps shorter than 15 minutes
 * are dropped (R3.8).
 */
export function freeWindows(
  week: Week,
  busyEvents: BusyEvent[],
  constraints: Constraints,
  now?: Date | string,
): FreeWindow[] {
  const sundayMs = new Date(week.sunday).getTime();
  const saturdayMs = new Date(week.saturday).getTime();
  const days = daysOfWeek(sundayMs, constraints);

  const windows = clamp(schedulableWindows(days), sundayMs, saturdayMs);

  const holes: MsInterval[] = [
    ...constraintBusyIntervals(days),
    ...busyEvents.map(toMs),
  ];

  // Everything before `now` is unavailable.
  if (now !== undefined) {
    const nowMs = typeof now === "string" ? new Date(now).getTime() : now.getTime();
    holes.push({ start: sundayMs, end: nowMs });
  }

  let free = subtract(windows, holes);
  // R3.8: drop gaps shorter than 15 minutes.
  free = free.filter((f) => durationMin(f) >= MIN_GAP_MIN);

  return free.map((f) => ({
    start: new Date(f.start).toISOString(),
    end: new Date(f.end).toISOString(),
  }));
}

// ---------------------------------------------------------------------------
// place
// ---------------------------------------------------------------------------

function isWorkout(item: Item): boolean {
  return item.category === "fitness";
}

/** Heuristic for "heavy work" (R3.12): long work blocks on Friday night. */
function isHeavyWork(item: Item): boolean {
  return item.category === "work";
}

interface MutableWindow {
  start: number;
  end: number;
}

/**
 * Decide whether `item` of `duration` may start at `startMs`, given the
 * workouts already placed per day and the Friday-night rule.
 */
function allowedAt(
  item: Item,
  startMs: number,
  workoutDays: Set<string>,
): boolean {
  const start = new Date(startMs);

  // R3.9: at most one workout per day.
  if (isWorkout(item)) {
    const key = torontoDateKey(start);
    if (workoutDays.has(key)) return false;
  }

  // R3.12: no heavy work on Friday night.
  if (isHeavyWork(item) && torontoWeekday(start) === 5) {
    if (torontoMinutesOfDay(start) >= FRIDAY_HEAVY_WORK_CUTOFF_MIN) {
      return false;
    }
  }

  return true;
}

/**
 * Optional learned-placement hook (R23). When `score` returns a number for an
 * item, candidate starts are enumerated on a 15-minute grid and the best score
 * wins; when it returns `undefined` (or is absent) placement is unchanged.
 */
export interface PlaceOptions {
  score?: (item: Item, startMs: number) => number | undefined;
}

/** Candidate-start grid for scored placement. */
const SCORE_GRID_MS = MIN_GAP_MIN * 60000;

/**
 * Priority-first greedy placement into the given free windows.
 *
 * - Items are sorted by priority (1 = highest), ties broken by longer
 *   duration first then id for determinism.
 * - "earliest-fit" packs each item into the earliest window where it fits.
 * - "spread" distributes items across distinct days before reusing a day,
 *   preferring the earliest window on the least-used day.
 *
 * Enforces one-workout-per-day (R3.9) and the Friday-night rule (R3.12).
 * Items that fit nowhere are returned as `unplaced` (R2.3); the engine never
 * forces a block.
 */
export function place(
  items: Item[],
  freeWindows: FreeWindow[],
  mode: PlanningMode,
  options?: PlaceOptions,
): PlacementResult {
  const windows: MutableWindow[] = normalize(freeWindows.map(toMs)).map((w) => ({
    start: w.start,
    end: w.end,
  }));

  const byPriority = (a: Item, b: Item): number => {
    if (a.priority !== b.priority) return a.priority - b.priority;
    if (a.durationMin !== b.durationMin) return b.durationMin - a.durationMin;
    return a.id.localeCompare(b.id);
  };

  // R28: fixed-start items first (in start order), then deadline items
  // (earliest deadline first, then the usual tie-breaks), then the rest.
  const fixed = items
    .filter(hasFixedStart)
    .sort((a, b) => a.fixedStartMs! - b.fixedStartMs! || a.id.localeCompare(b.id));
  const sorted = items
    .filter((i) => !hasFixedStart(i))
    .sort((a, b) => {
      const da = hasDeadline(a);
      const db = hasDeadline(b);
      if (da !== db) return da ? -1 : 1;
      if (da && db && a.latestEndMs !== b.latestEndMs) {
        return a.latestEndMs! - b.latestEndMs!;
      }
      return byPriority(a, b);
    });

  const placed: PlacedItem[] = [];
  const unplaced: UnplacedItem[] = [];
  const workoutDays = new Set<string>();
  const dayUsage = new Map<string, number>(); // for spread mode
  const groupDays = new Map<string, Set<string>>(); // group -> days used

  const commit = (
    item: Item,
    windowIndex: number,
    startMs: number,
    endMs: number,
  ): void => {
    placed.push({
      item,
      slot: {
        start: new Date(startMs).toISOString(),
        end: new Date(endMs).toISOString(),
      },
    });
    const dayKey = torontoDateKey(new Date(startMs));
    if (isWorkout(item)) workoutDays.add(dayKey);
    dayUsage.set(dayKey, (dayUsage.get(dayKey) ?? 0) + 1);
    if (item.group !== undefined) {
      const days = groupDays.get(item.group) ?? new Set<string>();
      days.add(dayKey);
      groupDays.set(item.group, days);
    }
    // Consume the used portion of the window, keeping any left/right remainder
    // that is still at least the minimum usable gap.
    consumeWindow(windows, windowIndex, startMs, endMs);
  };

  for (const item of fixed) {
    const startMs = item.fixedStartMs!;
    const endMs = startMs + item.durationMin * 60000;
    const idx = windows.findIndex((w) => w.start <= startMs && endMs <= w.end);
    if (idx < 0 || !allowedAt(item, startMs, workoutDays)) {
      unplaced.push({ ...item, reason: "clash" });
      continue;
    }
    commit(item, idx, startMs, endMs);
  }

  for (const item of sorted) {
    const durMs = item.durationMin * 60000;
    const candidate = findSlot(
      item,
      durMs,
      windows,
      mode,
      workoutDays,
      dayUsage,
      groupDays,
      options?.score,
    );

    if (!candidate) {
      // Plain items stay exactly as given (absent reason = "no-fit").
      if (hasDeadline(item)) {
        unplaced.push({ ...item, reason: "no-time-before-deadline" });
      } else if (hasEarliest(item)) {
        unplaced.push({ ...item, reason: "no-fit" });
      } else {
        unplaced.push(item);
      }
      continue;
    }

    commit(item, candidate.windowIndex, candidate.startMs, candidate.startMs + durMs);
  }

  return { placed, unplaced };
}

function hasFixedStart(i: Item): boolean {
  return i.fixedStartMs !== undefined && Number.isFinite(i.fixedStartMs);
}
function hasDeadline(i: Item): boolean {
  return i.latestEndMs !== undefined && Number.isFinite(i.latestEndMs);
}
function hasEarliest(i: Item): boolean {
  return i.earliestMs !== undefined && Number.isFinite(i.earliestMs);
}

/** The part of `w` an item may use: clipped to [earliestMs, latestEndMs]. */
function clipFor(item: Item, w: MutableWindow): MutableWindow {
  return {
    start: hasEarliest(item) ? Math.max(w.start, item.earliestMs!) : w.start,
    end: hasDeadline(item) ? Math.min(w.end, item.latestEndMs!) : w.end,
  };
}

interface Candidate {
  windowIndex: number;
  startMs: number;
}

function findSlot(
  item: Item,
  durMs: number,
  windows: MutableWindow[],
  mode: PlanningMode,
  workoutDays: Set<string>,
  dayUsage: Map<string, number>,
  groupDays: Map<string, Set<string>>,
  score?: (item: Item, startMs: number) => number | undefined,
): Candidate | null {
  // Build an ordered list of window indices to try.
  const order = windows.map((_, idx) => idx);

  // R28.5: deadline items take the earliest suitable time, whatever the mode.
  if (mode === "spread" && !hasDeadline(item)) {
    order.sort((a, b) => {
      const wa = windows[a];
      const wb = windows[b];
      const ua = dayUsage.get(torontoDateKey(new Date(wa.start))) ?? 0;
      const ub = dayUsage.get(torontoDateKey(new Date(wb.start))) ?? 0;
      if (ua !== ub) return ua - ub; // least-used day first
      return wa.start - wb.start; // then earliest
    });
  } else {
    order.sort((a, b) => windows[a].start - windows[b].start);
  }

  // R20.5: soft preference. Windows on days where no item of the same group
  // is placed yet come first; the mode ordering is kept within each class.
  let tryOrder = order;
  if (item.group !== undefined) {
    const used = groupDays.get(item.group);
    if (used && used.size > 0) {
      const fresh: number[] = [];
      const taken: number[] = [];
      for (const idx of order) {
        const key = torontoDateKey(new Date(windows[idx].start));
        (used.has(key) ? taken : fresh).push(idx);
      }
      tryOrder = [...fresh, ...taken];
    }
  }

  // R23: learned placement. Only when the score is defined for this item.
  if (score && score(item, 0) !== undefined) {
    return findScoredSlot(item, durMs, windows, tryOrder, workoutDays, groupDays, score);
  }

  for (const idx of tryOrder) {
    const w = clipFor(item, windows[idx]);
    if (w.end - w.start < durMs) continue;
    // Try to start at the (clipped) window's start; constraints are time-of-day
    // based so if the earliest start is disallowed, the whole window is for this
    // item (workout/Friday rules do not change within a window's day).
    const startMs = w.start;
    if (startMs + durMs > w.end) continue;
    if (!allowedAt(item, startMs, workoutDays)) continue;
    return { windowIndex: idx, startMs };
  }
  return null;
}

/**
 * Best-scoring feasible start on a 15-minute grid anchored at each window's
 * start (the window start itself is always a candidate). Windows on days the
 * group has not used are considered first; the taken-day windows only when no
 * fresh candidate exists. Ties: no stranded (<15 min) remainder, then the
 * candidate the unscored algorithm would reach first (mode order, earliest).
 */
function findScoredSlot(
  item: Item,
  durMs: number,
  windows: MutableWindow[],
  tryOrder: number[],
  workoutDays: Set<string>,
  groupDays: Map<string, Set<string>>,
  score: (item: Item, startMs: number) => number | undefined,
): Candidate | null {
  const used = item.group !== undefined ? groupDays.get(item.group) : undefined;
  const classes: number[][] =
    used && used.size > 0
      ? [
          tryOrder.filter((i) => !used.has(torontoDateKey(new Date(windows[i].start)))),
          tryOrder.filter((i) => used.has(torontoDateKey(new Date(windows[i].start)))),
        ]
      : [tryOrder];
  const minRem = MIN_GAP_MIN * 60000;
  const stranded = (w: MutableWindow, s: number): boolean => {
    const left = s - w.start;
    const right = w.end - (s + durMs);
    return (left > 0 && left < minRem) || (right > 0 && right < minRem);
  };

  for (const cls of classes) {
    let best: { idx: number; startMs: number; score: number; stranded: boolean } | null = null;
    for (const idx of cls) {
      const w = windows[idx];
      const eff = clipFor(item, w);
      for (let s = eff.start; s + durMs <= eff.end; s += SCORE_GRID_MS) {
        if (!allowedAt(item, s, workoutDays)) continue;
        // An undefined/NaN score at a feasible start ranks last, never excludes it.
        const raw = score(item, s);
        const sc = raw === undefined || Number.isNaN(raw) ? -Infinity : raw;
        const st = stranded(w, s);
        if (
          best === null ||
          sc > best.score ||
          (sc === best.score && best.stranded && !st)
        ) {
          best = { idx, startMs: s, score: sc, stranded: st };
        }
      }
    }
    if (best) return { windowIndex: best.idx, startMs: best.startMs };
  }
  return null;
}

/** Remove [usedStart, usedEnd) from windows[idx], preserving usable remainders. */
function consumeWindow(
  windows: MutableWindow[],
  idx: number,
  usedStart: number,
  usedEnd: number,
): void {
  const w = windows[idx];
  const remainders: MutableWindow[] = [];
  if (usedStart - w.start >= MIN_GAP_MIN * 60000) {
    remainders.push({ start: w.start, end: usedStart });
  }
  if (w.end - usedEnd >= MIN_GAP_MIN * 60000) {
    remainders.push({ start: usedEnd, end: w.end });
  }
  windows.splice(idx, 1, ...remainders);
}

// ---------------------------------------------------------------------------
// reschedule
// ---------------------------------------------------------------------------

/**
 * Find the next valid slot for `block` within the same Sunday-Saturday week
 * (R6.2), after the block's current start. Returns the slot or "no-fit"
 * (R6.3) when nothing in the week can hold it. Pure: never mutates inputs.
 *
 * `options.notBefore` (ISO instant) moves the search start to
 * max(block.start, notBefore), so a block that has already started is never
 * moved into the past. Omitting it keeps the original behavior exactly.
 */
export function reschedule(
  block: Block,
  week: Week,
  busy: BusyEvent[],
  constraints: Constraints,
  options?: RescheduleOptions,
): Slot | NoFit {
  const durationMs =
    (block.durationMin ?? Math.round((new Date(block.end).getTime() - new Date(block.start).getTime()) / 60000)) *
    60000;

  // The block's own current time must not block its new slot, but any other
  // real event should. Treat the moment just after the current start as the
  // earliest candidate so we always move forward in time.
  let afterMs = new Date(block.start).getTime() + 1;
  if (options?.notBefore !== undefined) {
    const notBeforeMs = new Date(options.notBefore).getTime();
    if (Number.isFinite(notBeforeMs)) afterMs = Math.max(afterMs, notBeforeMs);
  }

  // Exclude the block itself from busy if it appears there by id.
  const otherBusy = busy.filter((e) => e.id === undefined || e.id !== block.id);

  const free = freeWindows(week, otherBusy, constraints, new Date(afterMs));

  const item: Item = {
    id: block.itemId,
    text: "",
    durationMin: durationMs / 60000,
    priority: 1,
    category: block.category,
  };

  const workoutDays = new Set<string>();
  for (const w of free) {
    const startMs = new Date(w.start).getTime();
    const endMs = new Date(w.end).getTime();
    if (endMs - startMs < durationMs) continue;
    if (!allowedAt(item, startMs, workoutDays)) continue;
    return {
      start: new Date(startMs).toISOString(),
      end: new Date(startMs + durationMs).toISOString(),
    };
  }

  return NO_FIT;
}
