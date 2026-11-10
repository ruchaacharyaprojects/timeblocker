/**
 * Pure reminder selection (R5.1).
 *
 * The EventBridge scheduler invokes the backend every 15 minutes. On each
 * tick this module decides which blocks and which meetings-with-others are
 * starting ~15 minutes out and builds a custom notification for each, carrying
 * the three actionable buttons (R5.2).
 *
 * Everything here is deterministic and I/O-free: given `now`, the week's
 * blocks, and the week's meetings, it returns the notifications to deliver.
 * `now` is injected so the logic is fully unit-testable.
 */

import {
  LEGACY_REMINDER_ACTIONS,
  type ReminderBlock,
  type ReminderMeeting,
  type ReminderNotification,
} from "./types.js";

const MINUTE_MS = 60_000;

/** The reminder lead time: fire ~15 minutes before an event starts (R5.1). */
export const DEFAULT_LEAD_MINUTES = 15;

/**
 * The scheduler cadence. Because ticks are 15 minutes apart, each tick owns
 * the events whose start falls in a 15-minute-wide window so no event is
 * reminded twice and none is missed across ticks.
 */
export const DEFAULT_TICK_MINUTES = 15;

export interface SelectOptions {
  /** Minutes of lead time before start. Defaults to {@link DEFAULT_LEAD_MINUTES}. */
  leadMinutes?: number;
  /** Width of the per-tick window in minutes. Defaults to {@link DEFAULT_TICK_MINUTES}. */
  tickMinutes?: number;
}

export interface ReminderSources {
  blocks: readonly ReminderBlock[];
  meetings: readonly ReminderMeeting[];
}

/**
 * The half-open instant window a given tick is responsible for. An event is
 * reminded on this tick when its start is in `[now + lead, now + lead + tick)`.
 *
 * Example (lead = tick = 15): at 9:00 we remind everything starting in
 * [9:15, 9:30). At the 9:15 tick we remind [9:30, 9:45), and so on — so every
 * event gets exactly one reminder, roughly 15–30 minutes ahead, and never
 * twice.
 */
export function reminderWindow(
  now: Date,
  options: SelectOptions = {},
): { from: number; to: number } {
  const lead = options.leadMinutes ?? DEFAULT_LEAD_MINUTES;
  const tick = options.tickMinutes ?? DEFAULT_TICK_MINUTES;
  const from = now.getTime() + lead * MINUTE_MS;
  const to = from + tick * MINUTE_MS;
  return { from, to };
}

function startsInWindow(
  startIso: string,
  window: { from: number; to: number },
): boolean {
  const start = new Date(startIso).getTime();
  if (Number.isNaN(start)) return false;
  return start >= window.from && start < window.to;
}

function leadBody(startIso: string, now: Date): string {
  const minutes = Math.round(
    (new Date(startIso).getTime() - now.getTime()) / MINUTE_MS,
  );
  if (minutes <= 0) return "Starting now";
  if (minutes === 1) return "Starts in 1 minute";
  return `Starts in ${minutes} minutes`;
}

function blockNotification(
  block: ReminderBlock,
  now: Date,
): ReminderNotification {
  return {
    id: `block:${block.id}`,
    kind: "block",
    sourceId: block.id,
    title: block.title,
    body: leadBody(block.start, now),
    startsAt: block.start,
    actions: LEGACY_REMINDER_ACTIONS,
  };
}

function meetingNotification(
  meeting: ReminderMeeting,
  now: Date,
): ReminderNotification {
  return {
    id: `meeting:${meeting.id}`,
    kind: "meeting",
    sourceId: meeting.id,
    title: meeting.summary,
    body: leadBody(meeting.start, now),
    startsAt: meeting.start,
    actions: LEGACY_REMINDER_ACTIONS,
  };
}

/**
 * Select the custom reminders to fire on this tick (R5.1).
 *
 * Returns a notification for every block and every meeting-with-others whose
 * start falls in this tick's lead window, each carrying the "I'm in" / "Skip"
 * / "Move it" actions (R5.2). Meetings without other people are excluded:
 * solo blocks already handle their own reminders, and Google's reminders on
 * our blocks are suppressed upstream in calendar-integration (R4.2).
 *
 * Results are ordered by start instant (then block-before-meeting on ties) so
 * delivery order is deterministic.
 */
export function selectReminders(
  sources: ReminderSources,
  now: Date,
  options: SelectOptions = {},
): ReminderNotification[] {
  const window = reminderWindow(now, options);

  const notifications: ReminderNotification[] = [];

  for (const block of sources.blocks) {
    if (startsInWindow(block.start, window)) {
      notifications.push(blockNotification(block, now));
    }
  }

  for (const meeting of sources.meetings) {
    // Only meetings that include other people get a reminder (R5.1).
    if (!meeting.withOthers) continue;
    if (startsInWindow(meeting.start, window)) {
      notifications.push(meetingNotification(meeting, now));
    }
  }

  notifications.sort((a, b) => {
    const byStart =
      new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime();
    if (byStart !== 0) return byStart;
    if (a.kind === b.kind) return a.sourceId.localeCompare(b.sourceId);
    return a.kind === "block" ? -1 : 1;
  });

  return notifications;
}
