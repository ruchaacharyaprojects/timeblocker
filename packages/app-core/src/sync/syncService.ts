/**
 * `SyncService`: on-device calendar sync with a single-flight guard
 * (design: "Background sync" and "Calendar sync algorithm"; R14.3).
 *
 * **Two weeks (R31.2).** After the current week reads and reconciles, the
 * NEXT Sunday-Saturday week is read with the same reconcile/cache/prompt
 * logic (`calendarCache:<nextWeekId>`, `blocks:<nextWeekId>`). A next-week
 * failure is silent (old cache kept, no banner, sync result unchanged), it
 * is skipped once a timed run passes its deadline, and `SessionEnded` still
 * propagates. The read/reconcile section below describes the current week;
 * the next week follows the same rules.
 *
 * Two layers make sure a second sync never runs while one is in progress:
 *
 * 1. **In-memory promise join (same runtime).** While a sync is in flight,
 *    every further `sync(trigger)` call returns the same promise, so a
 *    pull-to-refresh during a launch sync awaits that sync's result.
 * 2. **Persisted lease (across processes).** Before the body runs, the
 *    service writes `syncState.lease = { owner, expiresAt: now + 2 min }`.
 *    A new process (for example a headless background-fetch task started
 *    while a previous run died mid-sync) that finds a valid lease
 *    (`now < expiresAt`) owned by someone else returns `busy` without
 *    running the body. An expired lease is taken over. The lease is
 *    released when the body settles; a failed release just lets it expire.
 *
 * The sync body is a fixed sequence of steps, each its own method, so the
 * later tasks can fill them in one at a time:
 * `flushOutbox` (18.2) → `readAndReconcile` (18.3) → `promptConflicts`
 * (18.4) → `complete` (18.5). A step returns `"stop"` to skip the rest (for
 * example a network failure during the flush skips the read, R14.10).
 *
 * **Outbox flush (18.2; R14.8-R14.11).** The first step sends every queued
 * `PendingWrite` FIFO before any read, so a pending local change can't be
 * overwritten by older calendar state:
 * - `upsert` reads the block's current fields and calls `upsertBlock` with
 *   the block's client-chosen event id (POST, `409` → PUT inside the client),
 *   so a lost response can never create a duplicate (R14.8). The request
 *   carries the 🧱 prefix, category color and suppressed reminders via
 *   `buildEventRequest` (R14.9). On success the block is marked
 *   `calendarSynced` and the entry dropped, in one commit.
 * - `upsert` answered `"deleted"` (PUT `404`/`410`): the user deleted the
 *   event in Calendar, so the local block is removed (remote deletion).
 * - `delete` calls `deleteBlock` (`404`/`410` already count as success).
 * - Network, timeout, `408`/`429` or `5xx`: the entry stays (`attempts++`),
 *   local blocks are unchanged, the banner is set, and the rest of the flush
 *   and the read are skipped (R14.10). Other `4xx`: the entry stays, the
 *   banner is set, and the flush continues. `401` is handled by the token
 *   provider (one forced refresh); `SessionEnded` propagates unchanged; an
 *   `AuthTransportError` (network) is an ordinary soft failure.
 *
 * A write's entry is only dropped when it still describes what was sent, so
 * a local change made while the request was in flight is flushed next time.
 * {@link SyncService.flush} runs the same flush on its own (for
 * `PlanningService`'s `PlanningFlusher`) under the single-flight guard.
 *
 * **Read, 🧱 reconciliation and cache (18.3; R14.1, R14.2, R14.6, R14.7,
 * R11.7).** The second step reads every event overlapping the current
 * Toronto Sunday-Saturday week (`readWeek(weekBounds(now))`), then, for each
 * local block of that week that is `calendarSynced` and has no outbox entry
 * (local intent wins until flushed):
 * - its 🧱 event is in the read with a different start/end → the block takes
 *   the event's start/end (status kept, `moveReason: "Moved in Google
 *   Calendar"`, `movedFrom` = the old span);
 * - its event is not in the read → `getEvent`: `"deleted"` (`404`/`410` or
 *   `status: "cancelled"`) removes the block; an event found outside the
 *   week moves the block to the event's start/end and week (`weekId`).
 * The week's non-🧱 events are cached in `calendarCache:<weekId>` with
 * `syncedAt`, in the same commit as the block changes. Decisions are applied
 * against a fresh read of the blocks and outbox, so a local change made
 * while the calendar calls were in flight is never overwritten. Running the
 * step again on the same calendar state changes no block (idempotent).
 * A read failure (or a failed `getEvent`) keeps the affected blocks
 * unchanged, sets the banner and stops the sync (R14.10).
 *
 * **Conflict prompts, once per pair (18.4; R6.1, R13.5, R14.4, R14.5).** The
 * third step runs `findConflicts` over the week's stored blocks and the
 * events just read (scheduled blocks, meetings with others, not 🧱,
 * half-open overlap). Meetings already in a block's `promptedMeetingIds` are
 * dropped. For each block with new meetings, the pairs, the `openPrompts`
 * entry and the `notifRegistry` entry are persisted in one commit first,
 * then one `miss:<blockId>` Yes/No prompt naming the meeting(s) is shown,
 * so a crash mid-way never prompts the same pair twice. Needs a `notifier`.
 *
 * **Completion, banner, session end, foreground timeout (18.5; R13.7,
 * R14.2, R14.10, R14.12).** The last step runs the usage-risk pass
 * (`usageRisk.checkUpcoming()`), then reconciles notifications
 * (`notifications.reconcile()`); a failure in either is recorded in
 * {@link SyncService.lastCompletion} and never fails the sync. Then, when
 * the run read the calendar and none of its writes failed, it sets
 * `lastSuccessAt` and clears the banner (R14.10). A run whose flush recorded
 * a rejected (`4xx`) write keeps the banner that same flush just set and
 * does not touch `lastSuccessAt` (the week view hides a banner older than
 * `lastSuccessAt`). The lease is released when the body settles. The banner
 * is dismissible ({@link SyncService.dismissBanner}).
 *
 * `SessionEnded` from any step: the optional `onSessionEnded` dep
 * (`AuthService.onSessionEnded`) runs once per run after the lease is
 * released, local blocks are left untouched, and the error still rejects
 * the callers (so `AppLifecycle` keeps routing to sign-in; its second
 * `onSessionEnded` call is idempotent).
 *
 * `"foreground"` and `"pull"` syncs are bounded by
 * {@link FOREGROUND_SYNC_TIMEOUT_MS} (14 s) so the spinner clears within
 * 15 s (R14.2): every such caller resolves `timed-out` by then. A run started
 * by one of those triggers is also aborted at its deadline: the banner is
 * set, no further step (or outbox entry) starts, and `complete` never
 * records success. The aborted run keeps the lease until the call it is
 * waiting on settles (the HTTP layer has its own per-request timeout), so
 * no second sync overlaps it; if that call never settles, the lease expires
 * after {@link SYNC_LEASE_MS} and a later `sync` in this runtime abandons the
 * stuck run and starts afresh.
 */
import {
  CalendarHttpError,
  isBlockSummary,
  type CalendarEvent,
} from "@timeblocker/calendar-integration";
import { buildMissPrompt, findConflicts } from "@timeblocker/flows";
import { torontoDateKey, weekBounds, type Week } from "@timeblocker/scheduling-engine";
import {
  isSessionEnded,
  type SessionEnded,
  type DeviceBlock,
  type OpenPrompt,
  type PendingWrite,
  type RegistryEntry,
  type SyncState,
} from "../models.js";
import type {
  CalendarApi,
  CalendarBlockWrite,
  Clock,
  NotificationPayload,
  Notifier,
} from "../ports.js";
import type { DocWrite, Repositories } from "../repositories.js";
import type { ReconcileResult } from "../notifications/service.js";
import type { UsageRiskResult } from "../services/usageRisk.js";

// app-core compiles with `lib: ES2022` and no host types; React Native and
// Node both provide these timer globals at runtime.
declare function setTimeout(callback: () => void, ms: number): unknown;
declare function clearTimeout(handle: unknown): void;

/** How long a persisted lease stays valid: 2 minutes (R14.3). */
export const SYNC_LEASE_MS = 2 * 60 * 1000;

/**
 * Overall bound on a `"foreground"`/`"pull"` sync, so the pull-to-refresh
 * spinner always clears within 15 s (R14.2).
 */
export const FOREGROUND_SYNC_TIMEOUT_MS = 14_000;

/** Banner copy after a foreground/pull sync hit its time limit (R14.2, R14.10). */
export const SYNC_TIMEOUT_MESSAGE = "Sync failed: Google Calendar didn't respond in time";

/** What started a sync (R14.1-R14.3). */
export type SyncTrigger = "launch" | "foreground" | "pull" | "background";

/** True for the user-facing triggers bounded by {@link FOREGROUND_SYNC_TIMEOUT_MS}. */
export function isTimedTrigger(trigger: SyncTrigger): boolean {
  return trigger === "foreground" || trigger === "pull";
}

/** The persisted single-flight lease. */
export type SyncLease = NonNullable<SyncState["lease"]>;

/** The body's steps, in run order. */
export const SYNC_STEPS = [
  "flushOutbox",
  "readAndReconcile",
  "promptConflicts",
  "complete",
] as const;

export type SyncStep = (typeof SYNC_STEPS)[number];

/** A step's verdict: keep going, or skip the remaining steps. */
export type StepOutcome = "continue" | "stop";

/** Per-run context handed to every step. */
export interface SyncContext {
  readonly trigger: SyncTrigger;
  /** epoch ms, when the lease was acquired. */
  readonly startedAt: number;
  /** The lease owner for this run. */
  readonly leaseOwner: string;
}

/** What the body did. */
export interface SyncBodyReport {
  /** Steps that ran, in order. */
  stepsRun: SyncStep[];
  /** The step that returned `"stop"`, if any. */
  stoppedAfter?: SyncStep;
}

/** A replacement body (tests, or a caller that composes its own steps). */
export type SyncBody = (ctx: SyncContext) => Promise<SyncBodyReport>;

export type SyncResult =
  /** This call (or the in-flight call it joined) ran the body. */
  | {
      status: "completed";
      trigger: SyncTrigger;
      startedAt: number;
      finishedAt: number;
      report: SyncBodyReport;
    }
  /** Another process holds a valid lease; nothing ran. */
  | { status: "busy"; trigger: SyncTrigger; lease: SyncLease }
  /**
   * A `"foreground"`/`"pull"` call gave up after `timeoutMs` (R14.2). When
   * this call started the run, the run was aborted and the banner set.
   */
  | { status: "timed-out"; trigger: SyncTrigger; calledAt: number; timeoutMs: number };

/** Banner copy after a sync couldn't send local changes (R14.10). */
export const SYNC_WRITE_ERROR_MESSAGE = "Sync failed: couldn't save your changes to Google Calendar";

/**
 * Weeks searched for an outbox entry's block, relative to the current
 * Toronto week (entries carry no `weekId`). Blocks are planned for the
 * current or next week, so this is generous.
 */
export const OUTBOX_BLOCK_SEARCH_WEEKS = { before: 4, after: 8 } as const;

/** How a write failure is handled (R14.10). */
export type WriteFailureKind =
  /** Network, timeout, 408/429, 5xx: stop the flush and skip the read. */
  | "transient"
  /** Any other 4xx: keep the entry and continue with the other writes. */
  | "rejected";

/** What one outbox flush did. */
export interface FlushReport {
  /** Entries a write was sent for, in FIFO order (block ids). */
  attempted: string[];
  /** Upserts that landed; the block is now `calendarSynced`. */
  synced: string[];
  /** Deletes that landed. */
  deleted: string[];
  /** Upserts answered `"deleted"`: the local block was removed. */
  remoteDeleted: string[];
  /** Upserts whose block no longer exists locally; the entry was dropped. */
  missing: string[];
  failed: Array<{ blockId: string; kind: WriteFailureKind; message: string }>;
  /** True when a transient failure stopped the flush (the read is skipped). */
  stopped: boolean;
}

export type FlushResult =
  /** The flush ran on its own. */
  | { status: "flushed"; report: FlushReport }
  /** A full sync was already in flight in this runtime; its flush covered it. */
  | { status: "joined"; result: SyncResult }
  /** Another process holds a valid lease; nothing ran. */
  | { status: "busy"; lease: SyncLease };

/** Classify a write error; `SessionEnded` is rethrown by the caller first. */
export function classifyWriteFailure(error: unknown): WriteFailureKind {
  if (error instanceof CalendarHttpError) {
    const { status } = error;
    if (status >= 500 || status === 408 || status === 429) return "transient";
    if (status >= 400) return "rejected";
  }
  // Transport failures, timeouts, and anything unexpected.
  return "transient";
}

const errorMessage = (e: unknown) => (e instanceof Error ? e.message : String(e));

const DAY_MS = 24 * 60 * 60 * 1000;

/** Week ids to search for an entry's block, nearest weeks first. */
export function outboxSearchWeekIds(now: number): string[] {
  // Noon on the current Toronto Sunday ± whole weeks stays on a Sunday
  // across DST shifts.
  const sundayNoon = Date.parse(weekBounds(new Date(now)).sunday) + DAY_MS / 2;
  const at = (k: number) => torontoDateKey(new Date(sundayNoon + k * 7 * DAY_MS));
  const ids = [at(0)];
  const reach = Math.max(OUTBOX_BLOCK_SEARCH_WEEKS.before, OUTBOX_BLOCK_SEARCH_WEEKS.after);
  for (let k = 1; k <= reach; k++) {
    if (k <= OUTBOX_BLOCK_SEARCH_WEEKS.after) ids.push(at(k));
    if (k <= OUTBOX_BLOCK_SEARCH_WEEKS.before) ids.push(at(-k));
  }
  return ids;
}

/** The fields an upsert sends for `block`. */
export function blockWriteOf(block: DeviceBlock): CalendarBlockWrite {
  return {
    title: block.title,
    start: block.start,
    end: block.end,
    category: block.category,
    calendarEventId: block.calendarEventId,
  };
}

// --- Read and reconcile (18.3) ---------------------------------------------------

/** Banner copy after a sync couldn't read Google Calendar (R14.10). */
export const SYNC_READ_ERROR_MESSAGE = "Sync failed: couldn't read Google Calendar";

/** `moveReason` for a block whose 🧱 event was moved in Google Calendar (R14.6). */
export const MOVED_IN_CALENDAR_REASON = "Moved in Google Calendar";

/** The week id (`YYYY-MM-DD` of the Toronto Sunday) containing `instant`. */
export function weekIdOf(instant: string | number | Date): string {
  return torontoDateKey(new Date(weekBounds(new Date(instant)).sunday));
}

/** True for a TimeBlocker block event (🧱 title prefix, R14.4). */
export function isBlockEvent(event: CalendarEvent): boolean {
  return event.isBlock === true || isBlockSummary(event.summary);
}

/** What reconciliation decided for one block. */
export type BlockReconcileDecision =
  /** The event is gone (deleted or cancelled): remove the block (R14.7). */
  | { kind: "remove"; blockId: string }
  /** The event moved: take its start/end (and week) (R14.6). */
  | { kind: "move"; blockId: string; start: string; end: string };

/**
 * Pure: blocks eligible for reconciliation are `calendarSynced` and have no
 * outbox entry. Returns the moves found in `weekEvents` and the eligible
 * blocks whose event is missing from it (to be looked up with `getEvent`).
 */
export function diffBlocksAgainstWeek(
  blocks: readonly DeviceBlock[],
  pendingBlockIds: ReadonlySet<string>,
  weekEvents: readonly CalendarEvent[],
): { decisions: BlockReconcileDecision[]; missing: DeviceBlock[] } {
  const byId = new Map(weekEvents.filter(isBlockEvent).map((e) => [e.id, e] as const));
  const decisions: BlockReconcileDecision[] = [];
  const missing: DeviceBlock[] = [];
  for (const block of blocks) {
    if (!block.calendarSynced || pendingBlockIds.has(block.id)) continue;
    const event = byId.get(block.calendarEventId);
    if (!event) {
      missing.push(block);
    } else if (!sameInstant(event.start, block.start) || !sameInstant(event.end, block.end)) {
      decisions.push({ kind: "move", blockId: block.id, start: event.start, end: event.end });
    }
  }
  return { decisions, missing };
}

/** Pure: the decision for a block whose event was looked up with `getEvent`. */
export function decisionForLookup(
  block: DeviceBlock,
  found: CalendarEvent | "deleted",
): BlockReconcileDecision | undefined {
  if (found === "deleted") return { kind: "remove", blockId: block.id };
  if (sameInstant(found.start, block.start) && sameInstant(found.end, block.end)) {
    // Same time but not in the week read: only the week id can be stale.
    return block.weekId === weekIdOf(found.start)
      ? undefined
      : { kind: "move", blockId: block.id, start: found.start, end: found.end };
  }
  return { kind: "move", blockId: block.id, start: found.start, end: found.end };
}

/** The block after a calendar move (status kept, R14.6). */
export function movedBlock(block: DeviceBlock, start: string, end: string, now: number): DeviceBlock {
  return {
    ...block,
    start,
    end,
    weekId: weekIdOf(start),
    moveReason: MOVED_IN_CALENDAR_REASON,
    movedFrom: { start: block.start, end: block.end },
    updatedAt: now,
  };
}

function sameInstant(a: string, b: string): boolean {
  return a === b || Date.parse(a) === Date.parse(b);
}

/** True when `current` is still the block the decision was made for. */
function unchangedSince(current: DeviceBlock, seen: DeviceBlock): boolean {
  return (
    current.calendarSynced &&
    current.calendarEventId === seen.calendarEventId &&
    current.start === seen.start &&
    current.end === seen.end &&
    current.updatedAt === seen.updatedAt
  );
}

/** What one read-and-reconcile step did. */
export interface ReadReport {
  week: Week;
  weekId: string;
  /** The week's non-🧱 events, as cached (R11.7). */
  events: CalendarEvent[];
  /** The week's blocks after reconciliation. */
  blocks: DeviceBlock[];
  /** Blocks whose start/end moved within the week. */
  moved: string[];
  /** Blocks moved to another week. */
  relocated: Array<{ blockId: string; weekId: string }>;
  /** Blocks removed because their event was deleted or cancelled. */
  removed: string[];
  /** Synced blocks skipped because a local write is pending. */
  skippedPending: string[];
  /** Blocks whose decision was dropped because they changed locally meanwhile. */
  skippedChanged: string[];
  /** `getEvent` lookups that failed; those blocks are unchanged. */
  failed: Array<{ blockId: string; message: string }>;
}

// --- Conflict prompts (18.4) -------------------------------------------------------

/** A block with meetings that overlap it and have not prompted it yet (R14.5). */
export interface NewConflictPair {
  block: DeviceBlock;
  /** The new meetings, in `findConflicts` order. */
  meetings: CalendarEvent[];
}

/**
 * Pure: `findConflicts` (scheduled blocks × non-🧱 meetings with others,
 * half-open overlap; R14.4) minus meetings already in the block's
 * `promptedMeetingIds` (R14.5). Blocks left with no new meeting are dropped.
 */
export function newConflictPairs(
  blocks: readonly DeviceBlock[],
  events: readonly CalendarEvent[],
): NewConflictPair[] {
  const byId = new Map(blocks.map((b) => [b.id, b] as const));
  const pairs: NewConflictPair[] = [];
  for (const conflict of findConflicts([...blocks], [...events])) {
    const block = byId.get(conflict.block.id);
    if (!block) continue;
    const prompted = new Set(block.promptedMeetingIds);
    const seen = new Set<string>();
    const meetings = conflict.meetings.filter((m) => {
      if (prompted.has(m.id) || seen.has(m.id)) return false;
      seen.add(m.id);
      return true;
    });
    if (meetings.length > 0) pairs.push({ block, meetings });
  }
  return pairs;
}

/** Prompt body naming the overlapping meeting(s) (R6.1, R13.5). */
export function meetingConflictBody(blockTitle: string, meetings: readonly CalendarEvent[]): string {
  const names = meetings.map((m) => m.summary.trim() || "a meeting");
  return `${blockTitle} overlaps ${names.join(", ")}`;
}

/** The notification payload for a meeting-overlap miss prompt (R6.1, R13.5). */
export function meetingMissPromptPayload(
  block: DeviceBlock,
  meetings: readonly CalendarEvent[],
): NotificationPayload {
  const prompt = buildMissPrompt({
    blockId: block.id,
    weekId: block.weekId,
    title: block.title,
    trigger: "meeting-overlap",
  });
  return {
    id: prompt.id,
    kind: "miss-prompt",
    channel: "prompts",
    title: prompt.title,
    body: meetingConflictBody(prompt.body, meetings),
    actions: prompt.actions.map((a) => ({ id: a.id, label: a.label })),
    sourceId: block.id,
    weekId: block.weekId,
    deepLink: `timeblocker://block/${block.id}`,
  };
}

/** What one conflict-prompt step did. */
export interface ConflictReport {
  /** Prompts shown, with the meetings that were new for the block. */
  prompted: Array<{ blockId: string; meetingIds: string[] }>;
  /** Prompts whose `showNow` failed (the pairs were already recorded). */
  failed: Array<{ blockId: string; message: string }>;
}

function sameWrite(a: CalendarBlockWrite, b: CalendarBlockWrite): boolean {
  return (
    a.title === b.title &&
    a.start === b.start &&
    a.end === b.end &&
    a.category === b.category &&
    a.calendarEventId === b.calendarEventId
  );
}

function sameEntry(a: PendingWrite, b: PendingWrite): boolean {
  return a.blockId === b.blockId && a.op === b.op && a.calendarEventId === b.calendarEventId;
}

export interface SyncServiceDeps {
  repos: Repositories;
  clock: Clock;
  /**
   * Google Calendar (device: `createDeviceCalendarApi`). Without it the
   * calendar steps are skipped (the outbox is kept).
   */
  calendar?: CalendarApi;
  /** Local notifications for conflict prompts. Without it the prompt step is skipped. */
  notifier?: Notifier;
  /**
   * Unique per process/JS runtime (the mobile adapter supplies a random id
   * at startup). Lease owners are `<runtimeId>#<run>`.
   */
  runtimeId: string;
  /** Overrides the default step sequence. */
  body?: SyncBody;
  /** Usage-risk pass run by `complete` (sync step 7). Without it the pass is skipped. */
  usageRisk?: SyncUsageRisk;
  /** Notification reconcile run by `complete` (R13.7). Without it the reconcile is skipped. */
  notifications?: SyncNotifications;
  /**
   * Called once when a run (or standalone flush) throws `SessionEnded`,
   * after the lease is released (`AuthService.onSessionEnded`; R14.12).
   */
  onSessionEnded?: (ended: SessionEnded) => Promise<unknown>;
  /** Overrides {@link FOREGROUND_SYNC_TIMEOUT_MS} (tests). */
  foregroundTimeoutMs?: number;
}

/** The part of `UsageRiskService` the sync uses. */
export interface SyncUsageRisk {
  checkUpcoming(): Promise<UsageRiskResult>;
}

/** The part of `NotificationService` the sync uses. */
export interface SyncNotifications {
  reconcile(): Promise<ReconcileResult>;
}

/** What the `complete` step did (18.5). */
export interface CompletionReport {
  usageRisk?: UsageRiskResult;
  /** `checkUpcoming` threw (the sync went on). */
  usageRiskError?: string;
  reconcile?: ReconcileResult;
  /** `reconcile` threw (the sync went on). */
  reconcileError?: string;
  /** Whether `lastSuccessAt` was set and the banner cleared. */
  recordedSuccess: boolean;
  /** Why success was not recorded. */
  notRecordedBecause?: "no-calendar-read" | "write-failed" | "timed-out";
}

/** Per-run abort flag, set at a foreground/pull run's deadline. */
interface RunControl {
  aborted: boolean;
}

/** The sync in flight in this runtime. */
interface InFlightRun {
  promise: Promise<SyncResult>;
  control: RunControl;
  /** epoch ms, when `sync` started it. */
  calledAt: number;
}

/** True when `lease` is still valid at `now` (half-open: valid while `now < expiresAt`). */
export function isLeaseValid(lease: SyncLease | undefined, now: number): lease is SyncLease {
  return lease !== undefined && now < lease.expiresAt;
}

export class SyncService {
  protected readonly repos: Repositories;
  protected readonly clock: Clock;
  protected readonly calendar: CalendarApi | undefined;
  private readonly runtimeId: string;
  private readonly body: SyncBody;
  private readonly usageRisk: SyncUsageRisk | undefined;
  private readonly notifications: SyncNotifications | undefined;
  private readonly onSessionEnded: ((ended: SessionEnded) => Promise<unknown>) | undefined;
  private readonly foregroundTimeoutMs: number;
  private inFlightSync: InFlightRun | null = null;
  private inFlightFlush: Promise<FlushResult> | null = null;
  /** Abort flags of the runs holding a lease, by lease owner. */
  private readonly controls = new Map<string, RunControl>();
  /** Serializes this runtime's read-modify-writes of `syncState`. */
  private stateChain: Promise<unknown> = Promise.resolve();
  private runCounter = 0;
  /** The report of this run's `complete` step. */
  protected lastCompletion: CompletionReport | undefined;
  /** The report of this run's flush step, for the later steps (e.g. the banner). */
  protected lastFlush: FlushReport | undefined;
  /** The report of this run's read step (the week's events and blocks), for 18.4/18.5. */
  protected lastRead: ReadReport | undefined;
  /** The report of this run's next-week read (R31.2); undefined when skipped or failed. */
  protected lastNextRead: ReadReport | undefined;
  /** The report of this run's conflict-prompt step, for 18.5. */
  protected lastConflicts: ConflictReport | undefined;
  protected readonly notifier: Notifier | undefined;

  constructor(deps: SyncServiceDeps) {
    this.repos = deps.repos;
    this.clock = deps.clock;
    this.calendar = deps.calendar;
    this.notifier = deps.notifier;
    this.runtimeId = deps.runtimeId;
    this.body = deps.body ?? ((ctx) => this.runSteps(ctx));
    this.usageRisk = deps.usageRisk;
    this.notifications = deps.notifications;
    this.onSessionEnded = deps.onSessionEnded;
    this.foregroundTimeoutMs = deps.foregroundTimeoutMs ?? FOREGROUND_SYNC_TIMEOUT_MS;
  }

  /** True while a sync (or a standalone flush) started by this runtime is in flight. */
  get syncing(): boolean {
    return this.liveInFlight() !== null || this.inFlightFlush !== null;
  }

  /** Dismiss the error banner (R14.10). It stays dismissed until a new failure sets it. */
  async dismissBanner(): Promise<void> {
    await this.updateSyncState((state) =>
      state.error && !state.error.dismissed
        ? { ...state, error: { ...state.error, dismissed: true } }
        : state,
    );
  }

  /**
   * Run one sync, or join the one already in flight in this runtime. When
   * another process holds a valid lease, resolves `busy` without running.
   * Errors from the body reject every joined caller; the lease is released
   * either way. A standalone {@link flush} in flight is waited out first.
   */
  sync(trigger: SyncTrigger): Promise<SyncResult> {
    const current = this.liveInFlight();
    if (current) return this.bounded(trigger, current.promise);
    if (this.inFlightFlush) {
      const pending = this.inFlightFlush;
      const after = pending.then(
        () => this.sync(trigger),
        () => this.sync(trigger),
      );
      return this.bounded(trigger, after);
    }
    return this.startRun(trigger);
  }

  /**
   * Start a run. A `"foreground"`/`"pull"` run gets a deadline: at
   * {@link FOREGROUND_SYNC_TIMEOUT_MS} it is aborted, the banner is set, and
   * the starter resolves `timed-out` (R14.2).
   */
  private startRun(trigger: SyncTrigger): Promise<SyncResult> {
    const control: RunControl = { aborted: false };
    const calledAt = this.clock.now();
    const run = this.withLease(trigger, (ctx) => this.body(ctx), control).then(
      (outcome): SyncResult =>
        outcome.kind === "busy"
          ? { status: "busy", trigger, lease: outcome.lease }
          : {
              status: "completed",
              trigger,
              startedAt: outcome.ctx.startedAt,
              finishedAt: outcome.finishedAt,
              report: outcome.value,
            },
    );
    const record: InFlightRun = { promise: run, control, calledAt };
    record.promise = run.finally(() => {
      if (this.inFlightSync === record) this.inFlightSync = null;
    });
    this.inFlightSync = record;
    if (!isTimedTrigger(trigger)) return record.promise;

    const timeoutMs = this.foregroundTimeoutMs;
    let timer: unknown;
    const deadline = new Promise<SyncResult>((resolve) => {
      timer = setTimeout(() => {
        control.aborted = true;
        // The banner is persisted before the spinner clears; a failed write
        // still lets the caller go.
        this.setBanner(SYNC_TIMEOUT_MESSAGE)
          .catch(() => undefined)
          .then(() => resolve({ status: "timed-out", trigger, calledAt, timeoutMs }));
      }, timeoutMs);
    });
    const settled = record.promise.finally(() => clearTimeout(timer));
    return Promise.race([settled, deadline]);
  }

  /** `promise`, bounded by the foreground timeout for `"foreground"`/`"pull"` callers. */
  private bounded(trigger: SyncTrigger, promise: Promise<SyncResult>): Promise<SyncResult> {
    if (!isTimedTrigger(trigger)) return promise;
    const timeoutMs = this.foregroundTimeoutMs;
    const calledAt = this.clock.now();
    let timer: unknown;
    const timeout = new Promise<SyncResult>((resolve) => {
      timer = setTimeout(
        () => resolve({ status: "timed-out", trigger, calledAt, timeoutMs }),
        timeoutMs,
      );
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
  }

  /**
   * The run in flight, unless it was aborted and its lease has expired (its
   * pending call never settled): then it is abandoned so a new run can start.
   */
  private liveInFlight(): InFlightRun | null {
    const current = this.inFlightSync;
    if (!current) return null;
    if (current.control.aborted && this.clock.now() >= current.calledAt + SYNC_LEASE_MS) {
      this.inFlightSync = null;
      return null;
    }
    return current;
  }

  /**
   * Flush the outbox now without reading (`PlanningFlusher`). Joins a sync
   * or flush already in flight in this runtime; resolves `busy` when another
   * process holds the lease. `SessionEnded` rejects.
   */
  flush(): Promise<FlushResult> {
    const current = this.liveInFlight();
    if (current) {
      return current.promise.then((result): FlushResult => ({ status: "joined", result }));
    }
    if (this.inFlightFlush) return this.inFlightFlush;
    const run = this.withLease("background", () => this.flushPendingWrites()).then(
      (outcome): FlushResult =>
        outcome.kind === "busy"
          ? { status: "busy", lease: outcome.lease }
          : { status: "flushed", report: outcome.value },
    );
    const tracked = run.finally(() => {
      this.inFlightFlush = null;
    });
    this.inFlightFlush = tracked;
    return tracked;
  }

  // --- Steps (filled in by tasks 18.2-18.5) ---------------------------------

  /**
   * 18.2: flush the outbox FIFO before any read (R14.8-R14.11). A transient
   * failure returns `"stop"`, so the read is skipped (R14.10).
   */
  protected async flushOutbox(ctx: SyncContext): Promise<StepOutcome> {
    this.lastFlush = await this.flushPendingWrites(() => this.isAborted(ctx));
    return this.lastFlush.stopped ? "stop" : "continue";
  }

  /**
   * 18.3: read the week, reconcile 🧱 events, cache other events (R14.1,
   * R14.2, R14.6, R14.7, R11.7). A read failure keeps local blocks, sets the
   * banner and returns `"stop"` (R14.10); so does a failed `getEvent`, after
   * the rest of the week was reconciled and cached. Without a calendar the
   * step is skipped.
   */
  protected async readAndReconcile(ctx: SyncContext): Promise<StepOutcome> {
    const calendar = this.calendar;
    if (!calendar) return "continue";
    const now = this.clock.now();
    const week = weekBounds(new Date(now));
    const weekId = weekIdOf(week.sunday);
    this.lastNextRead = undefined;

    let weekEvents: CalendarEvent[];
    try {
      weekEvents = await calendar.readWeek(week);
    } catch (error) {
      if (isSessionEnded(error)) throw error;
      await this.setBanner(SYNC_READ_ERROR_MESSAGE);
      return "stop";
    }

    this.lastRead = await this.reconcileWeek(calendar, week, weekId, weekEvents);
    if (this.lastRead.failed.length > 0) {
      await this.setBanner(SYNC_READ_ERROR_MESSAGE);
      return "stop";
    }
    await this.readNextWeek(calendar, ctx, week);
    return "continue";
  }

  /**
   * R31.2: read, reconcile and cache the NEXT week after the current week
   * succeeded. Skipped once the run is aborted at its deadline. Failures are
   * isolated: the next week's cache and blocks stay as they were and no
   * banner is set; only `SessionEnded` propagates.
   */
  private async readNextWeek(
    calendar: CalendarApi,
    ctx: SyncContext,
    current: Week,
  ): Promise<void> {
    if (this.isAborted(ctx)) return;
    try {
      // Noon on the current Sunday + 7 days stays inside the next week across DST.
      const probe = Date.parse(current.sunday) + DAY_MS / 2 + 7 * DAY_MS;
      const week = weekBounds(new Date(probe));
      const weekId = weekIdOf(week.sunday);
      const events = await calendar.readWeek(week);
      if (this.isAborted(ctx)) return;
      const read = await this.reconcileWeek(calendar, week, weekId, events);
      // A failed getEvent leaves those blocks unchanged; the rest was applied.
      this.lastNextRead = read;
    } catch (error) {
      if (isSessionEnded(error)) throw error;
      // Next-week failures are silent (R31): the old cache stays.
    }
  }

  /**
   * 18.4: conflict prompts, once per block/meeting pair (R6.1, R14.4, R14.5,
   * R13.5). Runs on the week just read; without a calendar read or a
   * notifier the step is skipped (nothing is recorded, so a later sync with
   * both still prompts). Never stops the sync: a failed `showNow` is
   * recorded in {@link lastConflicts} and the pair stays recorded
   * (at-most-once).
   */
  protected async promptConflicts(_ctx: SyncContext): Promise<StepOutcome> {
    const read = this.lastRead;
    const notifier = this.notifier;
    if (!read || !notifier) return "continue";
    this.lastConflicts = await this.raiseConflictPrompts(notifier, read);
    const next = this.lastNextRead;
    if (next) {
      try {
        const more = await this.raiseConflictPrompts(notifier, next);
        this.lastConflicts = {
          prompted: [...this.lastConflicts.prompted, ...more.prompted],
          failed: [...this.lastConflicts.failed, ...more.failed],
        };
      } catch (error) {
        if (isSessionEnded(error)) throw error;
      }
    }
    return "continue";
  }

  /**
   * 18.5: usage risk, reconcile notifications (R13.7), then `lastSuccessAt`
   * and clear the banner (R14.10). Success is only recorded when this run
   * read the calendar, none of its writes failed (a rejected `4xx` write
   * keeps the banner its flush just set), and the run was not aborted at
   * its deadline. The lease is released by the caller when the body settles.
   */
  protected async complete(ctx: SyncContext): Promise<StepOutcome> {
    const report: CompletionReport = { recordedSuccess: false };
    this.lastCompletion = report;

    if (this.usageRisk) {
      try {
        report.usageRisk = await this.usageRisk.checkUpcoming();
      } catch (error) {
        if (isSessionEnded(error)) throw error;
        report.usageRiskError = errorMessage(error);
      }
    }
    if (this.notifications) {
      try {
        report.reconcile = await this.notifications.reconcile();
      } catch (error) {
        if (isSessionEnded(error)) throw error;
        report.reconcileError = errorMessage(error);
      }
    }

    if (this.isAborted(ctx)) {
      report.notRecordedBecause = "timed-out";
    } else if (!this.lastRead) {
      report.notRecordedBecause = "no-calendar-read";
    } else if ((this.lastFlush?.failed.length ?? 0) > 0) {
      report.notRecordedBecause = "write-failed";
    } else {
      const at = this.clock.now();
      await this.updateSyncState((state) => {
        const { error: _cleared, ...rest } = state;
        return { ...rest, lastSuccessAt: at };
      });
      report.recordedSuccess = true;
    }
    return "continue";
  }

  /** True once the run holding `ctx`'s lease passed its deadline. */
  protected isAborted(ctx: SyncContext): boolean {
    return this.controls.get(ctx.leaseOwner)?.aborted === true;
  }

  /** Read-modify-write `syncState` (so steps never clobber the lease). Serialized. */
  protected updateSyncState(update: (state: SyncState) => SyncState): Promise<SyncState> {
    return this.serializeState(async () => {
      const next = update(await this.repos.syncState.get());
      await this.repos.syncState.save(next);
      return next;
    });
  }

  /** Run `fn` after every earlier `syncState` read-modify-write of this runtime. */
  private serializeState<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.stateChain.then(fn);
    this.stateChain = run.catch(() => undefined);
    return run;
  }

  /** Show the (undismissed) error banner (R14.10). */
  protected async setBanner(message: string): Promise<void> {
    const at = this.clock.now();
    await this.updateSyncState((state) => ({
      ...state,
      error: { message, at, dismissed: false },
    }));
  }

  // --- Conflict prompts (18.4) -------------------------------------------------

  /**
   * Find the week's new block/meeting pairs against the freshly stored
   * blocks, persist `promptedMeetingIds` + `openPrompts` + `notifRegistry`
   * in one commit, then show one `miss:<blockId>` prompt per block.
   */
  private async raiseConflictPrompts(notifier: Notifier, read: ReadReport): Promise<ConflictReport> {
    const report: ConflictReport = { prompted: [], failed: [] };
    const now = this.clock.now();
    const blocks = await this.repos.blocks.get(read.weekId);
    const pending = newConflictPairs(blocks, read.events);
    if (pending.length === 0) return report;

    const byBlock = new Map(pending.map((p) => [p.block.id, p] as const));
    const nextBlocks = blocks.map((b) => {
      const pair = byBlock.get(b.id);
      if (!pair) return b;
      const ids = [...b.promptedMeetingIds, ...pair.meetings.map((m) => m.id)];
      return { ...b, promptedMeetingIds: ids, updatedAt: now };
    });

    const [openPrompts, registry] = await Promise.all([
      this.repos.openPrompts.get(),
      this.repos.notifRegistry.get(),
    ]);
    const payloads = pending.map((p) => ({ pair: p, payload: meetingMissPromptPayload(p.block, p.meetings) }));
    const ids = new Set(payloads.map((p) => p.payload.id));
    const previous = new Map(openPrompts.map((p) => [p.promptId, p] as const));
    const newPrompts: OpenPrompt[] = payloads.map(({ pair, payload }) => ({
      promptId: payload.id,
      blockId: pair.block.id,
      // The same `miss:<blockId>` replaces an unanswered one; keep its meetings.
      meetingIds: [
        ...new Set([...(previous.get(payload.id)?.meetingIds ?? []), ...pair.meetings.map((m) => m.id)]),
      ],
      shownAt: now,
    }));
    const entries: RegistryEntry[] = payloads.map(({ pair, payload }) => ({
      id: payload.id,
      kind: "miss-prompt",
      sourceId: pair.block.id,
      startMs: Date.parse(pair.block.start),
      fireAtMs: now,
      exact: false,
      state: "shown",
    }));

    // Persist first: a crash after this commit never re-prompts the pair (R14.5).
    await this.repos.commit([
      this.repos.blocks.write(read.weekId, nextBlocks),
      this.repos.openPrompts.write([...openPrompts.filter((p) => !ids.has(p.promptId)), ...newPrompts]),
      this.repos.notifRegistry.write([...registry.filter((e) => !ids.has(e.id)), ...entries]),
    ]);
    read.blocks = nextBlocks;

    for (const { pair, payload } of payloads) {
      try {
        await notifier.showNow(payload);
        report.prompted.push({ blockId: pair.block.id, meetingIds: pair.meetings.map((m) => m.id) });
      } catch (error) {
        report.failed.push({ blockId: pair.block.id, message: errorMessage(error) });
      }
    }
    return report;
  }

  // --- Read and reconcile (18.3) ---------------------------------------------------

  /**
   * Reconcile the week's synced blocks against `weekEvents` (looking up
   * missing events with `getEvent`), then commit the block changes and the
   * non-🧱 event cache together. Rethrows `SessionEnded`.
   */
  private async reconcileWeek(
    calendar: CalendarApi,
    week: Week,
    weekId: string,
    weekEvents: readonly CalendarEvent[],
  ): Promise<ReadReport> {
    const report: ReadReport = {
      week,
      weekId,
      events: weekEvents.filter((e) => !isBlockEvent(e)),
      blocks: [],
      moved: [],
      relocated: [],
      removed: [],
      skippedPending: [],
      skippedChanged: [],
      failed: [],
    };

    const [seenBlocks, seenOutbox] = await Promise.all([
      this.repos.blocks.get(weekId),
      this.repos.outbox.get(),
    ]);
    const seenPending = new Set(seenOutbox.map((w) => w.blockId));
    report.skippedPending = seenBlocks
      .filter((b) => b.calendarSynced && seenPending.has(b.id))
      .map((b) => b.id);

    const { decisions, missing } = diffBlocksAgainstWeek(seenBlocks, seenPending, weekEvents);
    for (const block of missing) {
      let found: CalendarEvent | "deleted";
      try {
        found = await calendar.getEvent(block.calendarEventId);
      } catch (error) {
        if (isSessionEnded(error)) throw error;
        report.failed.push({ blockId: block.id, message: errorMessage(error) });
        continue;
      }
      const decision = decisionForLookup(block, found);
      if (decision) decisions.push(decision);
    }

    // Apply against fresh state: a local change made meanwhile wins.
    const now = this.clock.now();
    const [blocks, outbox] = await Promise.all([
      this.repos.blocks.get(weekId),
      this.repos.outbox.get(),
    ]);
    const pending = new Set(outbox.map((w) => w.blockId));
    const seenById = new Map(seenBlocks.map((b) => [b.id, b] as const));
    let current = blocks;
    const otherWeeks = new Map<string, DeviceBlock[]>();

    for (const decision of decisions) {
      const index = current.findIndex((b) => b.id === decision.blockId);
      const block = current[index];
      const seen = seenById.get(decision.blockId);
      if (!block || !seen) continue; // removed locally meanwhile
      if (pending.has(block.id) || !unchangedSince(block, seen)) {
        report.skippedChanged.push(block.id);
        continue;
      }
      if (decision.kind === "remove") {
        current = current.filter((b) => b.id !== block.id);
        report.removed.push(block.id);
        continue;
      }
      const next = movedBlock(block, decision.start, decision.end, now);
      if (next.weekId === weekId) {
        current = current.map((b, i) => (i === index ? next : b));
        report.moved.push(block.id);
        continue;
      }
      current = current.filter((b) => b.id !== block.id);
      let target = otherWeeks.get(next.weekId);
      if (!target) target = await this.repos.blocks.get(next.weekId);
      otherWeeks.set(next.weekId, [...target.filter((b) => b.id !== next.id), next]);
      report.relocated.push({ blockId: block.id, weekId: next.weekId });
    }

    const writes: DocWrite[] = [];
    if (current !== blocks) writes.push(this.repos.blocks.write(weekId, current));
    for (const [otherId, otherBlocks] of otherWeeks) {
      writes.push(this.repos.blocks.write(otherId, otherBlocks));
    }
    writes.push(
      this.repos.calendarCache.write(weekId, { syncedAt: now, events: report.events }),
    );
    await this.repos.commit(writes);
    report.blocks = current;
    return report;
  }

  // --- Outbox flush (18.2) -----------------------------------------------------

  /**
   * Send the outbox snapshot FIFO. Must run under the lease. Without a
   * calendar nothing is sent and the outbox is kept.
   */
  private async flushPendingWrites(shouldStop: () => boolean = () => false): Promise<FlushReport> {
    const report: FlushReport = {
      attempted: [],
      synced: [],
      deleted: [],
      remoteDeleted: [],
      missing: [],
      failed: [],
      stopped: false,
    };
    const calendar = this.calendar;
    if (!calendar) return report;
    const queue = await this.repos.outbox.get();
    if (queue.length === 0) return report;

    const weekIds = outboxSearchWeekIds(this.clock.now());
    for (const entry of queue) {
      // A run aborted at its deadline sends nothing more; the outbox keeps the rest.
      if (shouldStop()) {
        report.stopped = true;
        break;
      }
      const kind = await this.flushEntry(calendar, entry, weekIds, report);
      if (kind === "transient") {
        report.stopped = true;
        break;
      }
    }
    if (report.failed.length > 0) {
      const at = this.clock.now();
      await this.updateSyncState((state) => ({
        ...state,
        error: { message: SYNC_WRITE_ERROR_MESSAGE, at, dismissed: false },
      }));
    }
    return report;
  }

  /** Send one entry; returns the failure kind, if it failed. */
  private async flushEntry(
    calendar: CalendarApi,
    entry: PendingWrite,
    weekIds: readonly string[],
    report: FlushReport,
  ): Promise<WriteFailureKind | undefined> {
    if (entry.op === "delete") {
      report.attempted.push(entry.blockId);
      try {
        await calendar.deleteBlock(entry.calendarEventId);
      } catch (error) {
        return this.recordFailure(entry, error, report);
      }
      await this.dropEntry(entry);
      report.deleted.push(entry.blockId);
      return undefined;
    }

    const found = await this.findBlock(entry.blockId, weekIds);
    if (!found) {
      // Nothing local to write; a local removal would have queued a delete.
      await this.dropEntry(entry);
      report.missing.push(entry.blockId);
      return undefined;
    }
    const sent = blockWriteOf(found.block);
    report.attempted.push(entry.blockId);
    let outcome: string | "deleted";
    try {
      outcome = await calendar.upsertBlock(sent);
    } catch (error) {
      return this.recordFailure(entry, error, report);
    }

    if (outcome === "deleted") {
      await this.applyRemoteDeletion(entry);
      report.remoteDeleted.push(entry.blockId);
    } else {
      await this.markSynced(entry, sent);
      report.synced.push(entry.blockId);
    }
    return undefined;
  }

  /** Keep the entry (`attempts++`, `lastError`); rethrows `SessionEnded`. */
  private async recordFailure(
    entry: PendingWrite,
    error: unknown,
    report: FlushReport,
  ): Promise<WriteFailureKind> {
    if (isSessionEnded(error)) throw error;
    const kind = classifyWriteFailure(error);
    const message = errorMessage(error);
    report.failed.push({ blockId: entry.blockId, kind, message });
    const outbox = await this.repos.outbox.get();
    const index = outbox.findIndex((w) => sameEntry(w, entry) && w.attempts === entry.attempts);
    if (index !== -1) {
      const next = outbox.map((w, i) =>
        i === index ? { ...w, attempts: w.attempts + 1, lastError: message } : w,
      );
      await this.repos.outbox.save(next);
    }
    return kind;
  }

  /** The block `blockId` and its week, searching the nearby weeks. */
  private async findBlock(
    blockId: string,
    weekIds: readonly string[],
  ): Promise<{ weekId: string; block: DeviceBlock; blocks: DeviceBlock[] } | undefined> {
    for (const weekId of weekIds) {
      const blocks = await this.repos.blocks.get(weekId);
      const block = blocks.find((b) => b.id === blockId);
      if (block) return { weekId, block, blocks };
    }
    return undefined;
  }

  /**
   * Mark the block `calendarSynced` and drop its entry, in one commit. The
   * entry stays when the block changed while the write was in flight.
   */
  private async markSynced(entry: PendingWrite, sent: CalendarBlockWrite): Promise<void> {
    const weekIds = outboxSearchWeekIds(this.clock.now());
    const [found, outbox] = await Promise.all([
      this.findBlock(entry.blockId, weekIds),
      this.repos.outbox.get(),
    ]);
    const writes: DocWrite[] = [];
    if (found && !found.block.calendarSynced) {
      writes.push(
        this.repos.blocks.write(
          found.weekId,
          found.blocks.map((b) => (b.id === entry.blockId ? { ...b, calendarSynced: true } : b)),
        ),
      );
    }
    const unchanged = found !== undefined && sameWrite(blockWriteOf(found.block), sent);
    const next = outbox.filter((w) => !(unchanged && sameEntry(w, entry)));
    if (next.length !== outbox.length) writes.push(this.repos.outbox.write(next));
    await this.repos.commit(writes);
  }

  /** PUT 404/410: the user deleted the event in Calendar; remove the local block. */
  private async applyRemoteDeletion(entry: PendingWrite): Promise<void> {
    const weekIds = outboxSearchWeekIds(this.clock.now());
    const [found, outbox] = await Promise.all([
      this.findBlock(entry.blockId, weekIds),
      this.repos.outbox.get(),
    ]);
    const writes: DocWrite[] = [];
    if (found) {
      writes.push(
        this.repos.blocks.write(
          found.weekId,
          found.blocks.filter((b) => b.id !== entry.blockId),
        ),
      );
    }
    // The event is gone, so any queued write for this block is moot.
    const next = outbox.filter((w) => w.blockId !== entry.blockId);
    if (next.length !== outbox.length) writes.push(this.repos.outbox.write(next));
    await this.repos.commit(writes);
  }

  /** Drop the entry if it is still the one that was sent (same op and event id). */
  private async dropEntry(entry: PendingWrite): Promise<void> {
    const outbox = await this.repos.outbox.get();
    const next = outbox.filter((w) => !sameEntry(w, entry));
    if (next.length !== outbox.length) await this.repos.outbox.save(next);
  }

  // --- Single flight -----------------------------------------------------------

  private async runSteps(ctx: SyncContext): Promise<SyncBodyReport> {
    this.lastFlush = undefined;
    this.lastRead = undefined;
    this.lastNextRead = undefined;
    this.lastConflicts = undefined;
    this.lastCompletion = undefined;
    const report: SyncBodyReport = { stepsRun: [] };
    for (const step of SYNC_STEPS) {
      // Aborted at the deadline: start no further step (R14.2).
      if (this.isAborted(ctx)) break;
      report.stepsRun.push(step);
      if ((await this[step](ctx)) === "stop") {
        report.stoppedAfter = step;
        break;
      }
    }
    return report;
  }

  /** Run `fn` holding the lease, or report `busy`. The lease is always released. */
  private async withLease<T>(
    trigger: SyncTrigger,
    fn: (ctx: SyncContext) => Promise<T>,
    control: RunControl = { aborted: false },
  ): Promise<
    | { kind: "ran"; ctx: SyncContext; value: T; finishedAt: number }
    | { kind: "busy"; lease: SyncLease }
  > {
    const acquired = await this.acquireLease();
    if (acquired.kind === "busy") return acquired;
    const ctx: SyncContext = {
      trigger,
      startedAt: acquired.lease.expiresAt - SYNC_LEASE_MS,
      leaseOwner: acquired.lease.owner,
    };
    this.controls.set(ctx.leaseOwner, control);
    let value: T;
    try {
      value = await fn(ctx);
    } catch (error) {
      await this.releaseLease(ctx.leaseOwner);
      // Local blocks are untouched; hand the session end over once (R14.12).
      if (isSessionEnded(error) && this.onSessionEnded) {
        try {
          await this.onSessionEnded(error);
        } catch {
          // The original SessionEnded still rejects the callers.
        }
      }
      throw error;
    } finally {
      this.controls.delete(ctx.leaseOwner);
    }
    const finishedAt = this.clock.now();
    await this.releaseLease(ctx.leaseOwner);
    return { kind: "ran", ctx, value, finishedAt };
  }

  /**
   * Take the lease unless another owner holds a valid one. A lease left by
   * an earlier run of this runtime is stale (nothing is in flight here), so
   * it is taken over. The write is read back so the loser of a near-
   * simultaneous acquisition by another process backs off.
   */
  private acquireLease(): Promise<
    { kind: "acquired"; lease: SyncLease } | { kind: "busy"; lease: SyncLease }
  > {
    return this.serializeState(() => this.acquireLeaseNow());
  }

  private async acquireLeaseNow(): Promise<
    { kind: "acquired"; lease: SyncLease } | { kind: "busy"; lease: SyncLease }
  > {
    const now = this.clock.now();
    const state = await this.repos.syncState.get();
    if (isLeaseValid(state.lease, now) && !this.ownsLease(state.lease)) {
      return { kind: "busy", lease: state.lease };
    }
    this.runCounter += 1;
    const lease: SyncLease = {
      owner: `${this.runtimeId}#${this.runCounter}`,
      expiresAt: now + SYNC_LEASE_MS,
    };
    await this.repos.syncState.save({ ...state, lease });

    const after = (await this.repos.syncState.get()).lease;
    if (after?.owner !== lease.owner && isLeaseValid(after, this.clock.now())) {
      return { kind: "busy", lease: after };
    }
    return { kind: "acquired", lease };
  }

  /** Drop the lease if this run still owns it; keeps every other field. */
  private async releaseLease(owner: string): Promise<void> {
    try {
      await this.serializeState(async () => {
        const state = await this.repos.syncState.get();
        if (state.lease?.owner !== owner) return;
        const { lease: _released, ...rest } = state;
        await this.repos.syncState.save(rest);
      });
    } catch {
      // Best effort: an unreleased lease expires after SYNC_LEASE_MS.
    }
  }

  private ownsLease(lease: SyncLease): boolean {
    return lease.owner.startsWith(`${this.runtimeId}#`);
  }
}
