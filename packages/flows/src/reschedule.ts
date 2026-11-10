/**
 * Reschedule orchestration (R6) — pure of AWS/Google specifics.
 *
 * Moved from `packages/infra/lambda/reschedule/reschedule.ts` into
 * `@timeblocker/flows`. It drives the "Will you miss this block?" flow:
 *
 *   1. The device shows the actionable "Will you miss this block?" Yes/No
 *      prompt (R6.1). The decision/flow logic lives here; the prompt payload
 *      is built in `prompt.ts`. The reminders "Move it" action and a Yes tap
 *      both route into {@link runReschedule}.
 *   2. {@link computeReschedule} is the pure core: given the block, its
 *      Sunday-Saturday week, the busy events, the constraints, and `now`, it
 *      asks the engine for the next valid slot, searching from
 *      `max(block.start, now)` so a move never lands in the past (R6.2).
 *   3. {@link runReschedule} wraps it with I/O. If a slot exists, it moves the
 *      block: updates the calendar event in place (same calendarEventId),
 *      persists the new start/end with status "moved", and returns an Undo
 *      token that restores the previous slot.
 *   4. If no slot exists, it returns the "nothing fits" flow result reusing
 *      the planning alert shape (shrink / drop / roll-to-next-week) (R6.3).
 *
 * Everything that touches the network or AWS lives behind a port.
 */

import {
  reschedule,
  weekBounds,
  NO_FIT,
  type Block,
  type BusyEvent,
  type Constraints,
  type Item,
  type Slot,
  type Week,
} from "@timeblocker/scheduling-engine";
import {
  toBusyEvents,
  type CalendarEvent,
  type SoloBlock,
} from "@timeblocker/calendar-integration";
import type { BlockStatus, PersistedBlock } from "./block.js";
import { buildNothingFitsAlert, type NothingFitsAlert } from "./plan.js";

export { buildNothingFitsAlert, type NothingFitsAlert };
export type { BlockStatus, PersistedBlock };

// --- Request / settings ----------------------------------------------------

/** Settings relevant to rescheduling (R3.2 overridable holidays). */
export interface RescheduleSettings {
  holidays: string[];
}

/** Default settings when none are stored yet. */
export const DEFAULT_SETTINGS: RescheduleSettings = { holidays: [] };

/**
 * A request to run the reschedule flow. `blockId` identifies the block to
 * move; `weekId` locates it in the blocks table. The user's answer to the
 * "Will you miss this block?" prompt drives whether anything moves (R6.1).
 */
export interface RescheduleRequest {
  blockId: string;
  weekId: string;
  /** The user's answer to the Yes/No prompt. Defaults to "yes". */
  answer?: PromptAnswer;
  /**
   * Current instant. The next slot is searched after
   * `max(block.start, now)`; when omitted, after the block's start.
   */
  now?: string;
}

// --- Prompt surface (R6.1) -------------------------------------------------

/** The user's answer to the "Will you miss this block?" prompt (R6.1). */
export type PromptAnswer = "yes" | "no";

// --- Pure reschedule core --------------------------------------------------

/** Input to {@link computeReschedule}. Everything is already loaded. */
export interface ComputeRescheduleInput {
  block: PersistedBlock;
  /** The block's Sunday-Saturday week. */
  week: Week;
  /** Busy events to avoid (the block's own id is excluded by the engine). */
  busy: BusyEvent[];
  constraints: Constraints;
  /** Current instant (ISO). The search starts at `max(block.start, now)`. */
  now: string;
}

/** Result of {@link computeReschedule}. */
export type ComputeRescheduleResult =
  | { kind: "moved"; slot: Slot }
  | { kind: "nothing-fits"; alert: NothingFitsAlert };

/** Title to carry onto the calendar event for a block. */
function blockTitle(block: PersistedBlock): string {
  return block.title ?? block.text ?? "Block";
}

/** The later of two ISO instants (by absolute time). */
function laterOf(a: string, b: string): string {
  return new Date(b).getTime() > new Date(a).getTime() ? b : a;
}

/**
 * Pure: find the next valid slot for a block in its week (R6.2), or build the
 * nothing-fits alert (R6.3). Passes `notBefore = max(block.start, now)` to
 * the engine so the new slot is never in the past. Reads no clock; no I/O.
 */
export function computeReschedule(
  input: ComputeRescheduleInput,
): ComputeRescheduleResult {
  const { block } = input;
  const engineBlock: Block = {
    id: block.id,
    itemId: block.itemId,
    start: block.start,
    end: block.end,
    category: block.category,
  };

  const slot = reschedule(
    engineBlock,
    input.week,
    input.busy,
    input.constraints,
    { notBefore: laterOf(block.start, input.now) },
  );

  if (slot === NO_FIT) {
    const item: Item = {
      id: block.itemId,
      text: blockTitle(block),
      durationMin: Math.round(
        (new Date(block.end).getTime() - new Date(block.start).getTime()) /
          60000,
      ),
      priority: 1,
      category: block.category,
    };
    return { kind: "nothing-fits", alert: buildNothingFitsAlert([item]) };
  }

  return { kind: "moved", slot };
}

// --- Result shapes ---------------------------------------------------------

/**
 * An Undo payload that restores a moved block to its previous slot (R6.2).
 * Applying it is the inverse of the move: put the calendar event and the
 * persisted block back to `previous` with the prior status.
 */
export interface UndoToken {
  blockId: string;
  weekId: string;
  calendarEventId: string;
  /** The slot to restore to. */
  previous: Slot;
  /** The status the block had before the move. */
  previousStatus: BlockStatus;
}

export type RescheduleOutcome =
  /** The user answered No; nothing moved (R6.1). */
  | { kind: "declined"; block: PersistedBlock }
  /** The block moved to the next valid slot; Undo restores it (R6.2). */
  | {
      kind: "moved";
      block: PersistedBlock;
      from: Slot;
      to: Slot;
      undo: UndoToken;
    }
  /** No valid slot this week; start the nothing-fits flow (R6.3). */
  | { kind: "nothing-fits"; block: PersistedBlock; alert: NothingFitsAlert };

// --- Injected ports --------------------------------------------------------

/** Reads a single persisted block by week + id (DynamoDB blocks table). */
export interface BlocksReader {
  readBlock(weekId: string, blockId: string): Promise<PersistedBlock | null>;
}

/** Persists a block's new slot/status after a move (DynamoDB blocks table). */
export interface BlocksWriter {
  saveBlock(block: PersistedBlock): Promise<void>;
}

/** Reads the single user's reschedule settings. */
export interface SettingsReader {
  readSettings(): Promise<RescheduleSettings>;
}

/**
 * The slice of the Google Calendar client reschedule needs: read the week's
 * events (to search around real meetings) and update the moved block's event
 * in place. {@link GoogleCalendarClient} satisfies it — `writeBlock` with a
 * `calendarEventId` updates the existing event rather than creating one.
 */
export interface CalendarPort {
  readWeek(week: Week): Promise<CalendarEvent[]>;
  writeBlock(block: SoloBlock): Promise<string>;
}

export interface RescheduleDeps {
  blocks: BlocksReader;
  blocksWriter: BlocksWriter;
  settings: SettingsReader;
  calendar: CalendarPort;
}

// --- Orchestration ---------------------------------------------------------

/**
 * Build the solo block to write for `block` at `slot`. The calendar event id
 * is carried only when known, so a block with an id is updated in place and a
 * block without one gets a new event (whose id the caller then persists).
 */
function toSoloBlock(
  block: PersistedBlock,
  slot: Slot,
  calendarEventId: string | undefined,
): SoloBlock {
  const solo: SoloBlock = {
    title: blockTitle(block),
    start: slot.start,
    end: slot.end,
    category: block.category,
  };
  if (calendarEventId !== undefined) solo.calendarEventId = calendarEventId;
  return solo;
}

/**
 * Run the "Will you miss this block?" reschedule flow for one block (R6).
 *
 * - On a "no" answer, nothing moves and the block is returned unchanged
 *   (R6.1).
 * - On a "yes" answer, {@link computeReschedule} finds the next valid slot in
 *   the same Sunday-Saturday week. If one exists the block moves: the
 *   calendar event is updated in place, the new slot is persisted with status
 *   "moved", and an Undo token that restores the previous slot is returned
 *   (R6.2). If none exists the nothing-fits flow is returned, reusing the
 *   planning alert shape (R6.3).
 */
export async function runReschedule(
  request: RescheduleRequest,
  deps: RescheduleDeps,
): Promise<RescheduleOutcome> {
  const block = await deps.blocks.readBlock(request.weekId, request.blockId);
  if (!block) {
    throw new Error(
      `Block ${request.blockId} not found in week ${request.weekId}`,
    );
  }

  // R6.1: only a "yes" moves the block; "no" leaves it in place.
  const answer = request.answer ?? "yes";
  if (answer === "no") {
    return { kind: "declined", block };
  }

  const settings = await deps.settings.readSettings();
  const week = weekBounds(block.start);

  const calendarEvents = await deps.calendar.readWeek(week);
  const busy: BusyEvent[] = toBusyEvents(calendarEvents);

  const constraints: Constraints = { holidays: settings.holidays };

  const computed = computeReschedule({
    block,
    week,
    busy,
    constraints,
    // Without an explicit `now`, search after the block's start (unchanged
    // infra behavior).
    now: request.now ?? block.start,
  });

  // R6.3: nothing fits this week -> start the nothing-fits flow. The engine
  // never forces a block into a slot.
  if (computed.kind === "nothing-fits") {
    return { kind: "nothing-fits", block, alert: computed.alert };
  }

  // R6.2: move the block to the next valid slot. Remember the previous slot
  // and status for Undo before overwriting them.
  const slot = computed.slot;
  const from: Slot = { start: block.start, end: block.end };
  const previousStatus = block.status;

  const calendarEventId = await deps.calendar.writeBlock(
    toSoloBlock(block, slot, block.calendarEventId),
  );

  const movedBlock: PersistedBlock = {
    ...block,
    start: slot.start,
    end: slot.end,
    calendarEventId,
    status: "moved",
  };
  await deps.blocksWriter.saveBlock(movedBlock);

  const undo: UndoToken = {
    blockId: block.id,
    weekId: block.weekId,
    calendarEventId,
    previous: from,
    previousStatus,
  };

  return { kind: "moved", block: movedBlock, from, to: slot, undo };
}

/**
 * Apply an {@link UndoToken}: restore a moved block to its previous slot and
 * status (R6.2). The inverse of the move — updates the calendar event in place
 * and re-persists the block.
 */
export async function applyUndo(
  undo: UndoToken,
  deps: Pick<RescheduleDeps, "blocks" | "blocksWriter" | "calendar">,
): Promise<PersistedBlock> {
  const block = await deps.blocks.readBlock(undo.weekId, undo.blockId);
  if (!block) {
    throw new Error(
      `Block ${undo.blockId} not found in week ${undo.weekId} for undo`,
    );
  }

  const calendarEventId = await deps.calendar.writeBlock(
    toSoloBlock(block, undo.previous, undo.calendarEventId),
  );

  const restored: PersistedBlock = {
    ...block,
    start: undo.previous.start,
    end: undo.previous.end,
    calendarEventId,
    status: undo.previousStatus,
  };
  await deps.blocksWriter.saveBlock(restored);
  return restored;
}
