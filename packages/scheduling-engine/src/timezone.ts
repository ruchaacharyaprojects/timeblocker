/**
 * America/Toronto timezone utilities.
 *
 * All scheduling in TimeBlocker is computed in America/Toronto, never the
 * device timezone. These helpers convert between absolute instants (epoch
 * milliseconds) and Toronto wall-clock components, correctly handling
 * daylight saving time via the Intl API. The module is pure: no network,
 * no I/O, no mutable global state.
 */

export const TORONTO_TZ = "America/Toronto" as const;

export interface WallClock {
  year: number;
  /** 1-12 */
  month: number;
  /** 1-31 */
  day: number;
  /** 0-23 */
  hour: number;
  /** 0-59 */
  minute: number;
  /** 0-59 */
  second: number;
}

/** Day of week in Toronto, 0 = Sunday ... 6 = Saturday. */
export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6;

const partsFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: TORONTO_TZ,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
  weekday: "short",
});

const WEEKDAY_INDEX: Record<string, Weekday> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

/** Convert an absolute instant to Toronto wall-clock components. */
export function toTorontoWallClock(instant: Date): WallClock {
  const parts = partsFormatter.formatToParts(instant);
  const map: Record<string, string> = {};
  for (const p of parts) {
    if (p.type !== "literal") map[p.type] = p.value;
  }
  let hour = Number(map.hour);
  // Intl with hour12:false can emit "24" for midnight on some engines.
  if (hour === 24) hour = 0;
  return {
    year: Number(map.year),
    month: Number(map.month),
    day: Number(map.day),
    hour,
    minute: Number(map.minute),
    second: Number(map.second),
  };
}

/** Toronto day-of-week for an instant (0 = Sunday). */
export function torontoWeekday(instant: Date): Weekday {
  const parts = partsFormatter.formatToParts(instant);
  const wd = parts.find((p) => p.type === "weekday")?.value ?? "Sun";
  return WEEKDAY_INDEX[wd] ?? 0;
}

/**
 * The timezone offset (in minutes, e.g. -300 for EST, -240 for EDT) that
 * America/Toronto has at the given absolute instant.
 */
function torontoOffsetMinutes(instant: Date): number {
  const wc = toTorontoWallClock(instant);
  // Interpret the wall-clock components as if they were UTC, then compare
  // to the real instant to recover the offset.
  const asUtc = Date.UTC(
    wc.year,
    wc.month - 1,
    wc.day,
    wc.hour,
    wc.minute,
    wc.second,
  );
  return Math.round((asUtc - instant.getTime()) / 60000);
}

/**
 * Convert Toronto wall-clock components to an absolute instant.
 *
 * Handles DST by computing the offset at the candidate instant and
 * correcting once (two iterations are sufficient for a single one-hour
 * DST transition). For the ambiguous/invalid hour at a transition this
 * resolves deterministically, which is acceptable because scheduling never
 * places blocks during the 2-3 AM transition window (sleep is protected).
 */
export function torontoWallClockToInstant(
  wc: Omit<WallClock, "second"> & { second?: number },
): Date {
  const second = wc.second ?? 0;
  const naiveUtc = Date.UTC(
    wc.year,
    wc.month - 1,
    wc.day,
    wc.hour,
    wc.minute,
    second,
  );
  // First guess: assume UTC equals wall clock, find the offset there.
  let offset = torontoOffsetMinutes(new Date(naiveUtc));
  let instant = naiveUtc - offset * 60000;
  // Re-check the offset at the corrected instant and adjust once more.
  const offset2 = torontoOffsetMinutes(new Date(instant));
  if (offset2 !== offset) {
    offset = offset2;
    instant = naiveUtc - offset * 60000;
  }
  return new Date(instant);
}

/** Build a Toronto instant from date + time-of-day parts. */
export function torontoInstant(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second = 0,
): Date {
  return torontoWallClockToInstant({ year, month, day, hour, minute, second });
}

/** Minutes since Toronto midnight for an instant (0-1439). */
export function torontoMinutesOfDay(instant: Date): number {
  const wc = toTorontoWallClock(instant);
  return wc.hour * 60 + wc.minute;
}

/** `YYYY-MM-DD` string in Toronto for an instant. */
export function torontoDateKey(instant: Date): string {
  const wc = toTorontoWallClock(instant);
  const mm = String(wc.month).padStart(2, "0");
  const dd = String(wc.day).padStart(2, "0");
  return `${wc.year}-${mm}-${dd}`;
}
