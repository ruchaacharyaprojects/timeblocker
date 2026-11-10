/**
 * TimeBlocker pure scheduling engine.
 *
 * Deterministic, America/Toronto, no network or I/O. See `engine.ts` for the
 * four public functions: weekBounds, freeWindows, place, reschedule.
 */

export { weekBounds, freeWindows, place, reschedule } from "./engine.js";
export type { PlaceOptions } from "./engine.js";
export * from "./types.js";
export {
  TORONTO_TZ,
  torontoInstant,
  torontoDateKey,
  torontoMinutesOfDay,
  torontoWeekday,
} from "./timezone.js";
