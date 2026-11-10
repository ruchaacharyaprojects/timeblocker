/**
 * Meeting-conflict detection (R6.1, R14.4) — pure of AWS/Google specifics.
 *
 * Moved from `packages/infra/lambda/calendar-sync/detect.ts` into
 * `@timeblocker/flows`.
 *
 * When the calendar changes, a newly-added meeting with other people can land
 * on top of a block the user already has scheduled. Given the week's persisted
 * blocks and the week's current calendar events, this module finds the
 * meetings-with-others that overlap a scheduled block and raises the "Will you
 * miss this block?" prompt (R6.1) for each conflicted block. A "Yes" answer
 * routes into the reschedule flow ({@link runReschedule}).
 *
 * Overlap detection is pure half-open [start, end) interval math. TimeBlocker's
 * own 🧱 block events (`isBlock === true`) never count as meetings (R14.4).
 */

import { weekBounds, type Week } from "@timeblocker/scheduling-engine";
import type { CalendarEvent } from "@timeblocker/calendar-integration";
import type { PersistedBlock } from "./block.js";
import { buildMissPrompt, type NativeMissPrompt } from "./prompt.js";
import {
  runReschedule,
  type RescheduleDeps,
  type RescheduleOutcome,
} from "./reschedule.js";

// --- Pure overlap detection ------------------------------------------------

/** A half-open [start, end) time span keyed by ISO instants. */
export interface Span {
  start: string;
  end: string;
}

/**
 * True when two half-open [start, end) spans overlap. Touching at a boundary
 * (one ends exactly when the other starts) is NOT an overlap, matching the
 * engine's half-open interval convention.
 */
export function overlaps(a: Span, b: Span): boolean {
  const aStart = new Date(a.start).getTime();
  const aEnd = new Date(a.end).getTime();
  const bStart = new Date(b.start).getTime();
  const bEnd = new Date(b.end).getTime();
  return aStart < bEnd && bStart < aEnd;
}

/** A block that a meeting-with-others overlaps, with the offending meetings. */
export interface BlockConflict {
  block: PersistedBlock;
  /** The meeting(s) with other people that overlap this block. */
  meetings: CalendarEvent[];
}

/**
 * A block is a candidate for conflict only while it is still expected to
 * happen: only "scheduled" blocks are watched.
 */
function isWatchable(block: PersistedBlock): boolean {
  return block.status === "scheduled";
}

/**
 * A calendar event counts as a conflicting meeting only when it includes other
 * people (R6.1) and is not one of TimeBlocker's own 🧱 block events (R14.4).
 */
function isMeetingWithOthers(event: CalendarEvent): boolean {
  return event.withOthers === true && event.isBlock !== true;
}

/**
 * Find the scheduled blocks that a meeting-with-others overlaps (R6.1, R14.4).
 *
 * Pure: no I/O. Pairs each still-scheduled block with every non-🧱
 * meeting-with-others whose time half-open-overlaps it. Blocks with no
 * overlapping meeting, non-scheduled blocks, solo events, and 🧱 block events
 * are excluded.
 */
export function findConflicts(
  blocks: PersistedBlock[],
  events: CalendarEvent[],
): BlockConflict[] {
  const meetings = events.filter(isMeetingWithOthers);
  const conflicts: BlockConflict[] = [];
  for (const block of blocks) {
    if (!isWatchable(block)) continue;
    const overlapping = meetings.filter((m) => overlaps(block, m));
    if (overlapping.length > 0) {
      conflicts.push({ block, meetings: overlapping });
    }
  }
  return conflicts;
}

/** Title to show on the prompt for a block; falls back to text. */
function blockTitle(block: PersistedBlock): string {
  return block.title ?? block.text ?? "Block";
}

// --- Injected ports --------------------------------------------------------

/** Reads the persisted blocks for a week (DynamoDB blocks table). */
export interface WeekBlocksReader {
  readWeekBlocks(weekId: string): Promise<PersistedBlock[]>;
}

/** The slice of the Google Calendar client detection needs. */
export interface CalendarReadPort {
  readWeek(week: Week): Promise<CalendarEvent[]>;
}

/** Raises the "Will you miss this block?" prompt (R6.1). */
export interface PromptRaiser {
  presentPrompt(prompt: NativeMissPrompt): Promise<void>;
}

export interface DetectionDeps {
  blocks: WeekBlocksReader;
  calendar: CalendarReadPort;
  prompt: PromptRaiser;
}

export interface DetectionRequest {
  /** Any instant inside the week to check (defaults to now). */
  weekOf?: string;
}

/** A prompt that was raised for a conflicted block. */
export interface RaisedPrompt {
  prompt: NativeMissPrompt;
  conflict: BlockConflict;
}

export interface DetectionResult {
  weekId: string;
  /** The conflicts found this run. */
  conflicts: BlockConflict[];
  /** The "Will you miss this block?" prompts raised (one per conflict). */
  raised: RaisedPrompt[];
}

/** Stable week id: the ISO date (YYYY-MM-DD) of the week's Sunday. */
export function weekIdOf(week: Week): string {
  return week.sunday.slice(0, 10);
}

// --- Orchestration ---------------------------------------------------------

/**
 * Watch the week for new meetings overlapping existing blocks and raise the
 * "Will you miss this block?" prompt for each conflicted block (R6.1).
 */
export async function runMeetingConflictDetection(
  request: DetectionRequest,
  deps: DetectionDeps,
): Promise<DetectionResult> {
  const weekOf = request.weekOf ?? new Date().toISOString();
  const week = weekBounds(weekOf);
  const weekId = weekIdOf(week);

  const [blocks, events] = await Promise.all([
    deps.blocks.readWeekBlocks(weekId),
    deps.calendar.readWeek(week),
  ]);

  const conflicts = findConflicts(blocks, events);

  const raised: RaisedPrompt[] = [];
  for (const conflict of conflicts) {
    const prompt = buildMissPrompt({
      blockId: conflict.block.id,
      weekId: conflict.block.weekId,
      title: blockTitle(conflict.block),
      trigger: "meeting-overlap",
    });
    await deps.prompt.presentPrompt(prompt);
    raised.push({ prompt, conflict });
  }

  return { weekId, conflicts, raised };
}

/**
 * Route a "Yes" answer to a meeting-overlap prompt into the shared reschedule
 * flow (R6.2).
 */
export async function runMeetingConflictAnswer(
  args: { blockId: string; weekId: string; answer?: "yes" | "no"; now?: string },
  deps: RescheduleDeps,
): Promise<RescheduleOutcome> {
  return runReschedule(
    {
      blockId: args.blockId,
      weekId: args.weekId,
      answer: args.answer,
      now: args.now,
    },
    deps,
  );
}
