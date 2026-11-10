/**
 * `NotificationService.reconcile()` (design: "Desired notification set" and
 * "Reconcile"; R13.1, R13.2, R13.7, R13.10, R13.11, R14.7).
 *
 * One pass:
 * 1. read `exact` from `Notifier.canScheduleExact()` (R13.10);
 * 2. compute the desired set from local blocks and cached meetings;
 * 3. read `notifRegistry` and `Notifier.listPending()`;
 * 4. apply {@link planReconcile}'s decisions through the `Notifier`;
 * 5. save the new registry (only when it changed).
 *
 * Passes are serialized, so overlapping callers (plan, sync, action,
 * foreground) never interleave registry writes. Each native call is isolated:
 * a failure is reported in the result and leaves the registry so the next
 * pass retries that id. An exact `schedule` that throws (exact alarms revoked
 * mid-pass) is retried inexact.
 *
 * Also: `ensurePermissionOnce()` (ask once on API ≥ 33, R13.8),
 * `refreshExactAlarmState()` / `exactAlarmState()` (persisted flag, "Reminder
 * timing may vary", exact re-arm when it becomes available, R13.10), and
 * `indicators(now)` (bell badges while denied, R13.9).
 */
import type { CalendarEvent } from "@timeblocker/calendar-integration";
import { torontoDateKey, weekBounds } from "@timeblocker/scheduling-engine";
import type { DeviceBlock, RegistryEntry } from "../models.js";
import type { Clock, NotificationPermission, Notifier } from "../ports.js";
import type { Repositories } from "../repositories.js";
import { REMINDER_LEAD_MS, desiredNotifications } from "./desired.js";
import type { Forecast } from "./forecast.js";
import { planReconcile, registryEntryFor } from "./reconcile.js";

/** What reconcile builds the desired set from. */
export interface ReconcileSources {
  blocks: readonly DeviceBlock[];
  /** Cached non-🧱 events (meetings) from the latest syncs. */
  events: readonly CalendarEvent[];
}

/** What one reconcile pass did. Ids are notification ids. */
export interface ReconcileResult {
  /** Whether reminders were armed as exact alarms. */
  exact: boolean;
  scheduled: string[];
  shown: string[];
  cancelled: string[];
  /** Ids scheduled inexact because an exact `schedule` threw. */
  inexactFallback: string[];
  failed: Array<{ id: string; error: string }>;
  /** The registry after the pass. */
  registry: RegistryEntry[];
}

/** The Sunday `weekId` (YYYY-MM-DD, Toronto) of the week containing `ms`. */
export function weekIdAt(ms: number): string {
  return torontoDateKey(new Date(weekBounds(new Date(ms)).sunday));
}

/** The current and next week ids; reminders never reach further ahead. */
export function reconcileWeekIds(now: number): string[] {
  const current = weekBounds(new Date(now));
  return [
    torontoDateKey(new Date(current.sunday)),
    torontoDateKey(new Date(weekBounds(current.saturday).sunday)),
  ];
}

const errorMessage = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Android 13 (Tiramisu): the first API level with runtime POST_NOTIFICATIONS. */
export const POST_NOTIFICATIONS_MIN_API = 33;

/** The settings-screen note shown while reminders are armed inexact (R13.10). */
export const REMINDER_TIMING_MAY_VARY = "Reminder timing may vary";

export interface NotificationServiceOptions {
  /**
   * The device's Android API level (`Platform.Version`). Defaults to
   * {@link POST_NOTIFICATIONS_MIN_API}; below it no runtime request is made.
   */
  apiLevel?: number;
  /**
   * Supplies per-block forecasts (keyed by block id) for the reminder body
   * (R17.3). Errors are swallowed: reconcile runs without forecasts.
   */
  forecasts?: (input: {
    blocks: readonly DeviceBlock[];
    events: readonly CalendarEvent[];
    now: number;
  }) => Promise<ReadonlyMap<string, Forecast>>;
}

/** Outcome of {@link NotificationService.ensurePermissionOnce} (R13.8). */
export interface PermissionCheck {
  /** The permission after the check (and the request, when one was made). */
  permission: NotificationPermission;
  /** True only on the single call that asked the system. */
  requested: boolean;
}

/** Exact-alarm state for the settings screen (R13.10). */
export interface ExactAlarmState {
  exactAlarmsAvailable: boolean;
  /** True while reminders are inexact: show {@link REMINDER_TIMING_MAY_VARY}. */
  reminderTimingMayVary: boolean;
}

/** Outcome of {@link NotificationService.refreshExactAlarmState}. */
export interface ExactAlarmRefresh extends ExactAlarmState {
  /** Whether the persisted flag changed. */
  changed: boolean;
  /** Present when exact alarms became available and reminders were re-armed exact. */
  reconciled?: ReconcileResult;
}

/** Week-view bell badges while notifications are denied (R13.9). */
export interface NotificationIndicators {
  /** Whether the notification permission is denied (otherwise both lists are empty). */
  denied: boolean;
  /** Blocks starting within 15 min, plus blocks with an unanswered prompt. Sorted, unique. */
  blockIds: string[];
  /** Qualifying meetings (`withOthers && !isBlock`) starting within 15 min. Sorted, unique. */
  meetingIds: string[];
}

/** Input to the pure {@link computeIndicators}. */
export interface IndicatorInput extends ReconcileSources {
  /** Block ids with an entry in `openPrompts`. */
  promptBlockIds: readonly string[];
  /** epoch ms */
  now: number;
}

/** True when `iso` parses and `now < start ≤ now + 15 min`. */
function startsWithinLead(iso: string, now: number): boolean {
  const ms = Date.parse(iso);
  return Number.isFinite(ms) && ms > now && ms <= now + REMINDER_LEAD_MS;
}

/**
 * The indicator sets, independent of the permission: blocks and qualifying
 * meetings with `now < start ≤ now + 15 min`, united with the blocks that
 * have an unanswered prompt (R13.9). Pure.
 */
export function computeIndicators(input: IndicatorInput): Pick<NotificationIndicators, "blockIds" | "meetingIds"> {
  const blockIds = new Set<string>(input.promptBlockIds);
  for (const b of input.blocks) {
    if (startsWithinLead(b.start, input.now)) blockIds.add(b.id);
  }
  const meetingIds = new Set<string>();
  for (const e of input.events) {
    if (e.withOthers && !e.isBlock && startsWithinLead(e.start, input.now)) meetingIds.add(e.id);
  }
  return { blockIds: [...blockIds].sort(), meetingIds: [...meetingIds].sort() };
}

export class NotificationService {
  private chain: Promise<unknown> = Promise.resolve();
  private permissionChain: Promise<unknown> = Promise.resolve();
  private readonly apiLevel: number;
  private readonly forecasts: NotificationServiceOptions["forecasts"];

  constructor(
    private readonly repos: Repositories,
    private readonly notifier: Notifier,
    private readonly clock: Clock,
    options: NotificationServiceOptions = {},
  ) {
    this.apiLevel = options.apiLevel ?? POST_NOTIFICATIONS_MIN_API;
    this.forecasts = options.forecasts;
  }

  /**
   * On API ≥ 33, when the permission is `undetermined` and it was never
   * requested, persist `notificationsRequested = true` and then ask once.
   * Never asks again, whatever the answer (R13.8). Calls are serialized.
   */
  ensurePermissionOnce(): Promise<PermissionCheck> {
    const run = this.permissionChain.then(() => this.ensurePermissionOnceInner());
    this.permissionChain = run.catch(() => undefined);
    return run;
  }

  private async ensurePermissionOnceInner(): Promise<PermissionCheck> {
    const permission = await this.notifier.permission();
    if (this.apiLevel < POST_NOTIFICATIONS_MIN_API || permission !== "undetermined") {
      return { permission, requested: false };
    }
    const state = await this.repos.permissionState.get();
    if (state.notificationsRequested) return { permission, requested: false };
    // Set the flag before awaiting the dialog, so a crash or a second process
    // mid-dialog can never ask a second time.
    await this.repos.permissionState.save({ ...state, notificationsRequested: true });
    return { permission: await this.notifier.requestPermission(), requested: true };
  }

  /** The persisted exact-alarm state for the settings screen (R13.10). */
  async exactAlarmState(): Promise<ExactAlarmState> {
    const { exactAlarmsAvailable } = await this.repos.permissionState.get();
    return { exactAlarmsAvailable, reminderTimingMayVary: !exactAlarmsAvailable };
  }

  /**
   * Re-read `canScheduleExact()` (on foreground) and persist it. When it
   * became available, reconcile in the same call so every inexact entry is
   * re-armed with `exact = true` (R13.10).
   */
  async refreshExactAlarmState(): Promise<ExactAlarmRefresh> {
    const available = await this.notifier.canScheduleExact();
    const changed = await this.persistExact(available);
    const out: ExactAlarmRefresh = {
      exactAlarmsAvailable: available,
      reminderTimingMayVary: !available,
      changed,
    };
    if (changed && available) out.reconciled = await this.reconcile();
    return out;
  }

  /**
   * Week-view bell badges (R13.9): empty unless the permission is `denied`;
   * otherwise {@link computeIndicators} over the current and next week's
   * blocks, cached meetings, and `openPrompts`.
   */
  async indicators(now: number = this.clock.now(), sources?: ReconcileSources): Promise<NotificationIndicators> {
    if ((await this.notifier.permission()) !== "denied") {
      return { denied: false, blockIds: [], meetingIds: [] };
    }
    const { blocks, events } = sources ?? (await this.loadSources(now));
    const prompts = await this.repos.openPrompts.get();
    return {
      denied: true,
      ...computeIndicators({ blocks, events, now, promptBlockIds: prompts.map((p) => p.blockId) }),
    };
  }

  /**
   * Persist `exactAlarmsAvailable`; returns whether it changed. Runs on the
   * permission chain so it never interleaves with the ask-once write.
   */
  private persistExact(available: boolean): Promise<boolean> {
    const run = this.permissionChain.then(async () => {
      const state = await this.repos.permissionState.get();
      if (state.exactAlarmsAvailable === available) return false;
      await this.repos.permissionState.save({ ...state, exactAlarmsAvailable: available });
      return true;
    });
    this.permissionChain = run.catch(() => undefined);
    return run;
  }

  /**
   * Bring armed and shown notifications in line with the current blocks and
   * meetings. Without `sources`, reads the current and next week's blocks and
   * calendar caches from the store. Idempotent: a second pass with the same
   * inputs makes no `schedule`, `showNow`, or `cancel` calls.
   */
  reconcile(sources?: ReconcileSources): Promise<ReconcileResult> {
    const run = this.chain.then(() => this.reconcileOnce(sources));
    this.chain = run.catch(() => undefined);
    return run;
  }

  /** Blocks and cached meetings for the current and next week. */
  async loadSources(now: number = this.clock.now()): Promise<ReconcileSources> {
    const blocks: DeviceBlock[] = [];
    const events: CalendarEvent[] = [];
    for (const weekId of reconcileWeekIds(now)) {
      blocks.push(...(await this.repos.blocks.get(weekId)));
      const cache = await this.repos.calendarCache.get(weekId);
      if (cache) events.push(...cache.events);
    }
    return { blocks, events };
  }

  private async reconcileOnce(sources?: ReconcileSources): Promise<ReconcileResult> {
    const now = this.clock.now();
    const exact = await this.notifier.canScheduleExact();
    const { blocks, events } = sources ?? (await this.loadSources(now));
    let forecasts: ReadonlyMap<string, Forecast> | undefined;
    if (this.forecasts) {
      try {
        forecasts = await this.forecasts({ blocks, events, now });
      } catch {
        forecasts = undefined;
      }
    }
    const desired = desiredNotifications({ blocks, events, now, exact, forecasts });
    const registry = await this.repos.notifRegistry.get();
    const pending = await this.notifier.listPending();

    const result: ReconcileResult = {
      exact,
      scheduled: [],
      shown: [],
      cancelled: [],
      inexactFallback: [],
      failed: [],
      registry: [],
    };

    for (const decision of planReconcile({ desired, registry, pending, now })) {
      const { action, id } = decision;
      let kept = decision.onSuccess;
      try {
        if (action?.type === "cancel") {
          await this.notifier.cancel(id);
          result.cancelled.push(id);
        } else if (action?.type === "show") {
          if (action.cancelFirst) {
            await this.notifier.cancel(id);
            result.cancelled.push(id);
          }
          await this.notifier.showNow(action.desired.payload);
          result.shown.push(id);
        } else if (action?.type === "schedule") {
          const d = action.desired;
          try {
            await this.notifier.schedule(d.payload, d.fireAtMs, d.exact);
          } catch (error) {
            if (!d.exact) throw error;
            await this.notifier.schedule(d.payload, d.fireAtMs, false);
            kept = registryEntryFor(d, "pending", false);
            result.inexactFallback.push(id);
          }
          result.scheduled.push(id);
        }
      } catch (error) {
        kept = decision.onFailure;
        result.failed.push({ id, error: errorMessage(error) });
      }
      if (kept) result.registry.push(kept);
    }

    if (JSON.stringify(result.registry) !== JSON.stringify(registry)) {
      await this.repos.notifRegistry.save(result.registry);
    }
    return result;
  }
}
