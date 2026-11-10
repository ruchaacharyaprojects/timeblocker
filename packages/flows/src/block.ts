/**
 * The single persisted block model shared by every flow.
 *
 * Replaces the three copies that lived in `infra/lambda/planning/plan.ts`,
 * `infra/lambda/reschedule/reschedule.ts`, and `infra/lambda/scheduler/review.ts`.
 * The type is the union of their fields, so every existing producer and
 * consumer (including the infra tests) stays assignable to it.
 *
 * Pure types and helpers only: no I/O.
 */
import type { Category } from "@timeblocker/scheduling-engine";

/**
 * Every status a block can have.
 *
 * - `scheduled`: placed and waiting to happen. A same-week move on device
 *   keeps this status so the block still gets a reminder (R13.1) and is still
 *   watched for conflicts (R14.4).
 * - `in-progress`: the user tapped "I'm in" (R13.4).
 * - `done` / `partial`: finished or partly finished (R9.1).
 * - `skipped`: the user tapped "Skip" (R13.4).
 * - `missed`: did not happen; fitness blocks end here instead of rolling (R8.1).
 * - `rolled`: "roll to next week" from the nothing-fits flow (R2.3, R6.3).
 * - `moved`: legacy backend status written by the infra reschedule Lambda.
 */
export type BlockStatus =
  | "scheduled"
  | "in-progress"
  | "done"
  | "partial"
  | "skipped"
  | "missed"
  | "rolled"
  | "moved";

/** All block statuses, in declaration order. */
export const BLOCK_STATUSES: readonly BlockStatus[] = [
  "scheduled",
  "in-progress",
  "done",
  "partial",
  "skipped",
  "missed",
  "rolled",
  "moved",
] as const;

/** Narrow an unknown value (for example, a stored JSON field) to a status. */
export function isBlockStatus(value: unknown): value is BlockStatus {
  return (
    typeof value === "string" &&
    (BLOCK_STATUSES as readonly string[]).includes(value)
  );
}

/** A block as persisted by planning/reschedule and read back by every flow. */
export interface PersistedBlock {
  id: string;
  itemId: string;
  /** ISO-8601 start with offset. */
  start: string;
  /** ISO-8601 end with offset. */
  end: string;
  category: Category;
  status: BlockStatus;
  /** Sunday date (YYYY-MM-DD) of the block's Sunday-Saturday week. */
  weekId: string;
  /**
   * The matching Google Calendar event id. Planning and reschedule always set
   * it; the review reads blocks where it may be absent.
   */
  calendarEventId?: string;
  /** Human-readable title; falls back to text then a default. */
  title?: string;
  text?: string;
  /** Why the block moved, carried for the review (R9.3). */
  moveReason?: string;
  color?: string;
}
