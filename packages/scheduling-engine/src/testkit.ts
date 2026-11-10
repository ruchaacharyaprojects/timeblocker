/**
 * Test-only helpers for expressing Toronto wall-clock times readably.
 * Not part of the engine's public surface.
 */

import { torontoInstant } from "./timezone.js";
import type { BusyEvent, FreeWindow } from "./types.js";

/** Build an ISO instant from Toronto wall-clock date + time. */
export function tor(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute = 0,
): string {
  return torontoInstant(year, month, day, hour, minute).toISOString();
}

/** A busy event spanning Toronto wall-clock times on a single day. */
export function busy(
  year: number,
  month: number,
  day: number,
  startH: number,
  startM: number,
  endH: number,
  endM: number,
  opts: Partial<Pick<BusyEvent, "id" | "withOthers">> = {},
): BusyEvent {
  return {
    start: tor(year, month, day, startH, startM),
    end: tor(year, month, day, endH, endM),
    ...opts,
  };
}

/** Does any free window fully cover [start, end)? */
export function windowsCover(
  windows: FreeWindow[],
  start: string,
  end: string,
): boolean {
  const s = new Date(start).getTime();
  const e = new Date(end).getTime();
  return windows.some(
    (w) => new Date(w.start).getTime() <= s && new Date(w.end).getTime() >= e,
  );
}

/** Does any free window overlap [start, end) at all? */
export function windowsOverlap(
  windows: FreeWindow[],
  start: string,
  end: string,
): boolean {
  const s = new Date(start).getTime();
  const e = new Date(end).getTime();
  return windows.some(
    (w) => new Date(w.start).getTime() < e && new Date(w.end).getTime() > s,
  );
}
