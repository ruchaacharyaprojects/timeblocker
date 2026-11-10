/**
 * Fixed life constraints (R3), encoded as pure functions over a week.
 *
 * Each rule produces either "busy" intervals (time that must be subtracted
 * from schedulable windows) or the schedulable windows themselves. All times
 * are reasoned about in America/Toronto wall-clock and emitted as epoch-ms
 * intervals so the rest of the engine can do plain interval arithmetic.
 *
 * Rule reference:
 *   R3.1  Work Mon-Fri 8:30-16:30 (blocks only in meeting-free time).
 *   R3.2  Canadian statutory holidays => day off, no work window.
 *   R3.3  Commute Tue/Thu/Fri 8:00-8:30 and 16:30-17:00; Mon/Wed remote.
 *   R3.4  Sleep 22:00-06:30 daily; wake time 06:30.
 *   R3.5  Wake-up 06:30-06:50; weekday blocks start no earlier than 06:50.
 *   R3.6  Dinner 18:00-19:00 daily.
 *   R3.7  Scheduling windows: weekdays 06:50-22:00, weekends 10:00-21:00.
 *   R3.8  Gaps shorter than 15 min are unusable.
 *   R3.9  At most one workout per day (short power walks exempt).
 *   R3.10 Morning routine: ~20-min walk ~06:50, no reading first thing,
 *         20+ min freshen up before gym, 30-40 min to get ready for work.
 *   R3.11 >= 30 min screen-free self-care wind-down before bed.
 *   R3.12 Friday night: no heavy work; lean to self-care/chill.
 */

import {
  torontoInstant,
  torontoWeekday,
  type Weekday,
} from "./timezone.js";
import type { Constraints } from "./types.js";
import type { MsInterval } from "./intervals.js";

export const MIN_GAP_MIN = 15; // R3.8
export const WIND_DOWN_MIN = 30; // R3.11
export const MORNING_WALK_MIN = 20; // R3.10

/** Weekday scheduling window (R3.7): 06:50-22:00. */
export const WEEKDAY_WINDOW = { startMin: 6 * 60 + 50, endMin: 22 * 60 };
/** Weekend scheduling window (R3.7): 10:00-21:00. */
export const WEEKEND_WINDOW = { startMin: 10 * 60, endMin: 21 * 60 };

const WORK_START_MIN = 8 * 60 + 30; // 08:30 (R3.1)
const WORK_END_MIN = 16 * 60 + 30; // 16:30 (R3.1)
const DINNER_START_MIN = 18 * 60; // 18:00 (R3.6)
const DINNER_END_MIN = 19 * 60; // 19:00 (R3.6)
const SLEEP_START_MIN = 22 * 60; // 22:00 (R3.4)
const WAKE_MIN = 6 * 60 + 30; // 06:30 (R3.4/R3.5)
const WAKE_UP_END_MIN = 6 * 60 + 50; // 06:50 (R3.5)

/** Commute days (R3.3): Tue(2), Thu(4), Fri(5). */
export const COMMUTE_DAYS: ReadonlySet<Weekday> = new Set<Weekday>([2, 4, 5]);

/** A single Toronto calendar day within the planning week. */
export interface DayInfo {
  /** Midnight (00:00) of the day, Toronto. */
  year: number;
  month: number;
  day: number;
  weekday: Weekday;
  isHoliday: boolean;
  isWeekend: boolean;
  isFriday: boolean;
}

function minuteInstant(d: DayInfo, minuteOfDay: number): number {
  const hour = Math.floor(minuteOfDay / 60);
  const minute = minuteOfDay % 60;
  return torontoInstant(d.year, d.month, d.day, hour, minute).getTime();
}

/**
 * Enumerate the seven Toronto days of the week starting at `sunday`.
 * `sunday` and `saturday` are the week bounds (epoch ms).
 */
export function daysOfWeek(
  sunday: number,
  constraints: Constraints,
): DayInfo[] {
  const holidays = new Set(constraints.holidays);
  const days: DayInfo[] = [];
  let cursor = sunday;
  for (let i = 0; i < 7; i++) {
    const inst = new Date(cursor);
    const wc = {
      year: Number(
        new Intl.DateTimeFormat("en-CA", {
          timeZone: "America/Toronto",
          year: "numeric",
        }).format(inst),
      ),
    };
    // Derive y/m/d via the dateKey to avoid drift across DST.
    const key = torontoDateKeyLocal(inst);
    const [y, m, dd] = key.split("-").map(Number);
    const weekday = torontoWeekday(inst);
    days.push({
      year: y,
      month: m,
      day: dd,
      weekday,
      isHoliday: holidays.has(key),
      isWeekend: weekday === 0 || weekday === 6,
      isFriday: weekday === 5,
    });
    void wc;
    // Advance ~24h then snap to next day's midnight to stay DST-safe.
    const nextApprox = new Date(cursor + 25 * 60 * 60 * 1000);
    const nk = torontoDateKeyLocal(nextApprox);
    const [ny, nm, nd] = nk.split("-").map(Number);
    cursor = torontoInstant(ny, nm, nd, 0, 0).getTime();
  }
  return days;
}

function torontoDateKeyLocal(inst: Date): string {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Toronto",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  // en-CA yields YYYY-MM-DD.
  return fmt.format(inst);
}

/** Schedulable windows for the week (R3.7), before subtracting busy time. */
export function schedulableWindows(days: DayInfo[]): MsInterval[] {
  const windows: MsInterval[] = [];
  for (const d of days) {
    if (d.isWeekend) {
      windows.push({
        start: minuteInstant(d, WEEKEND_WINDOW.startMin),
        end: minuteInstant(d, WEEKEND_WINDOW.endMin),
      });
    } else {
      windows.push({
        start: minuteInstant(d, WEEKDAY_WINDOW.startMin),
        end: minuteInstant(d, WEEKDAY_WINDOW.endMin),
      });
    }
  }
  return windows;
}

/**
 * All fixed-constraint busy intervals for the week (R3.1-R3.6, R3.10, R3.11).
 * These are subtracted from the schedulable windows to build free time.
 */
export function constraintBusyIntervals(days: DayInfo[]): MsInterval[] {
  const busy: MsInterval[] = [];
  for (const d of days) {
    // R3.4 sleep: previous night tail (00:00-06:30) and this night
    // (22:00-24:00). The 06:30-06:50 wake-up (R3.5) is folded in by
    // starting weekday windows at 06:50; we also block 00:00-06:50 so no
    // block precedes wake-up.
    busy.push({
      start: minuteInstant(d, 0),
      end: minuteInstant(d, WAKE_UP_END_MIN),
    });
    busy.push({
      start: minuteInstant(d, SLEEP_START_MIN),
      end: minuteInstant(d, 24 * 60),
    });

    // R3.5 wake-up window 06:30-06:50 (already inside 00:00-06:50 block;
    // kept explicit for clarity/testability).
    busy.push({
      start: minuteInstant(d, WAKE_MIN),
      end: minuteInstant(d, WAKE_UP_END_MIN),
    });

    // R3.6 dinner 18:00-19:00 daily.
    busy.push({
      start: minuteInstant(d, DINNER_START_MIN),
      end: minuteInstant(d, DINNER_END_MIN),
    });

    // R3.11 wind-down: last 30 min before sleep (21:30-22:00) is
    // screen-free self-care, not schedulable for other blocks.
    busy.push({
      start: minuteInstant(d, SLEEP_START_MIN - WIND_DOWN_MIN),
      end: minuteInstant(d, SLEEP_START_MIN),
    });

    // R3.1 work window Mon-Fri 08:30-16:30 unless holiday (R3.2).
    if (!d.isWeekend && !d.isHoliday) {
      busy.push({
        start: minuteInstant(d, WORK_START_MIN),
        end: minuteInstant(d, WORK_END_MIN),
      });

      // R3.3 commute on Tue/Thu/Fri only: 08:00-08:30 and 16:30-17:00.
      if (COMMUTE_DAYS.has(d.weekday)) {
        busy.push({
          start: minuteInstant(d, 8 * 60),
          end: minuteInstant(d, WORK_START_MIN),
        });
        busy.push({
          start: minuteInstant(d, WORK_END_MIN),
          end: minuteInstant(d, 17 * 60),
        });
      }
    }

    // R3.10 morning routine: reserve a ~20-min walk at 06:50 on every day.
    busy.push({
      start: minuteInstant(d, WAKE_UP_END_MIN),
      end: minuteInstant(d, WAKE_UP_END_MIN + MORNING_WALK_MIN),
    });
  }
  return busy;
}

/** Export the raw minute constants for tests that assert boundaries. */
export const RULE_MINUTES = {
  WORK_START_MIN,
  WORK_END_MIN,
  DINNER_START_MIN,
  DINNER_END_MIN,
  SLEEP_START_MIN,
  WAKE_MIN,
  WAKE_UP_END_MIN,
} as const;
