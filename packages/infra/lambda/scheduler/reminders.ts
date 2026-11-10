/**
 * Reminder orchestration for the scheduler Lambda's "reminders" branch (R5) —
 * pure of AWS/Google specifics.
 *
 * On each 15-minute tick this:
 *   1. resolves the current Sunday-Saturday week (America/Toronto),
 *   2. reads that week's persisted blocks and the week's real Google Calendar
 *      events,
 *   3. hands both to the pure `@timeblocker/reminders` selection, which keeps
 *      the blocks and the meetings-with-others starting ~15 minutes out, and
 *   4. delivers a custom actionable notification for each (R5.1, R5.2).
 *
 * Google's own reminders on our blocks are already suppressed upstream in
 * calendar-integration (R4.2), so these custom notifications are the only
 * reminders the user gets for blocks. Everything that touches the network or
 * AWS is behind a port, injected by the handler in `index.ts`, so this module
 * is unit-testable with in-memory fakes.
 */

import { weekBounds, type Week } from "@timeblocker/scheduling-engine";
import type { CalendarEvent } from "@timeblocker/calendar-integration";
import {
  runReminderTick,
  type NotificationPort,
  type ReminderBlock,
  type ReminderMeeting,
  type ReminderRunResult,
  type SelectOptions,
} from "@timeblocker/reminders";

/** A block persisted by planning, as read back from the blocks table. */
export interface PersistedBlockRow {
  id: string;
  itemId: string;
  start: string;
  end: string;
  /** Title to show in the reminder; falls back to the item text when absent. */
  title?: string;
  text?: string;
}

/** Reads the persisted blocks for a week (DynamoDB blocks table). */
export interface BlocksReader {
  readWeekBlocks(weekId: string): Promise<PersistedBlockRow[]>;
}

/**
 * The slice of the Google Calendar client reminders needs: read the week's
 * events. {@link GoogleCalendarClient} satisfies it.
 */
export interface CalendarReadPort {
  readWeek(week: Week): Promise<CalendarEvent[]>;
}

export interface RemindersDeps {
  blocks: BlocksReader;
  calendar: CalendarReadPort;
  notifier: NotificationPort;
}

export interface RemindersRequest {
  /** Current instant; the tick's lead window is measured from here. */
  now?: string;
  /** Any instant inside the week to evaluate (defaults to `now`). */
  weekOf?: string;
  /** Lead/tick overrides for the selection window (defaults to 15/15). */
  options?: SelectOptions;
}

/** Stable week id: the ISO date (YYYY-MM-DD) of the week's Sunday. */
export function weekIdOf(week: Week): string {
  return week.sunday.slice(0, 10);
}

/** Map a persisted block row to the reminders package's block shape. */
export function toReminderBlock(row: PersistedBlockRow): ReminderBlock {
  return {
    id: row.id,
    title: row.title ?? row.text ?? "Block",
    start: row.start,
    end: row.end,
  };
}

/** Map a normalized calendar event to the reminders package's meeting shape. */
export function toReminderMeeting(event: CalendarEvent): ReminderMeeting {
  return {
    id: event.id,
    summary: event.summary,
    start: event.start,
    end: event.end,
    withOthers: event.withOthers,
  };
}

/**
 * Run one reminders tick: select this tick's blocks + meetings-with-others and
 * deliver an actionable notification for each (R5.1, R5.2).
 */
export async function runReminders(
  request: RemindersRequest,
  deps: RemindersDeps,
): Promise<ReminderRunResult> {
  const nowIso = request.now ?? new Date().toISOString();
  const now = new Date(nowIso);
  const week = weekBounds(request.weekOf ?? nowIso);
  const weekId = weekIdOf(week);

  const [blockRows, calendarEvents] = await Promise.all([
    deps.blocks.readWeekBlocks(weekId),
    deps.calendar.readWeek(week),
  ]);

  const sources = {
    blocks: blockRows.map(toReminderBlock),
    // The selection drops meetings without other people; the mapping just
    // carries `withOthers` through from the normalized event.
    meetings: calendarEvents.map(toReminderMeeting),
  };

  return runReminderTick(sources, deps.notifier, now, request.options);
}
