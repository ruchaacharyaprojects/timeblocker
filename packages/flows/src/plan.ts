/**
 * Planning orchestration (R2) — pure of AWS/Google specifics.
 *
 * Moved from `packages/infra/lambda/planning/plan.ts` into `@timeblocker/flows`.
 *
 * Two layers:
 *
 *   - {@link computePlan} is pure: given the week, the confirmed items, the
 *     busy events, the settings, and `now`, it builds free windows (fixed R3
 *     constraints + busy events + holidays from settings), places items
 *     highest-priority-first with the configured planning mode (R2.1, R2.2),
 *     and returns placed + unplaced items plus the shrink / drop /
 *     roll-to-next-week alert when anything is unplaced (R2.3). The engine
 *     never forces an item into a slot.
 *   - {@link runPlanning} is a thin wrapper that reads items, settings, and the
 *     week's calendar events through injected ports, calls `computePlan`,
 *     writes the placed blocks to the calendar as solo events, and persists
 *     them. Its behavior is unchanged from the infra original.
 */

import {
  freeWindows,
  weekBounds,
  place,
  type BusyEvent,
  type Constraints,
  type Item,
  type PlacedItem,
  type PlanningMode,
  type UnplacedItem,
  type Week,
} from "@timeblocker/scheduling-engine";
import {
  toBusyEvents,
  type CalendarEvent,
  type SoloBlock,
} from "@timeblocker/calendar-integration";
import type { PersistedBlock } from "./block.js";
import { preferenceScore, type PlacementPreferences } from "./preferences.js";

export type { PersistedBlock };

/** Settings relevant to planning (R2.2 mode, R3.2 overridable holidays). */
export interface PlanningSettings {
  planningMode: PlanningMode;
  holidays: string[];
}

/** The three choices offered for an item that fits nowhere (R2.3). */
export type NothingFitsOption = "shrink" | "drop" | "roll-to-next-week";

/**
 * The "nothing fits" alert (R2.3). Present only when at least one item could
 * not be placed. It lists the offending items and the three resolutions the
 * user must choose from; the system never forces a block into a slot.
 */
export interface NothingFitsAlert {
  message: string;
  options: NothingFitsOption[];
  items: Item[];
}

export interface PlanningResult {
  week: Week;
  weekId: string;
  mode: PlanningMode;
  placed: PlacedItem[];
  unplaced: UnplacedItem[];
  blocks: PersistedBlock[];
  /** Present only when `unplaced` is non-empty (R2.3). */
  alert?: NothingFitsAlert;
}

// --- Pure planning core ----------------------------------------------------

/** Input to {@link computePlan}. Everything is already loaded; no I/O. */
export interface ComputePlanInput {
  week: Week;
  /** Confirmed, schedulable items for the week. */
  items: Item[];
  /** Busy events (real meetings, and on device: local blocks) to avoid. */
  busy: BusyEvent[];
  settings: PlanningSettings;
  /** Current instant (ISO); time before it is never scheduled. */
  now: string;
  /** Learned time-of-day preferences (R23); absent or empty = unchanged placement. */
  preferences?: PlacementPreferences;
}

/** Output of {@link computePlan}. */
export interface ComputePlanResult {
  placed: PlacedItem[];
  /** Unplaced items; `reason` says why (R28): clash, past, no-time-before-deadline, no-fit. */
  unplaced: UnplacedItem[];
  /** Present only when `unplaced` is non-empty (R2.3). */
  alert?: NothingFitsAlert;
}

/**
 * Pure planning: build free windows and place the items (R2.1-R2.3).
 * Deterministic for a given input; reads no clock and does no I/O.
 */
export function computePlan(input: ComputePlanInput): ComputePlanResult {
  const constraints: Constraints = { holidays: input.settings.holidays };
  const windows = freeWindows(input.week, input.busy, constraints, input.now);
  // R28.2: a fixed-start item already behind `now` is never sent to the engine.
  const nowMs = new Date(input.now).getTime();
  const past: UnplacedItem[] = [];
  const candidates: Item[] = [];
  for (const item of input.items) {
    if (item.fixedStartMs !== undefined && item.fixedStartMs < nowMs) {
      past.push({ ...item, reason: "past" });
    } else {
      candidates.push(item);
    }
  }
  const { placed, unplaced: engineUnplaced } = place(
    candidates,
    windows,
    input.settings.planningMode,
    input.preferences
      ? {
          score: (item, startMs) =>
            preferenceScore(input.preferences!, item.category, startMs),
        }
      : undefined,
  );
  const unplaced: UnplacedItem[] = [...engineUnplaced, ...past];
  const result: ComputePlanResult = { placed, unplaced };
  if (unplaced.length > 0) {
    result.alert = buildNothingFitsAlert(unplaced);
  }
  return result;
}

// --- Injected ports --------------------------------------------------------

/** Reads the confirmed, schedulable items for a week (R1.3 gate upstream). */
export interface ItemsReader {
  readConfirmedItems(weekId: string): Promise<Item[]>;
}

/** Reads the single user's planning settings. */
export interface SettingsReader {
  readSettings(): Promise<PlanningSettings>;
}

/**
 * The slice of the Google Calendar client planning needs: read the week's
 * events and write the solo blocks. {@link GoogleCalendarClient} satisfies it.
 */
export interface CalendarPort {
  readWeek(week: Week): Promise<CalendarEvent[]>;
  writeBlocks(blocks: SoloBlock[]): Promise<string[]>;
}

/** Persists the placed blocks (DynamoDB blocks table in production). */
export interface BlocksWriter {
  saveBlocks(blocks: PersistedBlock[]): Promise<void>;
}

export interface PlanningDeps {
  items: ItemsReader;
  settings: SettingsReader;
  calendar: CalendarPort;
  blocks: BlocksWriter;
}

export interface PlanningRequest {
  /** Any instant inside the week to plan (defaults to `now`). */
  weekOf?: string;
  /** Current instant; time before it is never scheduled. */
  now?: string;
}

/** Default planning settings when none are stored yet. */
export const DEFAULT_SETTINGS: PlanningSettings = {
  planningMode: "earliest-fit",
  holidays: [],
};

/** Stable week id: the ISO date (YYYY-MM-DD) of the week's Sunday. */
export function weekIdOf(week: Week): string {
  return week.sunday.slice(0, 10);
}

/** Build the R2.3 alert for the items that fit nowhere this week. */
export function buildNothingFitsAlert(unplaced: Item[]): NothingFitsAlert {
  return {
    message:
      "Some items don't fit anywhere this week. For each one, choose to " +
      "shrink it, drop it, or roll it to next week — nothing was forced " +
      "into a slot.",
    options: ["shrink", "drop", "roll-to-next-week"],
    items: unplaced,
  };
}

/**
 * Run the planning flow for a week and return placed + unplaced items plus
 * the R2.3 alert when anything is unplaced. A thin I/O wrapper over
 * {@link computePlan}.
 */
export async function runPlanning(
  request: PlanningRequest,
  deps: PlanningDeps,
): Promise<PlanningResult> {
  const nowIso = request.now ?? new Date().toISOString();
  const week = weekBounds(request.weekOf ?? nowIso);
  const weekId = weekIdOf(week);

  const [items, settings] = await Promise.all([
    deps.items.readConfirmedItems(weekId),
    deps.settings.readSettings(),
  ]);

  const calendarEvents = await deps.calendar.readWeek(week);
  const busy: BusyEvent[] = toBusyEvents(calendarEvents);

  const { placed, unplaced, alert } = computePlan({
    week,
    items,
    busy,
    settings,
    now: nowIso,
  });

  // Write the placed blocks to the calendar as solo events, then persist them
  // with the returned calendar event ids. Order is preserved across both.
  const soloBlocks: SoloBlock[] = placed.map((p) => ({
    title: p.item.text,
    start: p.slot.start,
    end: p.slot.end,
    category: p.item.category,
  }));

  const calendarEventIds =
    soloBlocks.length > 0 ? await deps.calendar.writeBlocks(soloBlocks) : [];

  const blocks: PersistedBlock[] = placed.map((p, i) => ({
    id: `${weekId}#${p.item.id}`,
    itemId: p.item.id,
    start: p.slot.start,
    end: p.slot.end,
    category: p.item.category,
    calendarEventId: calendarEventIds[i] ?? "",
    status: "scheduled",
    weekId,
  }));

  if (blocks.length > 0) {
    await deps.blocks.saveBlocks(blocks);
  }

  const result: PlanningResult = {
    week,
    weekId,
    mode: settings.planningMode,
    placed,
    unplaced,
    blocks,
  };

  if (alert) {
    result.alert = alert;
  }

  return result;
}
