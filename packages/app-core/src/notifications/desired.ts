/**
 * The pure desired-notification set (design: "Desired notification set").
 *
 * Given local blocks, the cached calendar events, `now`, and whether exact
 * alarms are available, returns every local notification TimeBlocker should
 * have armed right now. `NotificationService.reconcile()` diffs this set
 * against the notification registry and the native pending set.
 *
 * - One block reminder per `scheduled` block with `start > now`
 *   (R5.1, R5.2, R13.1, R13.3, R13.11).
 * - One meeting reminder per cached event with `withOthers && !isBlock &&
 *   start > now`, no action buttons (R5.1, R13.2, R13.11).
 * - The next Saturday 18:00 review nudge and Sunday 08:00 planning nudge in
 *   America/Toronto (R9.4).
 *
 * Ids embed the source start in epoch ms, so a changed start is a different
 * id. Pure: no I/O, no clock reads, deterministic output order.
 */
import type { CalendarEvent } from "@timeblocker/calendar-integration";
import { REMINDER_ACTIONS } from "@timeblocker/reminders";
import {
  torontoDateKey,
  torontoInstant,
  torontoMinutesOfDay,
  torontoWeekday,
} from "@timeblocker/scheduling-engine";
import type { DeviceBlock, RegistryKind } from "../models.js";
import type { NotificationAction, NotificationPayload } from "../ports.js";
import type { Forecast } from "./forecast.js";

/** Reminders fire this long before the source start (R5.1, R13.1, R13.2). */
export const REMINDER_LEAD_MS = 15 * 60_000;

/** Weekly nudge schedule in America/Toronto (matches the retained crons, R9). */
export const WEEKLY_NUDGES = {
  review: { weekday: 6, hour: 18, minute: 0 },
  planning: { weekday: 0, hour: 8, minute: 0 },
} as const;

export type WeeklyNudge = keyof typeof WEEKLY_NUDGES;

/** The block reminder's action buttons, exactly `REMINDER_ACTIONS` (R5.2, R13.3, R17.4). */
export const BLOCK_REMINDER_ACTIONS: readonly NotificationAction[] = REMINDER_ACTIONS.map(
  (a) => ({ id: a.id, label: a.label }),
);

/** One notification that should be armed (or shown now, when `fireAtMs ≤ now`). */
export interface DesiredNotification {
  payload: NotificationPayload;
  kind: RegistryKind;
  sourceId: string;
  /** Start of the source block/event (or the nudge instant), epoch ms. */
  startMs: number;
  /** `max(start − 15 min, now)` for reminders; the nudge instant for nudges. */
  fireAtMs: number;
  exact: boolean;
}

export interface DesiredInput {
  blocks: readonly DeviceBlock[];
  /** Cached non-🧱 events from the latest syncs (duplicates by id are merged). */
  events: readonly CalendarEvent[];
  /** epoch ms */
  now: number;
  /** From `Notifier.canScheduleExact()` (R13.10). */
  exact: boolean;
  /** Per-block forecasts keyed by block id; a non-empty `line` is added to the body (R17.3). */
  forecasts?: ReadonlyMap<string, Forecast>;
}

export const blockReminderId = (blockId: string, startMs: number): string =>
  `rem:block:${blockId}@${startMs}`;

export const meetingReminderId = (eventId: string, startMs: number): string =>
  `rem:meeting:${eventId}@${startMs}`;

export const nudgeId = (nudge: WeeklyNudge, atMs: number): string =>
  `nudge:${nudge}@${atMs}`;

/** `max(start − 15 min, now)`: shown immediately when the start is under 15 minutes away (R13.11). */
export function reminderFireAt(startMs: number, now: number): number {
  return Math.max(startMs - REMINDER_LEAD_MS, now);
}

/** "9:05 AM" in America/Toronto. */
function torontoTimeLabel(ms: number): string {
  const minutes = torontoMinutesOfDay(new Date(ms));
  const h24 = Math.floor(minutes / 60);
  const mm = String(minutes % 60).padStart(2, "0");
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  return `${h12}:${mm} ${h24 < 12 ? "AM" : "PM"}`;
}

function parseMs(iso: string): number | null {
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

function blockReminder(block: DeviceBlock, startMs: number, input: DesiredInput): DesiredNotification {
  const id = blockReminderId(block.id, startMs);
  const line = input.forecasts?.get(block.id)?.line ?? "";
  return {
    kind: "block-reminder",
    sourceId: block.id,
    startMs,
    fireAtMs: reminderFireAt(startMs, input.now),
    exact: input.exact,
    payload: {
      id,
      kind: "block-reminder",
      channel: "reminders",
      title: block.title,
      body: line ? `Starts at ${torontoTimeLabel(startMs)}\n${line}` : `Starts at ${torontoTimeLabel(startMs)}`,
      actions: BLOCK_REMINDER_ACTIONS,
      sourceId: block.id,
      weekId: block.weekId,
      deepLink: `timeblocker://block/${block.id}`,
    },
  };
}

function meetingReminder(event: CalendarEvent, startMs: number, input: DesiredInput): DesiredNotification {
  const id = meetingReminderId(event.id, startMs);
  return {
    kind: "meeting-reminder",
    sourceId: event.id,
    startMs,
    fireAtMs: reminderFireAt(startMs, input.now),
    exact: input.exact,
    payload: {
      id,
      kind: "meeting-reminder",
      channel: "reminders",
      title: event.summary || "Meeting",
      body: `Starts at ${torontoTimeLabel(startMs)}`,
      actions: [],
      sourceId: event.id,
    },
  };
}

/** Toronto Y/M/D of an instant. */
function torontoYmd(ms: number): [number, number, number] {
  const [y, m, d] = torontoDateKey(new Date(ms)).split("-").map(Number);
  return [y!, m!, d!];
}

/**
 * The next occurrence (strictly after `now`) of a weekly nudge in Toronto,
 * with the Sunday date (YYYY-MM-DD) of the week it belongs to.
 */
export function nextNudgeAt(nudge: WeeklyNudge, now: number): { atMs: number; weekId: string } {
  const spec = WEEKLY_NUDGES[nudge];
  const [y, m, d] = torontoYmd(now);
  const today = torontoWeekday(new Date(now));
  let delta = (spec.weekday - today + 7) % 7;
  // Date.UTC normalises day overflow, so `d + delta` may exceed the month.
  let at = torontoInstant(y, m, d + delta, spec.hour, spec.minute).getTime();
  if (at <= now) {
    delta += 7;
    at = torontoInstant(y, m, d + delta, spec.hour, spec.minute).getTime();
  }
  const sundayOffset = delta - spec.weekday;
  const weekId = torontoDateKey(torontoInstant(y, m, d + sundayOffset, 12, 0));
  return { atMs: at, weekId };
}

function weeklyNudge(nudge: WeeklyNudge, input: DesiredInput): DesiredNotification {
  const { atMs, weekId } = nextNudgeAt(nudge, input.now);
  const id = nudgeId(nudge, atMs);
  const sourceId = `weekly-${nudge}`;
  const copy =
    nudge === "review"
      ? {
          title: "Saturday review",
          body: "Close out your week, then paste or type next week's list.",
          deepLink: "timeblocker://review",
        }
      : {
          title: "Plan your week",
          body: "Paste or type this week's list to get it on your calendar.",
          deepLink: "timeblocker://intake",
        };
  return {
    kind: "weekly-nudge",
    sourceId,
    startMs: atMs,
    fireAtMs: atMs,
    exact: input.exact,
    payload: {
      id,
      kind: "weekly-nudge",
      channel: "nudges",
      title: copy.title,
      body: copy.body,
      actions: [],
      sourceId,
      weekId,
      deepLink: copy.deepLink,
    },
  };
}

/**
 * The full desired set, ordered by `fireAtMs` then id. Unparseable starts are
 * skipped; duplicate blocks/events (same id) yield one entry.
 */
export function desiredNotifications(input: DesiredInput): DesiredNotification[] {
  const out = new Map<string, DesiredNotification>();
  const seenBlocks = new Set<string>();
  for (const block of input.blocks) {
    if (block.status !== "scheduled" || seenBlocks.has(block.id)) continue;
    const startMs = parseMs(block.start);
    if (startMs === null || startMs <= input.now) continue;
    seenBlocks.add(block.id);
    const n = blockReminder(block, startMs, input);
    out.set(n.payload.id, n);
  }
  const seenEvents = new Set<string>();
  for (const event of input.events) {
    if (!event.withOthers || event.isBlock || seenEvents.has(event.id)) continue;
    const startMs = parseMs(event.start);
    if (startMs === null || startMs <= input.now) continue;
    seenEvents.add(event.id);
    const n = meetingReminder(event, startMs, input);
    out.set(n.payload.id, n);
  }
  for (const nudge of ["review", "planning"] as const) {
    const n = weeklyNudge(nudge, input);
    out.set(n.payload.id, n);
  }
  return [...out.values()].sort(
    (a, b) => a.fireAtMs - b.fireAtMs || (a.payload.id < b.payload.id ? -1 : a.payload.id > b.payload.id ? 1 : 0),
  );
}
