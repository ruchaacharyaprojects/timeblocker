/**
 * Pure helpers for building calendar write requests and parsing reads.
 *
 * No network or I/O lives here: given a SoloBlock this module produces the
 * exact request body Google expects, and given a raw Google event it produces
 * the normalized {@link CalendarEvent}. Keeping this pure makes R4.1 (🧱
 * prefix, per-category color) and R4.2 (no default pop-ups, no email
 * reminders) directly unit-testable.
 */

import type { BusyEvent } from "@timeblocker/scheduling-engine";
import type {
  Category,
  CalendarEvent,
  EventReminders,
  GoogleEventRequest,
  SoloBlock,
} from "./types.js";

/** The title prefix that marks a TimeBlocker-authored solo block (R4.1). */
export const BLOCK_PREFIX = "🧱" as const;

/**
 * Distinct Google Calendar color id per category (R4.1). Values are the
 * documented Google event `colorId`s (1-11), chosen to be visually distinct:
 *   fitness          -> Flamingo (4)
 *   self-care        -> Lavender (1)
 *   work             -> Blueberry (9)
 *   self-development -> Basil (10)
 *   misc             -> Graphite (8)
 */
export const CATEGORY_COLOR_ID: Record<Category, string> = {
  fitness: "4",
  "self-care": "1",
  work: "9",
  "self-development": "10",
  misc: "8",
};

/** Reminders that disable Google defaults and add no email reminders (R4.2). */
export const SUPPRESSED_REMINDERS: EventReminders = {
  useDefault: false,
  overrides: [],
};

/** Prefix a title with the 🧱 marker, without double-prefixing (R4.1). */
export function withBlockPrefix(title: string): string {
  const trimmed = title.trimStart();
  if (trimmed.startsWith(BLOCK_PREFIX)) return trimmed;
  return `${BLOCK_PREFIX} ${trimmed}`;
}

/** Resolve the Google color id for a category (R4.1). */
export function colorIdForCategory(category: Category): string {
  return CATEGORY_COLOR_ID[category];
}

/**
 * Build the Google Calendar insert/update request body for a solo block.
 *
 * Applies the 🧱 prefix, the per-category color, and the suppressed-reminder
 * settings (no default pop-ups, no email reminders) so every write satisfies
 * R4.1 and R4.2.
 */
export function buildEventRequest(block: SoloBlock): GoogleEventRequest {
  return {
    summary: withBlockPrefix(block.title),
    start: { dateTime: block.start },
    end: { dateTime: block.end },
    colorId: colorIdForCategory(block.category),
    reminders: SUPPRESSED_REMINDERS,
  };
}

/** The minimal shape of a raw Google event we read back. */
export interface RawGoogleEvent {
  id?: string;
  summary?: string;
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
  colorId?: string;
  attendees?: Array<{ self?: boolean; email?: string }>;
  /** `"confirmed" | "tentative" | "cancelled"`. */
  status?: string;
}

/** True when a summary marks a TimeBlocker block (🧱 prefix, leading spaces ignored). */
export function isBlockSummary(summary: string | undefined): boolean {
  return (summary ?? "").trimStart().startsWith(BLOCK_PREFIX);
}

function instantFrom(
  slot: { dateTime?: string; date?: string } | undefined,
): string | undefined {
  if (!slot) return undefined;
  if (slot.dateTime) return new Date(slot.dateTime).toISOString();
  // All-day event: treat midnight as the instant.
  if (slot.date) return new Date(slot.date).toISOString();
  return undefined;
}

/**
 * True when the event includes attendees other than the calendar owner, i.e.
 * it is a meeting with other people (used by R5/R6 downstream).
 */
export function hasOtherAttendees(raw: RawGoogleEvent): boolean {
  const attendees = raw.attendees ?? [];
  return attendees.some((a) => a.self !== true);
}

/**
 * Normalize a raw Google event into a {@link CalendarEvent}. Returns
 * `undefined` for events missing an id or a concrete start/end (e.g. events
 * the API returned without times), which the caller drops.
 */
export function parseCalendarEvent(
  raw: RawGoogleEvent,
): CalendarEvent | undefined {
  const start = instantFrom(raw.start);
  const end = instantFrom(raw.end);
  if (!raw.id || !start || !end) return undefined;
  return {
    id: raw.id,
    summary: raw.summary ?? "",
    start,
    end,
    withOthers: hasOtherAttendees(raw),
    colorId: raw.colorId,
    isBlock: isBlockSummary(raw.summary),
  };
}

/**
 * Map read-back calendar events to the scheduling-engine's {@link BusyEvent}
 * shape so planning and reschedule can subtract real events from free time.
 */
export function toBusyEvents(events: CalendarEvent[]): BusyEvent[] {
  return events.map((e) => ({
    id: e.id,
    start: e.start,
    end: e.end,
    withOthers: e.withOthers,
  }));
}
