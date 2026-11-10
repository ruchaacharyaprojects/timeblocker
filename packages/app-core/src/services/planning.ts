/**
 * `PlanningService`: on-device weekly planning (R2.1-R2.3, R12.6, R13.1, R14.8).
 *
 * One `plan(weekId)` pass:
 * 1. optionally runs a foreground sync first, bounded by a 15 s budget; a
 *    failed or slow sync never blocks planning, which then uses the last
 *    sync's cache;
 * 2. builds busy time = cached non-🧱 events ∪ local `scheduled` /
 *    `in-progress` blocks (local blocks stand in for 🧱 events, so unsynced
 *    blocks count and nothing is counted twice);
 * 3. calls the pure `computePlan` for the confirmed items of the week that
 *    have no block yet (R2.1, R2.2);
 * 4. persists the new `DeviceBlock`s (status `scheduled`, each with a
 *    pre-assigned `calendarEventId` so the create is idempotent, R14.8)
 *    together with their outbox upserts in one `setMany`;
 * 5. reconciles notifications so the new blocks get reminders (R13.1), and
 *    kicks an outbox flush without waiting for it;
 * 6. returns placed/unplaced items plus the nothing-fits alert (R2.3).
 *
 * Passes are serialized so two overlapping calls can't place the same item
 * twice. `PlanningService` satisfies `IntakePlanner<PlanResult>`.
 */
import {
  buildPlacementPreferences,
  computePlan,
  scheduleToEngineFields,
  type PlacementPreferences,
  type IntakeItem,
  type NothingFitsAlert,
} from "@timeblocker/flows";
import {
  weekBounds,
  type BusyEvent,
  type Item,
  type PlacedItem,
  type UnplacedItem,
  type PlanningMode,
  type Week,
} from "@timeblocker/scheduling-engine";
import type { TaskKind } from "@timeblocker/flows";
import type { DeviceBlock, DeviceBlockStatus } from "../models.js";
import type { Clock, IdGenerator } from "../ports.js";
import type { OutboxRequest, Repositories } from "../repositories.js";
import { allHolidays, type HolidayDates } from "./holidays.js";
import { shiftWeekId, type PlacementHistorySource } from "./history.js";
import type { IntakePlanner } from "./intake.js";

// app-core compiles with `lib: ES2022` and no host types; React Native and
// Node both provide these timer globals at runtime.
declare function setTimeout(callback: () => void, ms: number): unknown;
declare function clearTimeout(handle: unknown): void;

/** Foreground sync budget before planning goes ahead with the cache. */
export const PLANNING_SYNC_BUDGET_MS = 15_000;

/** Block statuses that occupy time when planning (design: "Busy time"). */
export const BUSY_BLOCK_STATUSES: readonly DeviceBlockStatus[] = [
  "scheduled",
  "in-progress",
];

/** The optional "sync first" step (implemented by `SyncService`). */
export interface PlanningSync {
  syncForeground(): Promise<void>;
}

/** Kicks an outbox flush (implemented by `SyncService`); not awaited. */
export interface PlanningFlusher {
  flush(): Promise<unknown>;
}

/** Brings notifications in line with stored blocks (`NotificationService`). */
export interface PlanningNotifications {
  reconcile(): Promise<unknown>;
}

export interface PlanningServiceDeps {
  repos: Repositories;
  clock: Clock;
  ids: IdGenerator;
  notifications: PlanningNotifications;
  /** When present, a foreground sync runs before planning. */
  sync?: PlanningSync;
  /** When present, a flush is kicked after new blocks are saved. */
  flusher?: PlanningFlusher;
  /** When present, past blocks teach time-of-day placement (R23); failures are ignored. */
  history?: PlacementHistorySource;
  /** When present, country holidays are avoided like days off (R30.2); failures are ignored. */
  holidays?: HolidayDates;
  /** Override the sync budget (tests). Defaults to {@link PLANNING_SYNC_BUDGET_MS}. */
  syncBudgetMs?: number;
}

/** How the optional sync-first step went. */
export type PlanningSyncOutcome = "skipped" | "ok" | "failed" | "timed-out";

export interface PlanResult {
  weekId: string;
  week: Week;
  mode: PlanningMode;
  placed: PlacedItem[];
  /** Each entry may carry a `reason` (clash, past, no-time-before-deadline, no-fit). */
  unplaced: UnplacedItem[];
  /** The blocks created by this pass. */
  blocks: DeviceBlock[];
  /** Present only when `unplaced` is non-empty (R2.3). */
  alert?: NothingFitsAlert;
  sync: PlanningSyncOutcome;
  /** Set when the notification reconcile threw; the blocks are still saved. */
  notificationError?: string;
}

/** The Sunday-Saturday week for a `weekId` (YYYY-MM-DD Toronto Sunday). */
export function weekOfId(weekId: string): Week {
  // Noon UTC is the same calendar date in Toronto in every season.
  return weekBounds(`${weekId}T12:00:00Z`);
}

/** Busy time: cached non-🧱 events plus local blocks that still occupy time. */
export function planningBusy(
  events: ReadonlyArray<{ id: string; start: string; end: string; withOthers: boolean; isBlock?: boolean }>,
  blocks: readonly DeviceBlock[],
): BusyEvent[] {
  const busy: BusyEvent[] = events
    .filter((e) => e.isBlock !== true)
    .map((e) => ({ id: e.id, start: e.start, end: e.end, withOthers: e.withOthers }));
  for (const b of blocks) {
    if (BUSY_BLOCK_STATUSES.includes(b.status)) {
      busy.push({ id: b.id, start: b.start, end: b.end, withOthers: false });
    }
  }
  return busy;
}

/** Confirmed items of the week that don't have a block yet. */
export function itemsToPlan(
  items: readonly IntakeItem[],
  blocks: readonly DeviceBlock[],
): Item[] {
  const planned = new Set(blocks.map((b) => b.itemId));
  return items
    .filter((i) => i.confirmed && !planned.has(i.id))
    .map(({ id, text, durationMin, priority, category, seriesId, fixedStart, onDay, dueAt }): Item => {
      const item: Item = {
        id,
        text,
        durationMin,
        priority,
        category,
        // Fixed start, single day, and deadline bounds (R28.2-R28.5).
        ...scheduleToEngineFields({
          ...(fixedStart !== undefined ? { fixedStart } : {}),
          ...(onDay !== undefined ? { onDay } : {}),
          ...(dueAt !== undefined ? { dueAt } : {}),
        }),
      };
      // A counted series prefers different days (R20.5).
      if (seriesId !== undefined) item.group = seriesId;
      return item;
    });
}

const errorMessage = (e: unknown) => (e instanceof Error ? e.message : String(e));

export class PlanningService implements IntakePlanner<PlanResult> {
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private readonly deps: PlanningServiceDeps) {}

  /** Plan every unplanned confirmed item of `weekId`. */
  plan(weekId: string): Promise<PlanResult> {
    const run = this.chain.then(() => this.planOnce(weekId));
    this.chain = run.catch(() => undefined);
    return run;
  }

  /**
   * Move the selected unplaced items of `weekId` to the next week (R21.3) and
   * plan that week. Ids that don't exist or already have a block are ignored.
   * Items leave `items:<weekId>` and join `items:<next>` in one commit.
   */
  rollToNextWeek(weekId: string, itemIds: readonly string[]): Promise<PlanResult> {
    const run = this.chain.then(async () => {
      const nextWeekId = shiftWeekId(weekId, -1);
      const { repos } = this.deps;
      const [items, blocks, nextItems] = await Promise.all([
        repos.items.get(weekId),
        repos.blocks.get(weekId),
        repos.items.get(nextWeekId),
      ]);
      const wanted = new Set(itemIds);
      const planned = new Set(blocks.map((b) => b.itemId));
      const moving = items.filter((i) => wanted.has(i.id) && i.confirmed && !planned.has(i.id));
      if (moving.length > 0) {
        const movingIds = new Set(moving.map((i) => i.id));
        const moved: IntakeItem[] = moving.map((i) => ({ ...i, weekId: nextWeekId, confirmed: true }));
        await repos.commit([
          repos.items.write(weekId, items.filter((i) => !movingIds.has(i.id))),
          repos.items.write(nextWeekId, [...nextItems.filter((i) => !movingIds.has(i.id)), ...moved]),
        ]);
      }
      return this.planOnce(nextWeekId);
    });
    this.chain = run.catch(() => undefined);
    return run;
  }

  /** Remove the given items (only those without blocks) from the week (R21.4). */
  dropUnplaced(weekId: string, itemIds: readonly string[]): Promise<{ removed: number }> {
    const run = this.chain.then(async () => {
      const { repos } = this.deps;
      const [items, blocks] = await Promise.all([repos.items.get(weekId), repos.blocks.get(weekId)]);
      const wanted = new Set(itemIds);
      const planned = new Set(blocks.map((b) => b.itemId));
      const remaining = items.filter((i) => !wanted.has(i.id) || planned.has(i.id));
      const removed = items.length - remaining.length;
      if (removed > 0) await repos.commit([repos.items.write(weekId, remaining)]);
      return { removed };
    });
    this.chain = run.catch(() => undefined);
    return run;
  }

  private async planOnce(weekId: string): Promise<PlanResult> {
    const { repos, clock, ids, notifications, flusher } = this.deps;
    const sync = await this.syncFirst();

    const week = weekOfId(weekId);
    const [items, existing, cache, settings] = await Promise.all([
      repos.items.get(weekId),
      repos.blocks.get(weekId),
      repos.calendarCache.get(weekId),
      repos.settings.get(),
    ]);

    const now = clock.now();
    const holidays = await allHolidays(settings.holidays, this.deps.holidays);
    const preferences = await this.loadPreferences(weekId);
    const { placed, unplaced, alert } = computePlan({
      week,
      items: itemsToPlan(items, existing),
      busy: planningBusy(cache?.events ?? [], existing),
      settings: { planningMode: settings.planningMode, holidays },
      now: new Date(now).toISOString(),
      ...(preferences ? { preferences } : {}),
    });

    const dueByItem = new Map(items.filter((i) => i.dueAt !== undefined).map((i) => [i.id, i.dueAt as string]));
    const kindByItem = new Map(items.filter((i) => i.kind !== undefined).map((i) => [i.id, i.kind as TaskKind]));
    const blocks: DeviceBlock[] = placed.map(({ item, slot }) => ({
      ...(dueByItem.has(item.id) ? { dueAt: dueByItem.get(item.id) as string } : {}),
      ...(kindByItem.has(item.id) ? { kind: kindByItem.get(item.id) as TaskKind } : {}),
      id: ids.next(),
      itemId: item.id,
      title: item.text,
      start: slot.start,
      end: slot.end,
      category: item.category,
      status: "scheduled",
      weekId,
      calendarEventId: ids.calendarEventId(),
      calendarSynced: false,
      promptedMeetingIds: [],
      usagePrompted: false,
      updatedAt: now,
    }));

    const result: PlanResult = {
      weekId,
      week,
      mode: settings.planningMode,
      placed,
      unplaced,
      blocks,
      sync,
    };
    if (alert) result.alert = alert;
    if (blocks.length === 0) return result;

    const requests: OutboxRequest[] = blocks.map((b) => ({
      blockId: b.id,
      calendarEventId: b.calendarEventId,
      op: "upsert",
      enqueuedAt: now,
    }));
    await repos.saveBlocksWithOutbox(weekId, [...existing, ...blocks], requests);

    try {
      await notifications.reconcile();
    } catch (error) {
      result.notificationError = errorMessage(error);
    }
    // Fire and forget: the outbox keeps the writes if this flush fails.
    flusher?.flush().catch(() => undefined);
    return result;
  }

  /** Learned preferences (R23); undefined when unavailable or on any error. */
  private async loadPreferences(weekId: string): Promise<PlacementPreferences | undefined> {
    const { history } = this.deps;
    if (!history) return undefined;
    try {
      return buildPlacementPreferences(await history.placementHistory(weekId));
    } catch {
      return undefined;
    }
  }

  /** Run the optional foreground sync within the budget; never throws. */
  private async syncFirst(): Promise<PlanningSyncOutcome> {
    const { sync } = this.deps;
    if (!sync) return "skipped";
    const budget = this.deps.syncBudgetMs ?? PLANNING_SYNC_BUDGET_MS;
    let timer: unknown;
    const timeout = new Promise<"timed-out">((resolve) => {
      timer = setTimeout(() => resolve("timed-out"), budget);
    });
    try {
      return await Promise.race([
        sync.syncForeground().then(
          () => "ok" as const,
          () => "failed" as const,
        ),
        timeout,
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
}
