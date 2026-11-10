/**
 * `AppLifecycle`: what runs when the app launches and when it comes back to
 * the foreground (design: "AppLifecycle"; R13.8, R13.10, R14.1, R14.3,
 * R14.12).
 *
 * - `onLaunch()`: first restores a legacy transport-ended session when
 *   tokens remain, then the auth gate. When signed in: ask for the notification
 *   permission once (R13.8), start the periodic background sync at
 *   {@link BACKGROUND_SYNC_INTERVAL_MIN} minutes (R14.3), run a `"launch"`
 *   sync (R14.1), then reconcile reminders. When not signed in, background
 *   sync is stopped (it only runs while signed in) and nothing else runs.
 * - `onForeground()`: when signed in, a `"foreground"` sync (R14.1); then,
 *   whatever the auth state, refresh the notification permission and the
 *   exact-alarm state. When exact alarms became available, the refresh
 *   re-arms reminders as exact in the same pass (R13.10).
 *
 * A `SessionEnded` thrown by sync goes to `auth.onSessionEnded()`, which
 * stops background sync and marks the session ended; local data is kept
 * (R14.12). Any other step failure is captured in the result so one failing
 * step never stops the others.
 *
 * Every dependency is a narrow interface so tests can use small fakes.
 */
import { isSessionEnded, type SessionEnded, type SessionEndedReason } from "../models.js";
import type { BackgroundJobs } from "../ports.js";
import type { ExactAlarmRefresh, PermissionCheck } from "../notifications/service.js";
import type { SyncResult, SyncTrigger } from "../sync/syncService.js";

/** Periodic background sync interval, minutes (design D8; R14.3 requires ≤ 60). */
export const BACKGROUND_SYNC_INTERVAL_MIN = 30;

/** The part of `AuthService` the lifecycle uses. */
export interface LifecycleAuth {
  isSignedIn(): Promise<boolean>;
  onSessionEnded(ended: SessionEnded | SessionEndedReason): Promise<unknown>;
  /** Undo a legacy `session-ended`/`transport` state when tokens remain. */
  restoreAfterTransportEnd?(): Promise<boolean>;
}

/** The part of `NotificationService` the lifecycle uses. */
export interface LifecycleNotifications {
  ensurePermissionOnce(): Promise<PermissionCheck>;
  refreshExactAlarmState(): Promise<ExactAlarmRefresh>;
  reconcile(): Promise<unknown>;
}

/** The part of `SyncService` the lifecycle uses. */
export interface LifecycleSync {
  sync(trigger: SyncTrigger): Promise<SyncResult>;
}

export interface AppLifecycleDeps {
  auth: LifecycleAuth;
  notifications: LifecycleNotifications;
  sync: LifecycleSync;
  jobs: Pick<BackgroundJobs, "startPeriodicSync" | "stopPeriodicSync">;
}

/** How a lifecycle sync went. */
export type LifecycleSyncOutcome =
  | { status: "ok"; result: SyncResult }
  /** Sync threw `SessionEnded`; `auth.onSessionEnded` ran. */
  | { status: "session-ended"; reason: SessionEndedReason }
  | { status: "failed"; error: string };

/** A non-sync step that threw. */
export interface LifecycleStepError {
  step: "restore-session" | "permission" | "background-start" | "background-stop" | "reconcile" | "exact-alarm";
  error: string;
}

export interface LaunchResult {
  signedIn: boolean;
  /** Present when signed in. */
  permission?: PermissionCheck;
  /** Whether the periodic background sync was started. */
  backgroundStarted: boolean;
  /** Present when signed in. */
  sync?: LifecycleSyncOutcome;
  /** Whether the post-sync reconcile ran (it is skipped after a session end). */
  reconciled: boolean;
  errors: LifecycleStepError[];
}

export interface ForegroundResult {
  signedIn: boolean;
  /** Present when signed in. */
  sync?: LifecycleSyncOutcome;
  permission?: PermissionCheck;
  exactAlarm?: ExactAlarmRefresh;
  errors: LifecycleStepError[];
}

const errorMessage = (e: unknown) => (e instanceof Error ? e.message : String(e));

export class AppLifecycle {
  private readonly auth: LifecycleAuth;
  private readonly notifications: LifecycleNotifications;
  private readonly syncer: LifecycleSync;
  private readonly jobs: AppLifecycleDeps["jobs"];

  constructor(deps: AppLifecycleDeps) {
    this.auth = deps.auth;
    this.notifications = deps.notifications;
    this.syncer = deps.sync;
    this.jobs = deps.jobs;
  }

  /** App launch: auth gate, permission once, background job, sync, reconcile. */
  async onLaunch(): Promise<LaunchResult> {
    const errors: LifecycleStepError[] = [];
    // Recover installs wrongly ended by a network failure; must precede the
    // auth gate (and the caller's authState refresh).
    await this.attempt("restore-session", errors, async () => {
      await this.auth.restoreAfterTransportEnd?.();
    });
    const signedIn = await this.auth.isSignedIn();
    if (!signedIn) {
      // Background sync runs only while signed in (R14.3, R14.12).
      await this.attempt("background-stop", errors, () => this.jobs.stopPeriodicSync());
      return { signedIn, backgroundStarted: false, reconciled: false, errors };
    }

    const permission = await this.attempt("permission", errors, () =>
      this.notifications.ensurePermissionOnce(),
    );
    const started = await this.attempt("background-start", errors, async () => {
      await this.jobs.startPeriodicSync(BACKGROUND_SYNC_INTERVAL_MIN);
      return true as const;
    });
    const sync = await this.runSync("launch");

    let reconciled = false;
    if (sync.status !== "session-ended") {
      reconciled =
        (await this.attempt("reconcile", errors, async () => {
          await this.notifications.reconcile();
          return true as const;
        })) ?? false;
    }

    const result: LaunchResult = {
      signedIn,
      backgroundStarted: started === true && sync.status !== "session-ended",
      sync,
      reconciled,
      errors,
    };
    if (permission) result.permission = permission;
    return result;
  }

  /** App foreground: sync, then refresh permission and exact-alarm state. */
  async onForeground(): Promise<ForegroundResult> {
    const errors: LifecycleStepError[] = [];
    const signedIn = await this.auth.isSignedIn();
    const result: ForegroundResult = { signedIn, errors };
    if (signedIn) result.sync = await this.runSync("foreground");

    const permission = await this.attempt("permission", errors, () =>
      this.notifications.ensurePermissionOnce(),
    );
    if (permission) result.permission = permission;
    // Re-arms reminders as exact in this same call when they became available (R13.10).
    const exactAlarm = await this.attempt("exact-alarm", errors, () =>
      this.notifications.refreshExactAlarmState(),
    );
    if (exactAlarm) result.exactAlarm = exactAlarm;
    return result;
  }

  private async runSync(trigger: SyncTrigger): Promise<LifecycleSyncOutcome> {
    try {
      return { status: "ok", result: await this.syncer.sync(trigger) };
    } catch (error) {
      if (isSessionEnded(error)) {
        await this.auth.onSessionEnded(error);
        return { status: "session-ended", reason: error.reason };
      }
      return { status: "failed", error: errorMessage(error) };
    }
  }

  private async attempt<T>(
    step: LifecycleStepError["step"],
    errors: LifecycleStepError[],
    fn: () => Promise<T>,
  ): Promise<T | undefined> {
    try {
      return await fn();
    } catch (error) {
      errors.push({ step, error: errorMessage(error) });
      return undefined;
    }
  }
}
