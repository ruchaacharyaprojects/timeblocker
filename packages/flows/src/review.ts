/**
 * Saturday review + Sunday planning nudge orchestration (R8, R9) — pure of
 * AWS/Google specifics.
 *
 * Moved from `packages/infra/lambda/scheduler/review.ts` into
 * `@timeblocker/flows`. Everything that touches the network or AWS lives
 * behind a small injected port.
 *
 * Two behaviors live here:
 *
 *   1. {@link buildWeeklyReview} / {@link runSaturdayReview} — compile the
 *      week's blocks into finished / partly-finished / missed, fold in the
 *      screen-time and distraction-level summary signals (R9.1, R9.2), list
 *      what moved to next week and why (R9.3), and carry the prompt to paste
 *      or type next week's list (R9.4). Fitness blocks that never happened
 *      are counted as missed and are NOT rolled into the next Sunday (R8.1).
 *      The compiled {@link WeeklyReview} is persisted to the reviews table.
 *
 *   2. {@link runSundayPlanningNudge} — deliver the Sunday morning nudge to
 *      plan the week (R9), through the injected notification port.
 */

import { weekBounds, type Week } from "@timeblocker/scheduling-engine";
import type { Category } from "@timeblocker/scheduling-engine";
import type { DistractionLevel, UsageSummary } from "@timeblocker/usage-metrics";
import type { BlockStatus, PersistedBlock } from "./block.js";

export type { BlockStatus, PersistedBlock };

// --- The WeeklyReview model (design.md) ------------------------------------

/** A finished / partly-finished / missed entry in the review. */
export interface ReviewEntry {
  blockId: string;
  itemId: string;
  title: string;
  category: Category;
  start: string;
  end: string;
}

/** A "moved to next week" entry, carrying the reason it moved (R9.3). */
export interface MovedEntry extends ReviewEntry {
  /** Why it moved. Falls back to a generic reason when none was recorded. */
  reason: string;
}

/**
 * The weekly review (design.md WeeklyReview). `finished` / `partial` /
 * `missed` are the week's blocks classified by outcome (R9.1); `screenTimeMin`
 * and `distractionLevel` are the on-device usage summary signals (R9.2);
 * `movedToNextWeek` is what moved and why (R9.3); `photoPrompt` carries the
 * prompt to paste or type next week's list (R9.4). The field keeps its
 * original name for API compatibility.
 */
export interface WeeklyReview {
  weekId: string;
  finished: ReviewEntry[];
  partial: ReviewEntry[];
  missed: ReviewEntry[];
  screenTimeMin: number;
  distractionLevel: DistractionLevel;
  movedToNextWeek: MovedEntry[];
  /** The prompt to paste or type next week's to-do list (R9.4). */
  photoPrompt: string;
  /** How many fitness blocks were marked missed because they never happened. */
  fitnessMissedCount: number;
}

/**
 * The copy shown to prompt for next week's list (R9.4). The constant keeps its
 * original name so existing importers keep compiling; the copy is now
 * paste/type wording.
 */
export const NEXT_WEEK_PHOTO_PROMPT = "Paste or type next week's to-do list";

/** Alias of {@link NEXT_WEEK_PHOTO_PROMPT} with a name matching the copy. */
export const NEXT_WEEK_LIST_PROMPT = NEXT_WEEK_PHOTO_PROMPT;

/** The Sunday morning nudge copy (R9). */
export const SUNDAY_NUDGE_TITLE = "Plan your week";
export const SUNDAY_NUDGE_BODY =
  "It's Sunday — paste or type this week's to-do list and plan your blocks.";

// --- Injected ports --------------------------------------------------------

/** Reads the full persisted blocks for a week (DynamoDB blocks table). */
export interface ReviewBlocksReader {
  readWeekBlocks(weekId: string): Promise<PersistedBlock[]>;
}

/** Persists a block whose status changed during the review (fitness-missed). */
export interface ReviewBlocksWriter {
  saveBlock(block: PersistedBlock): Promise<void>;
}

/** Persists the compiled weekly review (DynamoDB reviews table). */
export interface ReviewWriter {
  saveReview(review: WeeklyReview): Promise<void>;
}

/**
 * Reads the week's on-device usage summary signal (screen time + distraction
 * level). Only the aggregate {@link UsageSummary} ever leaves the device
 * (R7.3); the backend reads it here to show it in the review (R9.2). Returns
 * null when no summary was reported for the week.
 */
export interface UsageSummaryReader {
  readWeekSummary(weekId: string): Promise<UsageSummary | null>;
}

/** A plain planning-nudge notification (no actionable buttons). */
export interface NudgeNotification {
  id: string;
  title: string;
  body: string;
}

/** Delivers the Sunday planning nudge (push). Tests inject a recording fake. */
export interface NudgePort {
  deliver(notification: NudgeNotification): Promise<void>;
}

// --- Helpers ---------------------------------------------------------------

/** Stable week id: the ISO date (YYYY-MM-DD) of the week's Sunday. */
export function weekIdOf(week: Week): string {
  return week.sunday.slice(0, 10);
}

function blockTitle(block: PersistedBlock): string {
  return block.title ?? block.text ?? "Block";
}

function toEntry(block: PersistedBlock): ReviewEntry {
  return {
    blockId: block.id,
    itemId: block.itemId,
    title: blockTitle(block),
    category: block.category,
    start: block.start,
    end: block.end,
  };
}

/** Fallback reason for a `rolled` block with no recorded reason (R2.3). */
export const ROLLED_DEFAULT_REASON = "Didn't fit this week";
/** Fallback reason for a legacy `moved` block with no recorded reason. */
export const MOVED_DEFAULT_REASON = "Moved to the next valid slot this week.";

function toMovedEntry(block: PersistedBlock): MovedEntry {
  const fallback =
    block.status === "rolled" ? ROLLED_DEFAULT_REASON : MOVED_DEFAULT_REASON;
  return {
    ...toEntry(block),
    reason: block.moveReason ?? fallback,
  };
}

/** Whether the block's window has fully passed as of `now`. */
function hasEnded(block: PersistedBlock, now: Date): boolean {
  return new Date(block.end).getTime() <= now.getTime();
}

// --- Review build (pure) ---------------------------------------------------

/**
 * Compile a week's blocks and usage summary into a {@link WeeklyReview}
 * (R9.1-R9.4, R8.1).
 *
 * Classification by block status (design.md Review mapping):
 *   - `done`                         -> finished
 *   - `in-progress` whose end passed -> finished (she said "I'm in")
 *   - `partial`                      -> partly finished
 *   - `missed`                       -> missed
 *   - `skipped`                      -> missed
 *   - `scheduled` whose end passed   -> missed (never happened)
 *   - `rolled` / legacy `moved`      -> movedToNextWeek (with reason, R9.3)
 *   - `scheduled` / `in-progress` still in the future -> not yet classified
 *
 * Fitness blocks never land in `movedToNextWeek` (R8.1: workouts don't roll
 * into next Sunday). A fitness block that is skipped, never happened, or was
 * rolled/moved is counted as missed and returned in `fitnessMissed` with
 * status "missed" so the caller can persist it. A fitness block already
 * persisted as `missed` needs no write and is not returned there.
 *
 * Non-fitness blocks that never happened or were skipped are surfaced as
 * missed for the review (R9.1) but are not rewritten.
 *
 * Pure: no clock reads (now is injected), no I/O.
 */
export function buildWeeklyReview(
  weekId: string,
  blocks: readonly PersistedBlock[],
  usage: UsageSummary | null,
  now: Date,
): { review: WeeklyReview; fitnessMissed: PersistedBlock[] } {
  const finished: ReviewEntry[] = [];
  const partial: ReviewEntry[] = [];
  const missed: ReviewEntry[] = [];
  const movedToNextWeek: MovedEntry[] = [];
  const fitnessMissed: PersistedBlock[] = [];

  /**
   * Count a block as missed. Fitness blocks are also flagged so the caller
   * persists them as "missed" and they never roll into next Sunday (R8.1).
   */
  const markMissed = (block: PersistedBlock): void => {
    const missedBlock: PersistedBlock = { ...block, status: "missed" };
    missed.push(toEntry(missedBlock));
    if (block.category === "fitness") {
      fitnessMissed.push(missedBlock);
    }
  };

  for (const block of blocks) {
    switch (block.status) {
      case "done":
        finished.push(toEntry(block));
        break;
      case "in-progress":
        // She tapped "I'm in"; once the window has passed it counts as done.
        if (hasEnded(block, now)) finished.push(toEntry(block));
        break;
      case "partial":
        partial.push(toEntry(block));
        break;
      case "missed":
        missed.push(toEntry(block));
        break;
      case "skipped":
        markMissed(block);
        break;
      case "rolled":
      case "moved":
        if (block.category === "fitness") {
          // Workouts never roll into next week (R8.1).
          markMissed(block);
        } else {
          movedToNextWeek.push(toMovedEntry(block));
        }
        break;
      case "scheduled":
        // Never happened within its week -> counted as missed (R9.1).
        if (hasEnded(block, now)) markMissed(block);
        break;
      default:
        break;
    }
  }

  const review: WeeklyReview = {
    weekId,
    finished,
    partial,
    missed,
    screenTimeMin: usage?.totalScreenTimeMin ?? 0,
    distractionLevel: usage?.distractionLevel ?? "low",
    movedToNextWeek,
    photoPrompt: NEXT_WEEK_PHOTO_PROMPT,
    fitnessMissedCount: fitnessMissed.length,
  };

  return { review, fitnessMissed };
}

// --- Orchestration ---------------------------------------------------------

export interface SaturdayReviewDeps {
  blocks: ReviewBlocksReader;
  blocksWriter: ReviewBlocksWriter;
  reviews: ReviewWriter;
  usage: UsageSummaryReader;
}

export interface SaturdayReviewRequest {
  /** Current instant (defaults to `now`). */
  now?: string;
  /** Any instant inside the week to review (defaults to `now`). */
  weekOf?: string;
}

/**
 * Run the Saturday review (R8.1, R9.1-R9.4):
 *   1. resolve the current Sunday-Saturday week (America/Toronto),
 *   2. read the week's blocks and the on-device usage summary,
 *   3. compile the {@link WeeklyReview},
 *   4. persist any fitness block that never happened as "missed" so it stays
 *      in its own week and does not roll over (R8.1), and
 *   5. persist the review to the reviews table.
 */
export async function runSaturdayReview(
  request: SaturdayReviewRequest,
  deps: SaturdayReviewDeps,
): Promise<WeeklyReview> {
  const nowIso = request.now ?? new Date().toISOString();
  const now = new Date(nowIso);
  const week = weekBounds(request.weekOf ?? nowIso);
  const weekId = weekIdOf(week);

  const [blocks, usage] = await Promise.all([
    deps.blocks.readWeekBlocks(weekId),
    deps.usage.readWeekSummary(weekId),
  ]);

  const { review, fitnessMissed } = buildWeeklyReview(
    weekId,
    blocks,
    usage,
    now,
  );

  // Persist fitness misses as "missed" so they stay in this week and are not
  // schedulable next Sunday (R8.1). Other never-happened blocks are left as-is;
  // only the fitness no-roll contract requires a status write here.
  for (const block of fitnessMissed) {
    await deps.blocksWriter.saveBlock(block);
  }

  await deps.reviews.saveReview(review);

  return review;
}

export interface SundayNudgeDeps {
  nudge: NudgePort;
}

export interface SundayNudgeRequest {
  now?: string;
  weekOf?: string;
}

/** Build the Sunday planning nudge notification for a week (R9). */
export function buildSundayNudge(weekId: string): NudgeNotification {
  return {
    id: `sunday-nudge:${weekId}`,
    title: SUNDAY_NUDGE_TITLE,
    body: SUNDAY_NUDGE_BODY,
  };
}

/**
 * Deliver the Sunday morning planning nudge (R9) through the injected port.
 * Returns the delivered notification.
 */
export async function runSundayPlanningNudge(
  request: SundayNudgeRequest,
  deps: SundayNudgeDeps,
): Promise<NudgeNotification> {
  const nowIso = request.now ?? new Date().toISOString();
  const week = weekBounds(request.weekOf ?? nowIso);
  const weekId = weekIdOf(week);

  const notification = buildSundayNudge(weekId);
  await deps.nudge.deliver(notification);
  return notification;
}
