/**
 * Display formatting for the view models. Every time is shown in
 * America/Toronto, whatever the device time zone (R11.7, R14.1).
 */
import type { DeviceBlockStatus } from "../models.js";
import { TORONTO_TZ } from "@timeblocker/scheduling-engine";

/** Toronto clock time, e.g. "2:30 PM". */
const TIME = new Intl.DateTimeFormat("en-US", {
  timeZone: TORONTO_TZ,
  hour: "numeric",
  minute: "2-digit",
});

/** Toronto date, e.g. "Mon, Mar 9". */
const DATE = new Intl.DateTimeFormat("en-US", {
  timeZone: TORONTO_TZ,
  weekday: "short",
  month: "short",
  day: "numeric",
});

/** A calendar date with no time zone shift (used for `YYYY-MM-DD` keys). */
const CALENDAR_DATE = new Intl.DateTimeFormat("en-US", {
  timeZone: "UTC",
  weekday: "short",
  month: "short",
  day: "numeric",
});

/** ICU uses narrow/no-break spaces (e.g. before "PM"); show plain spaces. */
const plain = (s: string) => s.replace(/\s/g, " ");

const toDate = (instant: string | number) =>
  new Date(typeof instant === "number" ? instant : Date.parse(instant));

/** Toronto clock time of an instant, e.g. "2:30 PM". */
export function formatTorontoTime(instant: string | number): string {
  return plain(TIME.format(toDate(instant)));
}

/** Toronto date of an instant, e.g. "Mon, Mar 9". */
export function formatTorontoDate(instant: string | number): string {
  return plain(DATE.format(toDate(instant)));
}

/** Toronto date and time of an instant, e.g. "Mon, Mar 9, 2:30 PM". */
export function formatTorontoDateTime(instant: string | number): string {
  return `${formatTorontoDate(instant)}, ${formatTorontoTime(instant)}`;
}

/** "2:30 PM – 3:30 PM" for a span, in Toronto time. */
export function formatTimeRange(start: string | number, end: string | number): string {
  return `${formatTorontoTime(start)} – ${formatTorontoTime(end)}`;
}

/** UTC midnight of a `YYYY-MM-DD` key, epoch ms. */
function dateKeyMs(key: string): number {
  const [y, m, d] = key.split("-").map(Number);
  return Date.UTC(y!, m! - 1, d!);
}

/** The `YYYY-MM-DD` key `days` calendar days after `key`. */
export function addDaysToKey(key: string, days: number): string {
  return new Date(dateKeyMs(key) + days * 86_400_000).toISOString().slice(0, 10);
}

/** A `YYYY-MM-DD` key as "Sun, Mar 8". */
export function formatDateKey(key: string): string {
  return plain(CALENDAR_DATE.format(new Date(dateKeyMs(key))));
}

/** Display names for block statuses (R11.8). */
export const STATUS_LABELS: Readonly<Record<DeviceBlockStatus, string>> = {
  scheduled: "Scheduled",
  "in-progress": "In progress",
  done: "Done",
  partial: "Partly done",
  skipped: "Skipped",
  missed: "Missed",
  rolled: "Didn't fit this week",
};

/** Minutes as "45 min", "2 h", or "3 h 25 min". */
export function formatMinutes(totalMin: number): string {
  const min = Math.max(0, Math.round(totalMin));
  const h = Math.floor(min / 60);
  const m = min % 60;
  if (h === 0) return `${m} min`;
  return m === 0 ? `${h} h` : `${h} h ${m} min`;
}
