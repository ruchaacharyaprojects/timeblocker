/**
 * Shared data contracts for the scheduling engine.
 *
 * Instants are ISO-8601 strings (absolute, timezone-aware). The engine
 * normalizes them to America/Toronto internally. Keeping the public surface
 * as strings keeps the engine free of any Date-construction ambiguity at its
 * boundaries while remaining pure.
 */

export type Category =
  | "fitness"
  | "self-care"
  | "work"
  | "self-development"
  | "misc";

export type PlanningMode = "earliest-fit" | "spread";

/** The Sunday-Saturday bounds of a week, as absolute instants. */
export interface Week {
  /** Start of Sunday (00:00 America/Toronto) as an ISO string. */
  sunday: string;
  /** End of Saturday (24:00 / next Sunday 00:00 America/Toronto) as ISO. */
  saturday: string;
}

/** A half-open time interval [start, end). */
export interface Interval {
  start: string;
  end: string;
}

/** A real calendar event the engine must schedule around. */
export interface BusyEvent extends Interval {
  id?: string;
  /** Whether the event includes other people (meetings). */
  withOthers?: boolean;
}

/** A free window available for placement. */
export interface FreeWindow extends Interval {}

/** A concrete placement slot. */
export interface Slot extends Interval {}

/** An item to be placed into the week. */
export interface Item {
  id: string;
  text: string;
  durationMin: number;
  /** 1 = highest priority. */
  priority: number;
  category: Category;
  /**
   * Optional series key (R20.5). Items sharing a group are softly preferred
   * on different days by `place()`; items without a group are unaffected.
   */
  group?: string;
  /**
   * R28: exact start (epoch ms). `place()` handles these first: the item is
   * placed iff [fixedStartMs, fixedStartMs + duration) lies fully inside one
   * free window and the constraints allow it; otherwise it is unplaced with
   * reason "clash". It is never moved.
   */
  fixedStartMs?: number;
  /** R28: the item may not start before this instant (epoch ms). */
  earliestMs?: number;
  /**
   * R28: hard deadline / day end (epoch ms). The item must END at or before
   * this instant. Items with `latestEndMs` are placed ahead of all others
   * (earliest deadline first) and, when unplaceable, get the reason
   * "no-time-before-deadline".
   */
  latestEndMs?: number;
}

/** A placed item with its assigned slot. */
export interface PlacedItem {
  item: Item;
  slot: Slot;
}

/**
 * Why an item was not placed (R28.2, R28.5).
 * - "clash": a fixed-start item's exact time is not free (event, other fixed
 *   task, protected time, constraint).
 * - "past": a fixed-start item whose start is already behind us (set by the
 *   planner, not by `place()`).
 * - "no-time-before-deadline": a deadline item with no slot ending by its deadline.
 * - "no-fit": no free slot in the week (the default).
 */
export type UnplacedReason = "clash" | "past" | "no-time-before-deadline" | "no-fit";

/** An {@link Item} that could not be placed, with an optional reason. */
export type UnplacedItem = Item & { reason?: UnplacedReason };

export interface PlacementResult {
  placed: PlacedItem[];
  /**
   * Items that fit nowhere. `place()` sets `reason` for fixed-start, deadline
   * and earliest-bounded items; plain items are returned unchanged (an absent
   * reason means "no-fit").
   */
  unplaced: UnplacedItem[];
}

/** A block being rescheduled. */
export interface Block extends Interval {
  id: string;
  itemId: string;
  category: Category;
  durationMin?: number;
}

/** Optional knobs for `reschedule`. */
export interface RescheduleOptions {
  /**
   * ISO instant. The search starts at max(block.start, notBefore) so a block
   * that has already started is never moved into the past.
   */
  notBefore?: string;
}

/**
 * Fixed-constraint configuration (R3). Defaults live in `constraints.ts`
 * but the engine accepts an override so tests can isolate each rule and so
 * holidays stay user-overridable (R3.2).
 */
export interface Constraints {
  /** `YYYY-MM-DD` Toronto dates treated as statutory holidays (day off). */
  holidays: string[];
}

export const NO_FIT = "no-fit" as const;
export type NoFit = typeof NO_FIT;
