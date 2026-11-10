import { describe, expect, it } from "vitest";
import { SessionEnded } from "../models.js";
import type { ExactAlarmRefresh, PermissionCheck } from "../notifications/service.js";
import { Repositories } from "../repositories.js";
import type { SyncResult, SyncTrigger } from "../sync/syncService.js";
import {
  FakeBackgroundJobs,
  FakeClock,
  FakeTokenVault,
  MemoryKeyValueStore,
  ScriptableAuthClient,
  makeTokens,
} from "../testkit.js";
import { AuthTransportError } from "../tokenProvider.js";
import { AuthService } from "./auth.js";
import {
  AppLifecycle,
  BACKGROUND_SYNC_INTERVAL_MIN,
  type LifecycleNotifications,
  type LifecycleSync,
} from "./lifecycle.js";

const NOW = Date.parse("2025-07-01T12:00:00Z");

/** Records calls in order into a shared log. */
class FakeNotifications implements LifecycleNotifications {
  exactRefresh: ExactAlarmRefresh = {
    exactAlarmsAvailable: true,
    reminderTimingMayVary: false,
    changed: false,
  };
  constructor(private readonly log: string[]) {}
  async ensurePermissionOnce(): Promise<PermissionCheck> {
    this.log.push("permission");
    return { permission: "granted", requested: false };
  }
  async refreshExactAlarmState(): Promise<ExactAlarmRefresh> {
    this.log.push("exact");
    return this.exactRefresh;
  }
  async reconcile(): Promise<unknown> {
    this.log.push("reconcile");
    return {};
  }
}

class FakeSync implements LifecycleSync {
  readonly triggers: SyncTrigger[] = [];
  error: unknown = null;
  constructor(private readonly log: string[]) {}
  async sync(trigger: SyncTrigger): Promise<SyncResult> {
    this.triggers.push(trigger);
    this.log.push(`sync:${trigger}`);
    if (this.error) throw this.error;
    return { status: "busy", trigger, lease: { owner: "other#1", expiresAt: NOW + 1 } };
  }
}

async function setup(
  status: "signed-in" | "signed-out" = "signed-in",
  opts: { tokens?: boolean; transportEnded?: boolean } = {},
) {
  const log: string[] = [];
  const repos = new Repositories(new MemoryKeyValueStore());
  const clock = new FakeClock(NOW);
  const jobs = new FakeBackgroundJobs();
  const auth = new AuthService({
    repos,
    vault: new FakeTokenVault(opts.tokens ? makeTokens() : null),
    auth: new ScriptableAuthClient(clock),
    clock,
    jobs,
  });
  await repos.authState.save(
    opts.transportEnded ? { status: "session-ended", reason: "transport" } : { status },
  );
  const notifications = new FakeNotifications(log);
  const sync = new FakeSync(log);
  const lifecycle = new AppLifecycle({ auth, notifications, sync, jobs });
  return { log, repos, jobs, auth, notifications, sync, lifecycle };
}

describe("AppLifecycle.onLaunch", () => {
  it("signed in: asks permission once, starts the 30-min job, syncs on launch, reconciles", async () => {
    const { lifecycle, log, jobs, sync } = await setup();
    const result = await lifecycle.onLaunch();

    expect(log).toEqual(["permission", "sync:launch", "reconcile"]);
    expect(sync.triggers).toEqual(["launch"]);
    expect(jobs.running).toBe(true);
    expect(jobs.intervalMin).toBe(BACKGROUND_SYNC_INTERVAL_MIN);
    expect(BACKGROUND_SYNC_INTERVAL_MIN).toBeLessThanOrEqual(60);
    expect(result).toMatchObject({ signedIn: true, backgroundStarted: true, reconciled: true, errors: [] });
    expect(result.sync?.status).toBe("ok");
  });

  it("not signed in: stops the background job and does not sync", async () => {
    const { lifecycle, log, jobs } = await setup("signed-out");
    await jobs.startPeriodicSync(BACKGROUND_SYNC_INTERVAL_MIN);
    const result = await lifecycle.onLaunch();

    expect(log).toEqual([]);
    expect(jobs.running).toBe(false);
    expect(result).toMatchObject({ signedIn: false, backgroundStarted: false });
  });

  it("SessionEnded from sync stops the job and marks the session ended", async () => {
    const { lifecycle, log, jobs, sync, repos } = await setup();
    sync.error = new SessionEnded("invalid-grant");
    const result = await lifecycle.onLaunch();

    expect(result.sync).toEqual({ status: "session-ended", reason: "invalid-grant" });
    expect(result.backgroundStarted).toBe(false);
    expect(jobs.running).toBe(false);
    expect(jobs.stops).toBe(1);
    expect(await repos.authState.get()).toEqual({ status: "session-ended", reason: "invalid-grant" });
    expect(log).not.toContain("reconcile");
  });

  it("restores a legacy transport-ended session when tokens remain, then launches normally", async () => {
    const { lifecycle, log, jobs, repos } = await setup("signed-out", {
      tokens: true,
      transportEnded: true,
    });
    const result = await lifecycle.onLaunch();
    expect(await repos.authState.get()).toEqual({ status: "signed-in" });
    expect(jobs.running).toBe(true);
    expect(log).toEqual(["permission", "sync:launch", "reconcile"]);
    expect(result).toMatchObject({ signedIn: true, backgroundStarted: true });
  });
  it("does not restore a transport-ended session when the vault is empty", async () => {
    const { lifecycle, log, repos } = await setup("signed-out", { transportEnded: true });
    const result = await lifecycle.onLaunch();
    expect(await repos.authState.get()).toEqual({ status: "session-ended", reason: "transport" });
    expect(result.signedIn).toBe(false);
    expect(log).toEqual([]);
  });
  it("AuthTransportError from sync is a soft failure: state unchanged, job keeps running", async () => {
    const { lifecycle, log, jobs, sync, repos } = await setup();
    sync.error = new AuthTransportError();
    const result = await lifecycle.onLaunch();
    expect(result.sync?.status).toBe("failed");
    expect(await repos.authState.get()).toEqual({ status: "signed-in" });
    expect(jobs.running).toBe(true);
    expect(log).toContain("reconcile");
    const fg = await lifecycle.onForeground();
    expect(fg.sync?.status).toBe("failed");
    expect(await repos.authState.get()).toEqual({ status: "signed-in" });
  });
  it("other sync failures are reported and reconcile still runs", async () => {
    const { lifecycle, log, sync } = await setup();
    sync.error = new Error("offline");
    const result = await lifecycle.onLaunch();
    expect(result.sync).toEqual({ status: "failed", error: "offline" });
    expect(log).toContain("reconcile");
  });
});

describe("AppLifecycle.onForeground", () => {
  it("signed in: syncs on foreground, then refreshes permission and exact-alarm state", async () => {
    const { lifecycle, log, sync, notifications } = await setup();
    notifications.exactRefresh = {
      exactAlarmsAvailable: true,
      reminderTimingMayVary: false,
      changed: true,
      reconciled: {
        exact: true,
        scheduled: ["b1"],
        shown: [],
        cancelled: [],
        inexactFallback: [],
        failed: [],
        registry: [],
      },
    };
    const result = await lifecycle.onForeground();

    expect(sync.triggers).toEqual(["foreground"]);
    expect(log).toEqual(["sync:foreground", "permission", "exact"]);
    expect(result.exactAlarm?.reconciled?.exact).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it("not signed in: refreshes state without syncing", async () => {
    const { lifecycle, log } = await setup("signed-out");
    const result = await lifecycle.onForeground();
    expect(log).toEqual(["permission", "exact"]);
    expect(result.sync).toBeUndefined();
  });

  it("SessionEnded from a foreground sync routes to auth.onSessionEnded", async () => {
    const { lifecycle, jobs, sync, repos } = await setup();
    await lifecycle.onLaunch();
    expect(jobs.running).toBe(true);

    sync.error = new SessionEnded("missing");
    const result = await lifecycle.onForeground();
    expect(result.sync).toEqual({ status: "session-ended", reason: "missing" });
    expect(jobs.running).toBe(false);
    expect((await repos.authState.get()).status).toBe("session-ended");

    // Next launch does not restart the job until the user signs in again.
    await lifecycle.onLaunch();
    expect(jobs.running).toBe(false);
  });
});
