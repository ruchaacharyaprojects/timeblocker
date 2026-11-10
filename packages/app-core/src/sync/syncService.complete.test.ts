/**
 * Sync completion, banner, session end and the foreground timeout (18.5;
 * R13.7, R14.2, R14.10, R14.12).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CalendarEvent } from "@timeblocker/calendar-integration";
import { SessionEnded, type DeviceBlock } from "../models.js";
import type { ReconcileResult } from "../notifications/service.js";
import type { CalendarApi } from "../ports.js";
import { Repositories } from "../repositories.js";
import type { UsageRiskResult } from "../services/usageRisk.js";
import { AuthTransportError } from "../tokenProvider.js";
import { FakeCalendar, FakeClock, MemoryKeyValueStore } from "../testkit.js";
import {
  FOREGROUND_SYNC_TIMEOUT_MS,
  SYNC_LEASE_MS,
  SYNC_READ_ERROR_MESSAGE,
  SYNC_TIMEOUT_MESSAGE,
  SYNC_WRITE_ERROR_MESSAGE,
  SyncService,
  type SyncServiceDeps,
} from "./syncService.js";

const T0 = Date.parse("2025-06-02T14:00:00Z"); // Monday; Toronto week of 2025-06-01
const WEEK = "2025-06-01";

function block(id: string, eventId: string, overrides: Partial<DeviceBlock> = {}): DeviceBlock {
  return {
    id,
    itemId: `item-${id}`,
    title: `Task ${id}`,
    start: "2025-06-03T14:00:00Z",
    end: "2025-06-03T15:00:00Z",
    category: "work",
    status: "scheduled",
    weekId: WEEK,
    calendarEventId: eventId,
    calendarSynced: true,
    promptedMeetingIds: [],
    usagePrompted: false,
    updatedAt: T0,
    ...overrides,
  };
}

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/** Records the completion calls in order. */
function completionFakes(log: string[]) {
  const usageRisk = {
    async checkUpcoming(): Promise<UsageRiskResult> {
      log.push("usageRisk");
      return { status: "no-candidates", candidates: [], prompted: [], failed: [] };
    },
  };
  const notifications = {
    async reconcile(): Promise<ReconcileResult> {
      log.push("reconcile");
      return { exact: true, scheduled: [], shown: [], cancelled: [], inexactFallback: [], failed: [], registry: [] };
    },
  };
  return { usageRisk, notifications };
}

async function setup(options: { blocks?: DeviceBlock[]; calendar?: CalendarApi; deps?: Partial<SyncServiceDeps> } = {}) {
  const repos = new Repositories(new MemoryKeyValueStore());
  const clock = new FakeClock(T0);
  const log: string[] = [];
  const calendar = options.calendar ?? new FakeCalendar();
  if (options.blocks) {
    if (calendar instanceof FakeCalendar) {
      for (const b of options.blocks) await calendar.upsertBlock(b);
      calendar.calls.length = 0;
    }
    await repos.blocks.save(WEEK, options.blocks);
  }
  const service = new SyncService({
    repos,
    clock,
    runtimeId: "rt-a",
    calendar,
    ...completionFakes(log),
    ...options.deps,
  });
  return { repos, clock, log, calendar, service };
}

describe("sync completion (R13.7, R14.10)", () => {
  it("runs usage risk, then reconcile, then sets lastSuccessAt, clears the banner and releases the lease", async () => {
    const env = await setup({ blocks: [block("a", "tb0000000a")] });
    await env.repos.syncState.save({ error: { message: "old failure", at: T0 - 1, dismissed: false } });
    env.clock.advance(5_000);

    const result = await env.service.sync("pull");

    expect(result).toMatchObject({ status: "completed", report: { stepsRun: ["flushOutbox", "readAndReconcile", "promptConflicts", "complete"] } });
    expect(env.log).toEqual(["usageRisk", "reconcile"]);
    expect(await env.repos.syncState.get()).toEqual({ lastSuccessAt: T0 + 5_000 });
  });

  it("keeps the banner a rejected (4xx) write set in the same run and leaves lastSuccessAt alone", async () => {
    const calendar = new FakeCalendar();
    const env = await setup({ calendar });
    const b = block("a", "tb0000000a", { calendarSynced: false });
    await env.repos.saveBlocksWithOutbox(WEEK, [b], [
      { blockId: "a", calendarEventId: b.calendarEventId, op: "upsert", enqueuedAt: T0 },
    ]);
    await env.repos.syncState.save({ lastSuccessAt: T0 - 60_000 });
    calendar.failNext("upsertBlock", { kind: "status", status: 400 });

    await env.service.sync("foreground");

    const state = await env.repos.syncState.get();
    expect(state.error).toEqual({ message: SYNC_WRITE_ERROR_MESSAGE, at: T0, dismissed: false });
    expect(state.lastSuccessAt).toBe(T0 - 60_000);
    expect(state.lease).toBeUndefined();
    // The read succeeded, so usage risk and reconcile still ran.
    expect(env.log).toEqual(["usageRisk", "reconcile"]);
    expect(await env.repos.outbox.get()).toHaveLength(1);

    // The next clean sync clears it.
    env.clock.advance(1_000);
    await env.service.sync("foreground");
    expect(await env.repos.syncState.get()).toEqual({ lastSuccessAt: T0 + 1_000 });
    expect(await env.repos.outbox.get()).toEqual([]);
  });

  it("a read failure sets the banner and skips completion", async () => {
    const calendar = new FakeCalendar();
    const env = await setup({ calendar });
    await env.repos.syncState.save({ lastSuccessAt: T0 - 60_000 });
    calendar.failNext("readWeek", { kind: "network" });

    const result = await env.service.sync("pull");

    expect(result).toMatchObject({ status: "completed", report: { stoppedAfter: "readAndReconcile" } });
    expect(env.log).toEqual([]);
    expect(await env.repos.syncState.get()).toEqual({
      lastSuccessAt: T0 - 60_000,
      error: { message: SYNC_READ_ERROR_MESSAGE, at: T0, dismissed: false },
    });
  });

  it("does not record success without a calendar read, and a failing reconcile never fails the sync", async () => {
    const repos = new Repositories(new MemoryKeyValueStore());
    const service = new SyncService({
      repos,
      clock: new FakeClock(T0),
      runtimeId: "rt-a",
      notifications: {
        reconcile: () => Promise.reject(new Error("alarm manager down")),
      },
    });
    const result = await service.sync("launch");
    expect(result.status).toBe("completed");
    expect(await repos.syncState.get()).toEqual({});
  });
});

describe("dismissBanner (R14.10)", () => {
  it("dismisses the banner, keeps its message, and a new failure shows it again", async () => {
    const calendar = new FakeCalendar();
    const env = await setup({ calendar });
    calendar.failNext("readWeek", { kind: "network" });
    await env.service.sync("pull");

    await env.service.dismissBanner();
    expect((await env.repos.syncState.get()).error).toEqual({
      message: SYNC_READ_ERROR_MESSAGE,
      at: T0,
      dismissed: true,
    });

    env.clock.advance(1_000);
    calendar.failNext("readWeek", { kind: "network" });
    await env.service.sync("pull");
    expect((await env.repos.syncState.get()).error).toEqual({
      message: SYNC_READ_ERROR_MESSAGE,
      at: T0 + 1_000,
      dismissed: false,
    });
  });

  it("is a no-op without a banner", async () => {
    const env = await setup();
    await env.repos.syncState.save({ lastSuccessAt: 3 });
    await env.service.dismissBanner();
    expect(await env.repos.syncState.get()).toEqual({ lastSuccessAt: 3 });
  });
});

describe("SessionEnded during sync (R14.12)", () => {
  it("calls onSessionEnded once, keeps local blocks, releases the lease and still rejects", async () => {
    const calendar = new FakeCalendar();
    const ended: SessionEnded[] = [];
    const blocks = [block("a", "tb0000000a"), block("b", "tb0000000b")];
    const env = await setup({
      calendar,
      blocks,
      deps: { onSessionEnded: async (e) => void ended.push(e) },
    });
    const error = new SessionEnded("revoked");
    calendar.failNext("readWeek", { kind: "network", error });

    const first = env.service.sync("background");
    const joined = env.service.sync("pull");
    await expect(first).rejects.toBe(error);
    await expect(joined).rejects.toBe(error);

    expect(ended).toEqual([error]);
    expect(await env.repos.blocks.get(WEEK)).toEqual(blocks);
    expect((await env.repos.syncState.get()).lease).toBeUndefined();
    expect(env.log).toEqual([]);
    expect(env.service.syncing).toBe(false);
  });
});

describe("AuthTransportError during sync (R14.10)", () => {
  it("fails softly: banner set, no onSessionEnded, outbox and blocks kept", async () => {
    const calendar = new FakeCalendar();
    const ended: SessionEnded[] = [];
    const blocks = [block("a", "tb0000000a")];
    const env = await setup({
      calendar,
      blocks,
      deps: { onSessionEnded: async (e) => void ended.push(e) },
    });
    calendar.failNext("readWeek", { kind: "network", error: new AuthTransportError() });
    await env.service.sync("background");
    expect(ended).toEqual([]);
    expect((await env.repos.syncState.get()).error).toMatchObject({
      message: SYNC_READ_ERROR_MESSAGE,
      dismissed: false,
    });
    expect(await env.repos.blocks.get(WEEK)).toEqual(blocks);
    expect(await env.repos.authState.get()).toEqual({ status: "signed-out" });
  });
});
/** A calendar whose `readWeek` waits for the test to answer. */
function gatedCalendar(events: CalendarEvent[] = []) {
  const inner = new FakeCalendar(events);
  const gate = deferred();
  const calendar: CalendarApi = {
    readWeek: async (week) => {
      await gate.promise;
      return inner.readWeek(week);
    },
    getEvent: (id) => inner.getEvent(id),
    upsertBlock: (w) => inner.upsertBlock(w),
    deleteBlock: (id) => inner.deleteBlock(id),
  };
  return { calendar, open: () => gate.resolve() };
}

describe("foreground/pull timeout (R14.2)", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("a pull against a hanging transport resolves timed-out at 14 s with the banner set", async () => {
    const calendar = new FakeCalendar();
    const env = await setup({ calendar });
    await env.repos.syncState.save({ lastSuccessAt: T0 - 60_000 });
    calendar.failNext("readWeek", { kind: "hang" });

    let settled: unknown;
    void env.service.sync("pull").then((r) => (settled = r));
    await vi.advanceTimersByTimeAsync(FOREGROUND_SYNC_TIMEOUT_MS - 1);
    expect(settled).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);

    expect(FOREGROUND_SYNC_TIMEOUT_MS).toBeLessThan(15_000);
    expect(settled).toEqual({ status: "timed-out", trigger: "pull", calledAt: T0, timeoutMs: 14_000 });
    const state = await env.repos.syncState.get();
    expect(state.error).toEqual({ message: SYNC_TIMEOUT_MESSAGE, at: T0, dismissed: false });
    expect(state.lastSuccessAt).toBe(T0 - 60_000);
    // The stuck run keeps the lease until its call settles (or the lease expires).
    expect(state.lease?.owner).toBe("rt-a#1");
    expect(env.log).toEqual([]);

    // A second pull while it is stuck is bounded too, and nothing new runs.
    let again: unknown;
    void env.service.sync("pull").then((r) => (again = r));
    await vi.advanceTimersByTimeAsync(FOREGROUND_SYNC_TIMEOUT_MS);
    expect(again).toMatchObject({ status: "timed-out" });
    expect(calendar.calls.filter((c) => c.op === "readWeek")).toHaveLength(1);

    // Once the lease has expired, a new sync abandons the stuck run.
    env.clock.advance(SYNC_LEASE_MS);
    const fresh = env.service.sync("pull");
    await vi.advanceTimersByTimeAsync(0);
    await expect(fresh).resolves.toMatchObject({ status: "completed" });
    expect(await env.repos.syncState.get()).toEqual({ lastSuccessAt: T0 + SYNC_LEASE_MS });
  });

  it("an aborted run that settles late starts no further step, records no success and releases the lease", async () => {
    const gated = gatedCalendar();
    const env = await setup({ calendar: gated.calendar });

    const result = env.service.sync("foreground");
    await vi.advanceTimersByTimeAsync(FOREGROUND_SYNC_TIMEOUT_MS);
    await expect(result).resolves.toMatchObject({ status: "timed-out", trigger: "foreground" });
    expect(env.service.syncing).toBe(true);

    gated.open();
    await vi.advanceTimersByTimeAsync(0);
    expect(env.service.syncing).toBe(false);
    expect(env.log).toEqual([]);
    const state = await env.repos.syncState.get();
    expect(state.lease).toBeUndefined();
    expect(state.lastSuccessAt).toBeUndefined();
    expect(state.error?.message).toBe(SYNC_TIMEOUT_MESSAGE);
  });

  it("a fast pull clears its timer and never sets the timeout banner", async () => {
    const env = await setup();
    await expect(env.service.sync("pull")).resolves.toMatchObject({ status: "completed" });
    expect(vi.getTimerCount()).toBe(0);
    expect(await env.repos.syncState.get()).toEqual({ lastSuccessAt: T0 });
  });

  it("launch syncs are not bounded; a pull joining one times out without aborting it", async () => {
    const gated = gatedCalendar();
    const env = await setup({ calendar: gated.calendar });

    let launch: unknown;
    void env.service.sync("launch").then((r) => (launch = r));
    const pull = env.service.sync("pull");
    await vi.advanceTimersByTimeAsync(FOREGROUND_SYNC_TIMEOUT_MS);
    await expect(pull).resolves.toMatchObject({ status: "timed-out", trigger: "pull" });
    expect((await env.repos.syncState.get()).error).toBeUndefined();

    await vi.advanceTimersByTimeAsync(60_000);
    expect(launch).toBeUndefined();
    gated.open();
    await vi.advanceTimersByTimeAsync(0);
    expect(launch).toMatchObject({ status: "completed", trigger: "launch" });
    expect(env.log).toEqual(["usageRisk", "reconcile"]);
    expect(await env.repos.syncState.get()).toEqual({ lastSuccessAt: T0 });
  });
});
