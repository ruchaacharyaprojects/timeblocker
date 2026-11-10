/**
 * `BlockActionService`: what happens when she taps a block or prompt action
 * (design: "Action handling"; R6.2, R6.3, R11.8, R13.4, R13.6, R13.12, R13.13).
 *
 * - `imIn` → status `in-progress`; `skip` → status `skipped` (R13.4).
 * - `moveIt` → {@link computeReschedule} in the block's Sunday-Saturday week.
 *   Moved: new start/end, status `scheduled`, `movedFrom`/`moveReason`, one
 *   outbox upsert, reminders reconciled. No fit: the block is left exactly as
 *   it was and a `status` notification "Nothing fits this week" deep-links to
 *   `timeblocker://nothing-fits/<id>` (R13.4, R13.13, R11.8).
 * - `answerPrompt(yes)` → the same move, and the prompt leaves `openPrompts`
 *   (R6.2, R6.3, R13.6). `answerPrompt(no)` → nothing changes except the
 *   prompt leaving `openPrompts`; the reminder stays armed (R13.12).
 *
 * Every action works from local data and the last sync's calendar cache only
 * (no network), so it fits the 5 s headless budget. Each action's state
 * change is one atomic `setMany`. Afterwards: reconcile notifications,
 * dismiss the tapped notification, and kick a best-effort outbox flush that
 * is never awaited. Actions are serialized so two taps never interleave.
 *
 * Extension points (kept in this file):
 * - Undo (R6.2, R11.9): every successful move stores the single active
 *   {@link UndoToken} (`UNDO_WINDOW_MS`) in the move's commit; a prompt "Yes"
 *   also shows a "Moved to …" `status` notification with an Undo action that
 *   times out with the window. {@link BlockActionService.undo} restores the
 *   previous start/end/status only while `now < expiresAt` and the block is
 *   still at the moved-to slot; otherwise it is rejected with no change.
 * - Nothing-fits resolution (R2.3, R6.3, R8.1):
 *   {@link BlockActionService.resolveNothingFits} on the screen reached via
 *   {@link nothingFitsDeepLink}. Shrink (75%, 50%, or custom ≥ 15 min)
 *   retries {@link BlockActionService.placeBlock} with the shorter span; drop
 *   removes the block (and its item) and enqueues a delete; roll deletes this
 *   week's event, keeps the block as `rolled` ("Didn't fit this week"), and
 *   adds the item, confirmed, to `items:<nextWeekId>`. Fitness blocks are
 *   never rolled and a fitness drop records `missed`
 *   ({@link nothingFitsOptionsFor}). A block kept after its event is deleted
 *   is marked `calendarSynced: false` so sync never reads the deletion as a
 *   remote removal.
 */
import type { CalendarEvent } from "@timeblocker/calendar-integration";
import {
  computeReschedule,
  DEFAULT_PRIORITY,
  type IntakeItem,
  type NothingFitsAlert,
  type NothingFitsOption,
  type PromptAnswer,
} from "@timeblocker/flows";
import {
  freeWindows,
  TORONTO_TZ,
  torontoDateKey,
  torontoMinutesOfDay,
  torontoWeekday,
  type BusyEvent,
  type Constraints,
  type FreeWindow,
  type Slot,
} from "@timeblocker/scheduling-engine";
import {
  MAX_BLOCK_NOTES_CHARS,
  UNDO_WINDOW_MS,
  type DeviceBlock,
  type DeviceBlockStatus,
  type DeviceSettings,
  type OpenPrompt,
  type Span,
  undoEntriesOf,
  type UndoEntry,
  type UndoToken,
} from "../models.js";
import { reconcileWeekIds, weekIdAt } from "../notifications/service.js";
import type { Clock, NotificationAction, NotificationPayload, Notifier } from "../ports.js";
import { coalesceOutbox, type DocWrite, type Repositories } from "../repositories.js";
import { allHolidays, type HolidayDates } from "./holidays.js";
import { planningBusy, weekOfId } from "./planning.js";

// --- Narrow dependencies ----------------------------------------------------------

/** Brings notifications in line with stored blocks (`NotificationService`). */
export interface BlockActionNotifications {
  reconcile(): Promise<unknown>;
}

/** Kicks an outbox flush (`SyncService`); never awaited. */
export interface BlockActionFlusher {
  flush(): Promise<unknown>;
}

export interface BlockActionServiceDeps {
  repos: Repositories;
  clock: Clock;
  /** Shows status notifications and dismisses tapped ones. */
  notifier: Notifier;
  notifications: BlockActionNotifications;
  /** When present, a flush is kicked after a calendar write is queued. */
  flusher?: BlockActionFlusher;
  /** When present, country holidays are avoided like days off (R30.2). */
  holidays?: HolidayDates;
}

// --- Inputs and results ----------------------------------------------------------------

/** Where a block lives (notification payloads carry both). */
export interface BlockRef {
  weekId: string;
  blockId: string;
}

export interface ActionOptions {
  /** The tapped notification, dismissed once the action is saved (R13.4). */
  notificationId?: string;
}

export interface PromptAnswerInput {
  /** `OpenPrompt.promptId` (also the prompt notification's id). */
  promptId: string;
  answer: PromptAnswer;
  /** The block's week, when the payload carries it; otherwise looked up. */
  weekId?: string;
}

/** What started a move. Only "prompt-yes" shows the "Moved to …" notification. */
export type MoveSource = "move-it" | "prompt-yes";

/** Side effects after the commit that failed; the saved state stands. */
export interface ActionErrors {
  notificationError?: string;
}

export type NotFound = { kind: "not-found" };

/** Outcome of {@link BlockActionService.saveNotes}. */
export type SaveNotesResult = { kind: "saved"; block: DeviceBlock } | NotFound;
export type StatusActionResult =
  | ({ kind: "updated"; block: DeviceBlock } & ActionErrors)
  | NotFound;

export type MoveResult =
  | ({ kind: "moved"; source: MoveSource; block: DeviceBlock; from: Slot; to: Slot } & ActionErrors)
  | ({
      kind: "nothing-fits";
      source: MoveSource;
      /** Unchanged. */
      block: DeviceBlock;
      alert: NothingFitsAlert;
    } & ActionErrors)
  | NotFound;

export interface UndoOptions {
  /** When given, Undo applies only if the active token is for this block. */
  blockId?: string;
  /** The tapped notification (the "Moved to …" Undo action), dismissed afterwards. */
  notificationId?: string;
}

/** Why an Undo did nothing. */
export type UndoRejection = "no-token" | "expired" | "other-block" | "not-found" | "moved-again";

export type UndoResult =
  | ({
      kind: "undone";
      block: DeviceBlock;
      restored: Slot;
      /** Every restored block (target first); present only for multi-block undos. */
      restoredBlocks?: DeviceBlock[];
    } & ActionErrors)
  | { kind: "rejected"; reason: UndoRejection };

export type PromptAnswerResult =
  | ({ kind: "declined"; prompt: OpenPrompt } & ActionErrors)
  | MoveResult;

/** Outcome of {@link BlockActionService.placeBlock}. */
export type Placement =
  | { kind: "moved"; slot: Slot }
  | { kind: "nothing-fits"; alert: NothingFitsAlert };

/** A shorter duration for "Shrink": 75%, 50%, or a custom number of minutes (≥ 15). */
export type ShrinkTo = "75%" | "50%" | { customMin: number };

/** The choice made on the nothing-fits screen (R2.3, R6.3). */
export type NothingFitsResolution =
  | { kind: "shrink"; to: ShrinkTo }
  | { kind: "drop" }
  | { kind: "roll" };

/** Why a resolution did nothing. */
export type NothingFitsRejection =
  /** Fitness blocks never roll (R8.1). */
  | "roll-not-offered"
  /** The shrunk duration is under 15 min or not shorter than the block. */
  | "invalid-duration"
  /** The block is already resolved (rolled, missed, done, partial). */
  | "not-open";

export type NothingFitsResult =
  | ({
      kind: "shrunk";
      block: DeviceBlock;
      from: Slot;
      to: Slot;
      durationMin: number;
    } & ActionErrors)
  | {
      /** The shorter span still doesn't fit; the block is unchanged (show the screen again). */
      kind: "nothing-fits";
      block: DeviceBlock;
      durationMin: number;
      alert: NothingFitsAlert;
    }
  | ({ kind: "dropped"; blockId: string; itemId: string } & ActionErrors)
  /** Fitness drop: the block stays, recorded as `missed` (R8.1). */
  | ({ kind: "missed"; block: DeviceBlock } & ActionErrors)
  | ({ kind: "rolled"; block: DeviceBlock; nextWeekId: string; item: IntakeItem } & ActionErrors)
  | { kind: "rejected"; reason: NothingFitsRejection }
  | NotFound;

/** Why a length change did nothing. */
export type LengthChangeRejection =
  /** Not 5..480 minutes (after rounding to 5) or not a number. */
  | "invalid-duration"
  /** Only `scheduled` blocks that have not started can change length. */
  | "not-editable"
  /** Already that long. */
  | "unchanged";

export type ChangeLengthResult =
  | ({
      kind: "resized";
      block: DeviceBlock;
      from: Slot;
      to: Slot;
      durationMin: number;
      /** True when the start changed because the new length did not fit in place. */
      moved: boolean;
    } & ActionErrors)
  | {
      /** No slot for the new length; the block is unchanged. */
      kind: "nothing-fits";
      block: DeviceBlock;
      durationMin: number;
      alert: NothingFitsAlert;
    }
  | { kind: "rejected"; reason: LengthChangeRejection }
  | NotFound;

/** Why a timing edit did nothing (R29.2). */
export type SetTimingRejection =
  /** Overlaps sleep, the Friday evening rule, a holiday, or the one-workout-a-day rule. */
  | "protected"
  /** Overlaps a calendar event (`detail` is its summary). */
  | "meeting"
  /** The task has started or is not `scheduled`, or the span overlaps one that is done/in progress/started. */
  | "started-block"
  /** The new start is before now. */
  | "past"
  /** Length not 5..480 minutes (after rounding to 5) or not a number. */
  | "invalid-duration"
  /** The start is not a valid instant. */
  | "invalid-start"
  /** The start is outside the task's Sunday-Saturday week. */
  | "wrong-week"
  /** Same start and length as now. */
  | "unchanged";

/** The new timing: a start instant (ISO) and, optionally, a new length. */
export interface TimingChange {
  start: string;
  durationMin?: number;
}

/** What the Undo offer covers (R29.3). */
export interface UndoInfo {
  /** epoch ms; Undo works while `now < expiresAt`. */
  expiresAt: number;
  /** Every block Undo restores, the target first. */
  blockIds: string[];
}

/** A displaced block's old and new slot. */
export interface MovedBlock {
  block: DeviceBlock;
  from: Span;
  to: Span;
}

export type SetTimingResult =
  | ({
      kind: "changed";
      /** The edited task, at its new time. */
      block: DeviceBlock;
      /** Displaced tasks (not the target), in start order. */
      moved: MovedBlock[];
      from: Span;
      to: Span;
      undo: UndoInfo;
    } & ActionErrors)
  | { kind: "rejected"; reason: SetTimingRejection; detail?: string }
  /** `block` is the displaced task that has no slot; nothing was changed. */
  | { kind: "nothing-fits"; block: DeviceBlock }
  | NotFound;

/** Reasons recorded on blocks moved by a timing edit. */
export const TIMING_MOVED_REASON = "Moved by you";
export const TIMING_DISPLACED_REASON = "Moved to make room";

/** Shortest and longest block length, minutes, and the step (R15.9). */
export const MIN_LENGTH_MIN = 5;
export const MAX_LENGTH_MIN = 480;
export const LENGTH_STEP_MIN = 5;

/** Reason recorded on a block that moved because its new length did not fit in place. */
export const LENGTH_MOVED_REASON = "Moved to fit new length";

/** `minutes` rounded to the nearest 5, or `null` when not a number or outside 5..480. */
export function normalizeLengthMin(minutes: number): number | null {
  if (typeof minutes !== "number" || !Number.isFinite(minutes)) return null;
  const rounded = Math.round(minutes / LENGTH_STEP_MIN) * LENGTH_STEP_MIN;
  return rounded >= MIN_LENGTH_MIN && rounded <= MAX_LENGTH_MIN ? rounded : null;
}

/** Only `scheduled` blocks that have not started (`now < start`) can change length. */
export function isLengthEditable(block: Pick<DeviceBlock, "status" | "start">, now: number): boolean {
  return block.status === "scheduled" && now < Date.parse(block.start);
}

// --- Pure helpers ----------------------------------------------------------------------

/** Reason recorded on a block moved by an action. */
export const MOVE_REASONS: Readonly<Record<MoveSource, string>> = Object.freeze({
  "move-it": "Moved by you",
  "prompt-yes": "You said you'd miss it",
});

export const NOTHING_FITS_TITLE = "Nothing fits this week";

/** The nothing-fits screen route for a block (R11.8, R13.13). */
export const nothingFitsDeepLink = (blockId: string): string =>
  `timeblocker://nothing-fits/${blockId}`;

export const nothingFitsNotificationId = (blockId: string): string =>
  `status:nothing-fits:${blockId}`;

/** The `status` notification shown when a move finds no slot (R13.13). */
export function nothingFitsPayload(block: DeviceBlock): NotificationPayload {
  return {
    id: nothingFitsNotificationId(block.id),
    kind: "status",
    channel: "status",
    title: NOTHING_FITS_TITLE,
    body: `"${block.title}" stays where it is. Tap to shrink, drop, or roll it.`,
    actions: [],
    sourceId: block.id,
    weekId: block.weekId,
    deepLink: nothingFitsDeepLink(block.id),
  };
}

// --- Nothing-fits helpers ---------------------------------------------------------------

/** The shortest a block may be shrunk to, minutes (R2.3). */
export const MIN_SHRINK_MIN = 15;

/** Reason recorded on a rolled block (R2.3, R9.3). */
export const ROLLED_REASON = "Didn't fit this week";

/** Reason recorded on a block moved by a successful shrink. */
export const SHRUNK_REASON = "Shortened to fit";

/** Statuses a nothing-fits resolution still applies to. */
const OPEN_STATUSES: readonly DeviceBlockStatus[] = ["scheduled", "in-progress", "skipped"];

/**
 * The options the nothing-fits screen offers for `block`: shrink, drop, and
 * roll to next week, except fitness, which never rolls (R8.1).
 */
export function nothingFitsOptionsFor(block: Pick<DeviceBlock, "category">): NothingFitsOption[] {
  return block.category === "fitness"
    ? ["shrink", "drop"]
    : ["shrink", "drop", "roll-to-next-week"];
}

/** Whole minutes between two ISO instants. */
export function spanMinutes(span: Span): number {
  return Math.round((Date.parse(span.end) - Date.parse(span.start)) / 60_000);
}

/**
 * The shrunk duration for a block of `currentMin` minutes, or `null` when the
 * choice is invalid. 75% / 50% round to whole minutes and never go below
 * {@link MIN_SHRINK_MIN}; a custom value must be a whole number ≥ 15. Either
 * way the result must be shorter than the block.
 */
export function shrinkDurationMin(currentMin: number, to: ShrinkTo): number | null {
  let minutes: number;
  if (to === "75%" || to === "50%") {
    const factor = to === "75%" ? 0.75 : 0.5;
    minutes = Math.max(MIN_SHRINK_MIN, Math.round(currentMin * factor));
  } else {
    minutes = to.customMin;
    if (!Number.isInteger(minutes) || minutes < MIN_SHRINK_MIN) return null;
  }
  return minutes < currentMin ? minutes : null;
}

/** The week after `weekId` (both YYYY-MM-DD Toronto Sundays). */
export function nextWeekIdOf(weekId: string): string {
  // Noon UTC Sunday + 7 days is the next Sunday morning in Toronto in every season.
  return weekIdAt(Date.parse(`${weekId}T12:00:00Z`) + 7 * 24 * 3_600_000);
}

/**
 * The confirmed item a roll adds to next week: the original item (full
 * duration) when it still exists, otherwise rebuilt from the block.
 */
export function rolledItemFor(
  block: DeviceBlock,
  original: IntakeItem | undefined,
  nextWeekId: string,
): IntakeItem {
  return {
    id: block.itemId,
    text: original?.text ?? block.title,
    durationMin: original?.durationMin ?? spanMinutes(block),
    priority: original?.priority ?? DEFAULT_PRIORITY,
    category: original?.category ?? block.category,
    confirmed: true,
    weekId: nextWeekId,
  };
}

/**
 * Busy time for moving `block`: cached non-🧱 events ∪ the other local
 * blocks that occupy time ∪ the block's original span (under a distinct id,
 * since the engine drops busy entries carrying the block's own id). The new
 * slot therefore never overlaps the time she said she'd miss.
 */
export function moveBusy(
  events: readonly CalendarEvent[],
  blocks: readonly DeviceBlock[],
  block: Pick<DeviceBlock, "id" | "start" | "end">,
): BusyEvent[] {
  const busy = planningBusy(
    events,
    blocks.filter((b) => b.id !== block.id),
  );
  busy.push({ id: `${block.id}#original`, start: block.start, end: block.end, withOthers: false });
  return busy;
}

export const UNDO_ACTION: Readonly<NotificationAction> = Object.freeze({ id: "undo", label: "Undo" });

export const movedNotificationId = (blockId: string): string => `status:moved:${blockId}`;

const WEEKDAY = new Intl.DateTimeFormat("en-US", { timeZone: TORONTO_TZ, weekday: "short" });
const CLOCK = new Intl.DateTimeFormat("en-US", {
  timeZone: TORONTO_TZ,
  hour: "numeric",
  minute: "2-digit",
});

/** "Tue 3:00 PM" in Toronto time. */
export function movedToLabel(instant: string): string {
  const d = new Date(instant);
  return `${WEEKDAY.format(d)} ${CLOCK.format(d)}`.replace(/\s/g, " ");
}

/** The token a move stores: restores `from` and `previousStatus` until `now + UNDO_WINDOW_MS`. */
export function undoTokenFor(
  before: DeviceBlock,
  weekId: string,
  movedTo: Slot,
  now: number,
): UndoToken {
  return {
    blockId: before.id,
    weekId,
    calendarEventId: before.calendarEventId,
    previous: { start: before.start, end: before.end },
    previousStatus: before.status,
    movedTo: { start: movedTo.start, end: movedTo.end },
    expiresAt: now + UNDO_WINDOW_MS,
  };
}

/**
 * Whether `token` can restore `block` at `now`: `now < expiresAt` and the
 * block is still at the moved-to slot. `null` when it can.
 */
export function undoRejection(
  token: UndoToken | null,
  block: DeviceBlock | undefined,
  now: number,
): UndoRejection | null {
  if (!token) return "no-token";
  if (now >= token.expiresAt) return "expired";
  if (!block) return "not-found";
  const same = (a: string, b: string) => Date.parse(a) === Date.parse(b);
  if (!same(block.start, token.movedTo.start) || !same(block.end, token.movedTo.end)) {
    return "moved-again";
  }
  return null;
}

/** The "Moved to …" `status` notification with an Undo action (R6.2). */
export function movedPayload(block: DeviceBlock): NotificationPayload {
  return {
    id: movedNotificationId(block.id),
    kind: "status",
    channel: "status",
    title: `Moved to ${movedToLabel(block.start)}`,
    body: `"${block.title}" has a new time. Tap Undo to put it back.`,
    actions: [UNDO_ACTION],
    sourceId: block.id,
    weekId: block.weekId,
    deepLink: `timeblocker://block/${block.id}`,
    timeoutMs: UNDO_WINDOW_MS,
  };
}

const errorMessage = (e: unknown) => (e instanceof Error ? e.message : String(e));

// --- Timing-edit helpers ------------------------------------------------------------------

/** Statuses of blocks that count against the one-workout-a-day rule. */
const WORKOUT_STATUSES: readonly DeviceBlockStatus[] = ["scheduled", "in-progress", "done", "partial"];

/** Not yet started: `scheduled` and `now < start`. Such blocks can be displaced. */
export const isDisplaceable = (b: Pick<DeviceBlock, "status" | "start">, now: number): boolean =>
  b.status === "scheduled" && now < Date.parse(b.start);

/** Occupies time but cannot be moved: in progress, done, partial, or already started. */
const isImmovable = (b: Pick<DeviceBlock, "status" | "start">, now: number): boolean =>
  !isDisplaceable(b, now) && (b.status === "scheduled" || b.status === "in-progress" || b.status === "done" || b.status === "partial");

const overlaps = (aStart: number, aEnd: number, bStart: number, bEnd: number): boolean =>
  aStart < bEnd && aEnd > bStart;

/** R3.9 (one workout a day) and R3.12 (no heavy work Friday from 17:00) for a start. */
function startAllowed(
  category: DeviceBlock["category"],
  startMs: number,
  workoutDays: ReadonlySet<string>,
): boolean {
  const start = new Date(startMs);
  if (category === "fitness" && workoutDays.has(torontoDateKey(start))) return false;
  if (category === "work" && torontoWeekday(start) === 5 && torontoMinutesOfDay(start) >= 17 * 60) {
    return false;
  }
  return true;
}

/** Toronto days that already hold a workout among `others`. */
function workoutDaysOf(others: readonly Pick<DeviceBlock, "category" | "start" | "status">[]): Set<string> {
  return new Set(
    others
      .filter((b) => b.category === "fitness" && WORKOUT_STATUSES.includes(b.status))
      .map((b) => torontoDateKey(new Date(b.start))),
  );
}

/**
 * Where a displaced block of `durationMs` goes, from the free `windows`:
 * 1. the nearest later slot (start at/after `originalStartMs`),
 * 2. else the nearest earlier slot (ending as close to the original start as possible),
 * 3. else the earliest slot anywhere in the windows.
 * Slots respect {@link startAllowed}. `null` when nothing fits.
 */
export function nearestSlot(
  category: DeviceBlock["category"],
  durationMs: number,
  windows: readonly FreeWindow[],
  originalStartMs: number,
  workoutDays: ReadonlySet<string>,
): Slot | null {
  const ws = windows
    .map((w) => ({ s: Date.parse(w.start), e: Date.parse(w.end) }))
    .sort((a, b) => a.s - b.s);
  const make = (s: number): Slot => ({
    start: new Date(s).toISOString(),
    end: new Date(s + durationMs).toISOString(),
  });
  for (const w of ws) {
    const s = Math.max(w.s, originalStartMs);
    if (s + durationMs <= w.e && startAllowed(category, s, workoutDays)) return make(s);
  }
  for (const w of [...ws].reverse()) {
    if (w.s >= originalStartMs) continue;
    const s = Math.min(w.e, originalStartMs) - durationMs;
    if (s >= w.s && startAllowed(category, s, workoutDays)) return make(s);
  }
  for (const w of ws) {
    if (w.e - w.s >= durationMs && startAllowed(category, w.s, workoutDays)) return make(w.s);
  }
  return null;
}

const REJECTION_TEXT: Readonly<Record<SetTimingRejection, string>> = {
  protected: "That time is protected (sleep, the Friday evening rule, a holiday, or one workout a day).",
  meeting: "That time overlaps a calendar event.",
  "started-block": "That time overlaps a task that has already started or is done.",
  past: "That time has already passed.",
  "invalid-duration": "Pick a length between 5 and 480 minutes.",
  "invalid-start": "Pick a valid start time.",
  "wrong-week": "Pick a day in this week.",
  unchanged: "The time is unchanged.",
};

/** "A", "A and B", "A, B and C". */
function joinTitles(titles: readonly string[]): string {
  if (titles.length <= 1) return titles.join("");
  return `${titles.slice(0, -1).join(", ")} and ${titles[titles.length - 1]}`;
}

/** The message for a timing edit (R29.3): "Moved <title>. Also moved <A> and <B>." */
export function describeSetTiming(result: SetTimingResult): string {
  switch (result.kind) {
    case "changed": {
      const base = `Moved ${result.block.title}.`;
      return result.moved.length === 0
        ? base
        : `${base} Also moved ${joinTitles(result.moved.map((m) => m.block.title))}.`;
    }
    case "nothing-fits":
      return `${result.block.title} would not fit this week, so nothing was changed.`;
    case "rejected":
      return result.reason === "meeting" && result.detail
        ? `That time overlaps ${result.detail}.`
        : REJECTION_TEXT[result.reason];
    case "not-found":
      return "That task is gone.";
  }
}

// --- Service ---------------------------------------------------------------------------

/** Loaded state for one block. */
interface BlockContext {
  weekId: string;
  blocks: DeviceBlock[];
  block: DeviceBlock;
}

export class BlockActionService {
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private readonly deps: BlockActionServiceDeps) {}

  /** "I'm in": status → `in-progress` (R13.4). */
  imIn(ref: BlockRef, options: ActionOptions = {}): Promise<StatusActionResult> {
    return this.serialize(() => this.setStatus(ref, "in-progress", options));
  }

  /** "Skip": status → `skipped` (R13.4). */
  skip(ref: BlockRef, options: ActionOptions = {}): Promise<StatusActionResult> {
    return this.serialize(() => this.setStatus(ref, "skipped", options));
  }

  /**
   * "Save to this task" (R34.6): store `notes` (cut to {@link MAX_BLOCK_NOTES_CHARS}) on the
   * block. Only the `notes` field changes: no outbox write, no reminder
   * reconcile, no Undo token. Empty text removes the notes.
   */
  saveNotes(ref: BlockRef, notes: string): Promise<SaveNotesResult> {
    return this.serialize(async () => {
      const ctx = await this.load(ref.blockId, ref.weekId);
      if (!ctx) return { kind: "not-found" };
      const { repos } = this.deps;
      const text = String(notes ?? "").slice(0, MAX_BLOCK_NOTES_CHARS);
      const { notes: _old, ...rest } = ctx.block;
      const block: DeviceBlock = text.length > 0 ? { ...rest, notes: text } : rest;
      await repos.commit([repos.blocks.write(ctx.weekId, replace(ctx.blocks, block))]);
      return { kind: "saved", block };
    });
  }
  /** "Move it": next valid slot this week, or nothing-fits (R13.4, R13.13). */
  moveIt(ref: BlockRef, options: ActionOptions = {}): Promise<MoveResult> {
    return this.serialize(async () => {
      const ctx = await this.load(ref.blockId, ref.weekId);
      if (!ctx) return this.notFound(options.notificationId);
      return this.relocate(ctx, "move-it", [], options.notificationId);
    });
  }

  /**
   * "Change length" (R15.9): set a scheduled, not-yet-started block to
   * `durationMin` (rounded to the nearest 5; 5..480).
   * - Same start, new end when the longer/shorter span stays inside the week
   *   and overlaps no other block or cached busy event.
   * - Otherwise the block is re-placed with the new length through
   *   {@link BlockActionService.placeBlock} (earliest free slot not before its
   *   start).
   * - Otherwise `nothing-fits`; the block is left unchanged.
   * A success stores one outbox upsert and the single Undo token in one commit,
   * then reconciles reminders and kicks a flush, like a move.
   */
  changeLength(
    ref: BlockRef,
    durationMin: number,
    options: ActionOptions = {},
  ): Promise<ChangeLengthResult> {
    return this.serialize(async () => {
      const ctx = await this.load(ref.blockId, ref.weekId);
      if (!ctx) return this.notFound(options.notificationId);
      const { repos, clock } = this.deps;
      const now = clock.now();
      const minutes = normalizeLengthMin(durationMin);
      if (minutes === null) return { kind: "rejected", reason: "invalid-duration" };
      if (!isLengthEditable(ctx.block, now)) return { kind: "rejected", reason: "not-editable" };
      if (minutes === spanMinutes(ctx.block)) return { kind: "rejected", reason: "unchanged" };

      const from: Slot = { start: ctx.block.start, end: ctx.block.end };
      const startMs = Date.parse(ctx.block.start);
      const resized: DeviceBlock = {
        ...ctx.block,
        end: new Date(startMs + minutes * 60_000).toISOString(),
      };

      let to: Slot = { start: resized.start, end: resized.end };
      let moved = false;
      const fitsInPlace = await this.fitsInPlace(ctx, resized, minutes < spanMinutes(ctx.block));
      if (!fitsInPlace) {
        const placement = await this.placeBlock(resized, ctx.blocks, now);
        if (placement.kind === "nothing-fits") {
          return { kind: "nothing-fits", block: ctx.block, durationMin: minutes, alert: placement.alert };
        }
        to = placement.slot;
        moved = true;
      }

      const block: DeviceBlock = {
        ...ctx.block,
        start: to.start,
        end: to.end,
        status: "scheduled",
        updatedAt: now,
        ...(moved ? { movedFrom: from, moveReason: LENGTH_MOVED_REASON } : {}),
      };
      const outbox = coalesceOutbox(await repos.outbox.get(), {
        blockId: block.id,
        calendarEventId: block.calendarEventId,
        op: "upsert",
        enqueuedAt: now,
      });
      await repos.commit([
        repos.blocks.write(ctx.weekId, replace(ctx.blocks, block)),
        repos.outbox.write(outbox),
        repos.undo.write(undoTokenFor(ctx.block, ctx.weekId, to, now)),
      ]);
      const errors = await this.reconcile();
      Object.assign(errors, await this.dismiss(options.notificationId));
      this.kickFlush();
      return { kind: "resized", block, from, to, durationMin: minutes, moved, ...errors };
    });
  }

  /**
   * Edit a task's timing from the plan summary (R29). The new span
   * [start, start + length) must be in the task's week, not in the past, and
   * clear of protected time and calendar events; it may overlap other
   * not-started tasks, which are re-placed one by one in start order (nearest
   * later slot, else nearest earlier, else any free slot of the week). If any
   * of them has no slot nothing is written. Success is one atomic commit of
   * all blocks, one coalesced outbox upsert per block, and one multi-block
   * Undo token; then reminders are reconciled and a flush is kicked.
   */
  setTiming(
    ref: BlockRef,
    change: TimingChange,
    options: ActionOptions = {},
  ): Promise<SetTimingResult> {
    return this.serialize(async () => {
      const ctx = await this.load(ref.blockId, ref.weekId);
      if (!ctx) return this.notFound(options.notificationId);
      const { repos, clock } = this.deps;
      const now = clock.now();
      const target = ctx.block;
      const rejected = (reason: SetTimingRejection, detail?: string): SetTimingResult => ({
        kind: "rejected",
        reason,
        ...(detail !== undefined ? { detail } : {}),
      });

      if (!isLengthEditable(target, now)) return rejected("started-block");
      const currentMin = spanMinutes(target);
      let minutes = currentMin;
      if (change.durationMin !== undefined) {
        const n = normalizeLengthMin(change.durationMin);
        if (n === null) return rejected("invalid-duration");
        minutes = n;
      }
      const startMs = Date.parse(change.start);
      if (!Number.isFinite(startMs)) return rejected("invalid-start");
      if (startMs < now) return rejected("past");
      const week = weekOfId(ctx.weekId);
      if (startMs < Date.parse(week.sunday) || startMs >= Date.parse(week.saturday)) {
        return rejected("wrong-week");
      }
      if (startMs === Date.parse(target.start) && minutes === currentMin) return rejected("unchanged");
      const endMs = startMs + minutes * 60_000;

      const [cache, settings] = await Promise.all([
        repos.calendarCache.get(ctx.weekId),
        repos.settings.get(),
      ]);
      const constraints: Constraints = {
        holidays: await allHolidays(settings.holidays, this.deps.holidays),
      };
      const inProtected = freeWindows(week, [], constraints).some(
        (w) => Date.parse(w.start) <= startMs && Date.parse(w.end) >= endMs,
      );
      if (!inProtected) return rejected("protected");

      const events = (cache?.events ?? []).filter((e) => e.isBlock !== true);
      const meeting = events.find((e) => overlaps(startMs, endMs, Date.parse(e.start), Date.parse(e.end)));
      if (meeting) return rejected("meeting", meeting.summary);

      const others = ctx.blocks.filter((b) => b.id !== target.id);
      if (
        others.some(
          (b) => isImmovable(b, now) && overlaps(startMs, endMs, Date.parse(b.start), Date.parse(b.end)),
        )
      ) {
        return rejected("started-block");
      }

      const displaced = others
        .filter(
          (b) => isDisplaceable(b, now) && overlaps(startMs, endMs, Date.parse(b.start), Date.parse(b.end)),
        )
        .sort((a, b) => Date.parse(a.start) - Date.parse(b.start) || a.id.localeCompare(b.id));
      const displacedIds = new Set(displaced.map((b) => b.id));
      const staying = others.filter((b) => !displacedIds.has(b.id));

      const newSpan: Span = { start: new Date(startMs).toISOString(), end: new Date(endMs).toISOString() };
      const targetAt = { category: target.category, start: newSpan.start, status: "scheduled" as const };
      if (!startAllowed(target.category, startMs, workoutDaysOf(staying))) return rejected("protected");

      // Place displaced blocks one by one; each placement becomes busy for the next.
      const busy: BusyEvent[] = events.map((e) => ({
        id: e.id,
        start: e.start,
        end: e.end,
        withOthers: e.withOthers,
      }));
      for (const b of staying) {
        if (isImmovable(b, now) || isDisplaceable(b, now)) {
          busy.push({ id: b.id, start: b.start, end: b.end, withOthers: false });
        }
      }
      busy.push({ id: target.id, start: newSpan.start, end: newSpan.end, withOthers: false });
      const occupied: Pick<DeviceBlock, "category" | "start" | "status">[] = [...staying, targetAt];

      const placed = new Map<string, Span>();
      for (const b of displaced) {
        const windows = freeWindows(week, busy, constraints, new Date(now));
        const slot = nearestSlot(
          b.category,
          Date.parse(b.end) - Date.parse(b.start),
          windows,
          Date.parse(b.start),
          workoutDaysOf(occupied),
        );
        if (!slot) return { kind: "nothing-fits", block: b };
        placed.set(b.id, slot);
        busy.push({ id: b.id, start: slot.start, end: slot.end, withOthers: false });
        occupied.push({ category: b.category, start: slot.start, status: "scheduled" });
      }

      // Build the new blocks and the undo entries (target first).
      const from: Span = { start: target.start, end: target.end };
      const startChanged = startMs !== Date.parse(target.start);
      const newTarget: DeviceBlock = {
        ...target,
        start: newSpan.start,
        end: newSpan.end,
        updatedAt: now,
        ...(startChanged ? { movedFrom: from, moveReason: TIMING_MOVED_REASON } : {}),
      };
      const changed = new Map<string, DeviceBlock>([[target.id, newTarget]]);
      const moved: MovedBlock[] = [];
      for (const b of displaced) {
        const to = placed.get(b.id)!;
        const next: DeviceBlock = {
          ...b,
          start: to.start,
          end: to.end,
          updatedAt: now,
          movedFrom: { start: b.start, end: b.end },
          moveReason: TIMING_DISPLACED_REASON,
        };
        changed.set(b.id, next);
        moved.push({ block: next, from: { start: b.start, end: b.end }, to });
      }
      const entryFor = (before: DeviceBlock, after: DeviceBlock): UndoEntry => ({
        blockId: before.id,
        weekId: ctx.weekId,
        calendarEventId: before.calendarEventId,
        previous: { start: before.start, end: before.end },
        previousStatus: before.status,
        ...(before.movedFrom ? { previousMovedFrom: before.movedFrom } : {}),
        ...(before.moveReason !== undefined ? { previousMoveReason: before.moveReason } : {}),
        movedTo: { start: after.start, end: after.end },
      });
      const entries = [target, ...displaced].map((b) => entryFor(b, changed.get(b.id)!));
      const expiresAt = now + UNDO_WINDOW_MS;
      const first = entries[0]!;
      const token: UndoToken = {
        blockId: first.blockId,
        weekId: first.weekId,
        calendarEventId: first.calendarEventId,
        previous: first.previous,
        previousStatus: first.previousStatus,
        movedTo: first.movedTo,
        expiresAt,
        entries,
      };

      let outbox = await repos.outbox.get();
      for (const b of changed.values()) {
        outbox = coalesceOutbox(outbox, {
          blockId: b.id,
          calendarEventId: b.calendarEventId,
          op: "upsert",
          enqueuedAt: now,
        });
      }
      await repos.commit([
        repos.blocks.write(
          ctx.weekId,
          ctx.blocks.map((b) => changed.get(b.id) ?? b),
        ),
        repos.outbox.write(outbox),
        repos.undo.write(token),
      ]);

      const errors = await this.reconcile();
      Object.assign(errors, await this.dismiss(options.notificationId));
      this.kickFlush();
      return {
        kind: "changed",
        block: newTarget,
        moved,
        from,
        to: newSpan,
        undo: { expiresAt, blockIds: entries.map((e) => e.blockId) },
        ...errors,
      };
    });
  }

  /** Whether `resized` (same start, new end) stays in the week and clear of other busy time. */
  private async fitsInPlace(
    ctx: BlockContext,
    resized: DeviceBlock,
    shrinking: boolean,
  ): Promise<boolean> {
    if (shrinking) return true;
    const week = weekOfId(ctx.weekId);
    const endMs = Date.parse(resized.end);
    if (endMs > Date.parse(week.saturday)) return false;
    const cache = await this.deps.repos.calendarCache.get(ctx.weekId);
    const busy = planningBusy(
      cache?.events ?? [],
      ctx.blocks.filter((b) => b.id !== ctx.block.id),
    );
    const startMs = Date.parse(resized.start);
    return !busy.some((b) => Date.parse(b.start) < endMs && Date.parse(b.end) > startMs);
  }

  /**
   * Yes/No on "Will you miss this block?". The prompt leaves `openPrompts` in
   * the same commit as any move. An unknown prompt (already answered) changes
   * nothing, so a repeated tap can't move the block twice.
   */
  answerPrompt(input: PromptAnswerInput): Promise<PromptAnswerResult> {
    return this.serialize(async () => {
      const prompts = await this.deps.repos.openPrompts.get();
      const prompt = prompts.find((p) => p.promptId === input.promptId);
      if (!prompt) return this.notFound(input.promptId);
      const remaining = prompts.filter((p) => p.promptId !== input.promptId);
      const promptWrite = this.deps.repos.openPrompts.write(remaining);

      const ctx =
        input.answer === "yes" ? await this.load(prompt.blockId, input.weekId) : null;
      if (!ctx) {
        // "No" (R13.12), or a "Yes" whose block is gone: only the prompt goes.
        await this.deps.repos.commit([promptWrite]);
        const errors = await this.dismiss(input.promptId);
        if (input.answer === "yes") return { kind: "not-found" };
        return { kind: "declined", prompt, ...errors };
      }
      return this.relocate(ctx, "prompt-yes", [promptWrite], input.promptId);
    });
  }

  /**
   * Undo the last move (R6.2, R11.9). Valid only while `now < expiresAt` and
   * the block is still at the moved-to slot: restores the previous
   * start/end/status, clears the token, and enqueues an upsert in one commit,
   * then reconciles reminders and flushes. Otherwise nothing is stored.
   */
  undo(options: UndoOptions = {}): Promise<UndoResult> {
    return this.serialize(async () => {
      const { repos, clock } = this.deps;
      const now = clock.now();
      const token = await repos.undo.get();
      const reject = async (reason: UndoRejection): Promise<UndoResult> => {
        await this.dismiss(options.notificationId);
        return { kind: "rejected", reason };
      };
      if (!token) return reject("no-token");
      // Old single-block tokens read as one entry (R29.3 migration).
      const entries = undoEntriesOf(token);
      if (options.blockId && !entries.some((e) => e.blockId === options.blockId)) {
        return reject("other-block");
      }
      const ctx = now < token.expiresAt ? await this.load(token.blockId, token.weekId) : null;
      const rejection = undoRejection(token, ctx?.block, now);
      if (rejection || !ctx) return reject(rejection ?? "not-found");

      // Every entry must still be where the action put it, or nothing is undone.
      const weeks = new Map<string, DeviceBlock[]>([[ctx.weekId, ctx.blocks]]);
      for (const e of entries) {
        if (!weeks.has(e.weekId)) weeks.set(e.weekId, await repos.blocks.get(e.weekId));
        const current = weeks.get(e.weekId)!.find((b) => b.id === e.blockId);
        if (!current) return reject("not-found");
        const same = (a: string, b: string) => Date.parse(a) === Date.parse(b);
        if (!same(current.start, e.movedTo.start) || !same(current.end, e.movedTo.end)) {
          return reject("moved-again");
        }
      }

      const restoredBlocks: DeviceBlock[] = [];
      let outbox = await repos.outbox.get();
      for (const e of entries) {
        const list = weeks.get(e.weekId)!;
        const current = list.find((b) => b.id === e.blockId)!;
        const { movedFrom: _from, moveReason: _reason, ...rest } = current;
        const restoredBlock: DeviceBlock = {
          ...rest,
          start: e.previous.start,
          end: e.previous.end,
          status: e.previousStatus,
          updatedAt: now,
          ...(e.previousMovedFrom ? { movedFrom: e.previousMovedFrom } : {}),
          ...(e.previousMoveReason !== undefined ? { moveReason: e.previousMoveReason } : {}),
        };
        weeks.set(e.weekId, replace(list, restoredBlock));
        restoredBlocks.push(restoredBlock);
        outbox = coalesceOutbox(outbox, {
          blockId: restoredBlock.id,
          calendarEventId: restoredBlock.calendarEventId,
          op: "upsert",
          enqueuedAt: now,
        });
      }
      await repos.commit([
        ...[...weeks].map(([weekId, list]) => repos.blocks.write(weekId, list)),
        repos.outbox.write(outbox),
        repos.undo.write(null),
      ]);
      const block = restoredBlocks[0]!;

      const errors = await this.reconcile();
      // The "Moved to …" notification goes, as does any other tapped one.
      for (const id of new Set([
        ...restoredBlocks.map((b) => movedNotificationId(b.id)),
        options.notificationId,
      ])) {
        const dismissed = await this.dismiss(id);
        errors.notificationError ??= dismissed.notificationError;
      }
      if (errors.notificationError === undefined) delete errors.notificationError;
      this.kickFlush();
      return {
        kind: "undone",
        block,
        restored: entries[0]!.previous,
        ...(restoredBlocks.length > 1 ? { restoredBlocks } : {}),
        ...errors,
      };
    });
  }

  /**
   * Find a slot for `block` (its own start/end define the duration) in its
   * week, from local blocks and the calendar cache only. Reused by the
   * nothing-fits "shrink" retry (20.3).
   */
  async placeBlock(
    block: DeviceBlock,
    blocks: readonly DeviceBlock[],
    now: number,
    settings?: DeviceSettings,
  ): Promise<Placement> {
    const { repos } = this.deps;
    const [cache, s] = await Promise.all([
      repos.calendarCache.get(block.weekId),
      settings ? Promise.resolve(settings) : repos.settings.get(),
    ]);
    return computeReschedule({
      block,
      week: weekOfId(block.weekId),
      busy: moveBusy(cache?.events ?? [], blocks, block),
      constraints: { holidays: await allHolidays(s.holidays, this.deps.holidays) },
      now: new Date(now).toISOString(),
    });
  }

  /**
   * Resolve a block that fits nowhere this week (R2.3, R6.3, R8.1):
   * - shrink: retry {@link placeBlock} with the shorter span. Fits → new
   *   start/end, status `scheduled`, one outbox upsert, reconcile. Still no
   *   fit → nothing stored (the screen is shown again).
   * - drop: remove the block and its item, enqueue a delete. Fitness keeps
   *   the block as `missed` instead (R8.1).
   * - roll: delete this week's event, keep the block as `rolled` ("Didn't
   *   fit this week"), and add the item, confirmed, to `items:<nextWeekId>`.
   *   Not offered for fitness (R8.1).
   * Each outcome is one atomic commit; the nothing-fits notification (and
   * any tapped one) is dismissed once a resolution is saved.
   */
  resolveNothingFits(
    ref: BlockRef,
    resolution: NothingFitsResolution,
    options: ActionOptions = {},
  ): Promise<NothingFitsResult> {
    return this.serialize(async () => {
      const ctx = await this.load(ref.blockId, ref.weekId);
      if (!ctx) return { kind: "not-found" };
      if (!OPEN_STATUSES.includes(ctx.block.status)) return { kind: "rejected", reason: "not-open" };
      switch (resolution.kind) {
        case "shrink":
          return this.shrink(ctx, resolution.to, options);
        case "drop":
          return this.drop(ctx, options);
        case "roll":
          return this.roll(ctx, options);
      }
    });
  }

  // --- internals -----------------------------------------------------------------------

  private serialize<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn);
    this.chain = run.catch(() => undefined);
    return run;
  }

  private async setStatus(
    ref: BlockRef,
    status: DeviceBlockStatus,
    options: ActionOptions,
  ): Promise<StatusActionResult> {
    const ctx = await this.load(ref.blockId, ref.weekId);
    if (!ctx) return this.notFound(options.notificationId);
    const { repos, clock } = this.deps;
    if (ctx.block.status === status) {
      return { kind: "updated", block: ctx.block, ...(await this.dismiss(options.notificationId)) };
    }
    const block: DeviceBlock = { ...ctx.block, status, updatedAt: clock.now() };
    await repos.commit([repos.blocks.write(ctx.weekId, replace(ctx.blocks, block))]);
    const errors = await this.reconcile();
    Object.assign(errors, await this.dismiss(options.notificationId));
    return { kind: "updated", block, ...errors };
  }

  /**
   * The shared move for "Move it" and "Yes". `extraWrites` (e.g. the
   * `openPrompts` update) land in the same atomic commit as the move, or
   * alone when nothing fits.
   */
  private async relocate(
    ctx: BlockContext,
    source: MoveSource,
    extraWrites: DocWrite[],
    notificationId: string | undefined,
  ): Promise<MoveResult> {
    const { repos, clock, notifier } = this.deps;
    const now = clock.now();
    const placement = await this.placeBlock(ctx.block, ctx.blocks, now);

    if (placement.kind === "nothing-fits") {
      // R13.13: the block keeps its time and status.
      await repos.commit(extraWrites);
      const errors = await this.dismiss(notificationId);
      try {
        await notifier.showNow(nothingFitsPayload(ctx.block));
      } catch (error) {
        errors.notificationError ??= errorMessage(error);
      }
      return { kind: "nothing-fits", source, block: ctx.block, alert: placement.alert, ...errors };
    }

    const from: Slot = { start: ctx.block.start, end: ctx.block.end };
    const to = placement.slot;
    const block: DeviceBlock = {
      ...ctx.block,
      start: to.start,
      end: to.end,
      status: "scheduled",
      movedFrom: from,
      moveReason: MOVE_REASONS[source],
      updatedAt: now,
    };
    const outbox = coalesceOutbox(await repos.outbox.get(), {
      blockId: block.id,
      calendarEventId: block.calendarEventId,
      op: "upsert",
      enqueuedAt: now,
    });
    const writes: DocWrite[] = [
      repos.blocks.write(ctx.weekId, replace(ctx.blocks, block)),
      repos.outbox.write(outbox),
      ...extraWrites,
      // R11.9, R6.2: the single active Undo, replacing any earlier one.
      repos.undo.write(undoTokenFor(ctx.block, ctx.weekId, to, now)),
    ];
    await repos.commit(writes);

    const errors = await this.reconcile();
    Object.assign(errors, await this.dismiss(notificationId));
    if (source === "prompt-yes") {
      try {
        await notifier.showNow(movedPayload(block));
      } catch (error) {
        errors.notificationError ??= errorMessage(error);
      }
    }
    this.kickFlush();
    return { kind: "moved", source, block, from, to, ...errors };
  }

  private async shrink(
    ctx: BlockContext,
    to: ShrinkTo,
    options: ActionOptions,
  ): Promise<NothingFitsResult> {
    const { repos, clock } = this.deps;
    const durationMin = shrinkDurationMin(spanMinutes(ctx.block), to);
    if (durationMin === null) return { kind: "rejected", reason: "invalid-duration" };
    const now = clock.now();
    const shorter: DeviceBlock = {
      ...ctx.block,
      end: new Date(Date.parse(ctx.block.start) + durationMin * 60_000).toISOString(),
    };
    const placement = await this.placeBlock(shorter, ctx.blocks, now);
    if (placement.kind === "nothing-fits") {
      return { kind: "nothing-fits", block: ctx.block, durationMin, alert: placement.alert };
    }

    const from: Slot = { start: ctx.block.start, end: ctx.block.end };
    const slot = placement.slot;
    const block: DeviceBlock = {
      ...ctx.block,
      start: slot.start,
      end: slot.end,
      status: "scheduled",
      movedFrom: from,
      moveReason: SHRUNK_REASON,
      updatedAt: now,
    };
    const outbox = coalesceOutbox(await repos.outbox.get(), {
      blockId: block.id,
      calendarEventId: block.calendarEventId,
      op: "upsert",
      enqueuedAt: now,
    });
    await repos.commit([
      repos.blocks.write(ctx.weekId, replace(ctx.blocks, block)),
      repos.outbox.write(outbox),
      ...(await this.clearUndoFor(block.id)),
    ]);
    const errors = await this.afterResolution(block.id, options);
    return { kind: "shrunk", block, from, to: slot, durationMin, ...errors };
  }

  private async drop(ctx: BlockContext, options: ActionOptions): Promise<NothingFitsResult> {
    const { repos, clock } = this.deps;
    const now = clock.now();
    const fitness = ctx.block.category === "fitness";
    const outbox = coalesceOutbox(await repos.outbox.get(), {
      blockId: ctx.block.id,
      calendarEventId: ctx.block.calendarEventId,
      op: "delete",
      enqueuedAt: now,
    });
    const common = [
      repos.outbox.write(outbox),
      ...(await this.clearUndoFor(ctx.block.id)),
      ...(await this.clearPromptsFor(ctx.block.id)),
    ];

    if (fitness) {
      // R8.1: a dropped workout is recorded as missed, never rolled.
      const block: DeviceBlock = this.withoutEvent(ctx.block, "missed", now);
      await repos.commit([repos.blocks.write(ctx.weekId, replace(ctx.blocks, block)), ...common]);
      const errors = await this.afterResolution(block.id, options);
      return { kind: "missed", block, ...errors };
    }

    // The item goes too, so a later planning pass doesn't place it again.
    const items = await repos.items.get(ctx.weekId);
    await repos.commit([
      repos.blocks.write(ctx.weekId, ctx.blocks.filter((b) => b.id !== ctx.block.id)),
      repos.items.write(ctx.weekId, items.filter((i) => i.id !== ctx.block.itemId)),
      ...common,
    ]);
    const errors = await this.afterResolution(ctx.block.id, options);
    return { kind: "dropped", blockId: ctx.block.id, itemId: ctx.block.itemId, ...errors };
  }

  private async roll(ctx: BlockContext, options: ActionOptions): Promise<NothingFitsResult> {
    if (!nothingFitsOptionsFor(ctx.block).includes("roll-to-next-week")) {
      return { kind: "rejected", reason: "roll-not-offered" };
    }
    const { repos, clock } = this.deps;
    const now = clock.now();
    const nextWeekId = nextWeekIdOf(ctx.weekId);
    const [thisWeekItems, nextWeekItems, current] = await Promise.all([
      repos.items.get(ctx.weekId),
      repos.items.get(nextWeekId),
      repos.outbox.get(),
    ]);
    const item = rolledItemFor(
      ctx.block,
      thisWeekItems.find((i) => i.id === ctx.block.itemId),
      nextWeekId,
    );
    const block: DeviceBlock = {
      ...this.withoutEvent(ctx.block, "rolled", now),
      moveReason: ROLLED_REASON,
    };
    const outbox = coalesceOutbox(current, {
      blockId: block.id,
      calendarEventId: block.calendarEventId,
      op: "delete",
      enqueuedAt: now,
    });
    await repos.commit([
      repos.blocks.write(ctx.weekId, replace(ctx.blocks, block)),
      repos.items.write(nextWeekId, [...nextWeekItems.filter((i) => i.id !== item.id), item]),
      repos.outbox.write(outbox),
      ...(await this.clearUndoFor(block.id)),
      ...(await this.clearPromptsFor(block.id)),
    ]);
    const errors = await this.afterResolution(block.id, options);
    return { kind: "rolled", block, nextWeekId, item, ...errors };
  }

  /**
   * A block kept after its event is deleted: new status, not
   * `calendarSynced`, so sync reconciliation never treats the deleted event
   * as a removal in Google.
   */
  private withoutEvent(block: DeviceBlock, status: DeviceBlockStatus, now: number): DeviceBlock {
    return { ...block, status, calendarSynced: false, updatedAt: now };
  }

  /** Clears the Undo token when it is for `blockId`. */
  private async clearUndoFor(blockId: string): Promise<DocWrite[]> {
    const token = await this.deps.repos.undo.get();
    return token && undoEntriesOf(token).some((e) => e.blockId === blockId)
      ? [this.deps.repos.undo.write(null)]
      : [];
  }

  /** Drops open prompts for `blockId` (the block no longer occupies time). */
  private async clearPromptsFor(blockId: string): Promise<DocWrite[]> {
    const prompts = await this.deps.repos.openPrompts.get();
    const remaining = prompts.filter((p) => p.blockId !== blockId);
    return remaining.length === prompts.length ? [] : [this.deps.repos.openPrompts.write(remaining)];
  }

  /** Reconcile, dismiss the nothing-fits and tapped notifications, flush. */
  private async afterResolution(blockId: string, options: ActionOptions): Promise<ActionErrors> {
    const errors = await this.reconcile();
    for (const id of new Set([nothingFitsNotificationId(blockId), options.notificationId])) {
      const dismissed = await this.dismiss(id);
      errors.notificationError ??= dismissed.notificationError;
    }
    if (errors.notificationError === undefined) delete errors.notificationError;
    this.kickFlush();
    return errors;
  }

  /**
   * Load a block by id: from `weekIdHint` when given, otherwise the previous,
   * current, and next week around now.
   */
  private async load(blockId: string, weekIdHint?: string): Promise<BlockContext | null> {
    const now = this.deps.clock.now();
    const weekIds = weekIdHint
      ? [weekIdHint]
      : [...new Set([weekIdAt(now - 7 * 24 * 3_600_000), ...reconcileWeekIds(now)])];
    for (const weekId of weekIds) {
      const blocks = await this.deps.repos.blocks.get(weekId);
      const block = blocks.find((b) => b.id === blockId);
      if (block) return { weekId, blocks, block };
    }
    return null;
  }

  private async notFound(notificationId: string | undefined): Promise<NotFound> {
    await this.dismiss(notificationId);
    return { kind: "not-found" };
  }

  /** Reconcile reminders; a failure is reported, the saved state stands. */
  private async reconcile(): Promise<ActionErrors> {
    try {
      await this.deps.notifications.reconcile();
      return {};
    } catch (error) {
      return { notificationError: errorMessage(error) };
    }
  }

  /** Dismiss the tapped notification (R13.4, R13.12); best effort. */
  private async dismiss(notificationId: string | undefined): Promise<ActionErrors> {
    if (!notificationId) return {};
    try {
      await this.deps.notifier.cancel(notificationId);
      return {};
    } catch (error) {
      return { notificationError: errorMessage(error) };
    }
  }

  /** Fire and forget: the outbox keeps the write if this flush fails. */
  private kickFlush(): void {
    this.deps.flusher?.flush().catch(() => undefined);
  }
}

function replace(blocks: readonly DeviceBlock[], block: DeviceBlock): DeviceBlock[] {
  return blocks.map((b) => (b.id === block.id ? block : b));
}
