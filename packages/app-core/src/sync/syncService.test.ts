import { describe, expect, it } from "vitest";
import { Repositories } from "../repositories.js";
import { FakeClock, MemoryKeyValueStore } from "../testkit.js";
import {
  SYNC_LEASE_MS,
  SYNC_STEPS,
  SyncService,
  isLeaseValid,
  type StepOutcome,
  type SyncBody,
  type SyncContext,
  type SyncStep,
} from "./syncService.js";

const T0 = Date.parse("2025-06-02T14:00:00Z");

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** A body that records each run and waits on a gate the test opens. */
function gatedBody() {
  const runs: SyncContext[] = [];
  const gate = deferred();
  const body: SyncBody = async (ctx) => {
    runs.push(ctx);
    await gate.promise;
    return { stepsRun: [] };
  };
  return {
    runs,
    body,
    open() {
      gate.resolve();
    },
  };
}

/** Let pending microtasks (store reads/writes) settle. */
const flush = () => new Promise((r) => setTimeout(r, 0));

function setup(runtimeId = "rt-a", body?: SyncBody, kv = new MemoryKeyValueStore()) {
  const clock = new FakeClock(T0);
  const repos = new Repositories(kv);
  const service = new SyncService({ repos, clock, runtimeId, body });
  return { kv, clock, repos, service };
}

describe("isLeaseValid", () => {
  it("is valid strictly before expiresAt", () => {
    const lease = { owner: "x#1", expiresAt: 100 };
    expect(isLeaseValid(lease, 99)).toBe(true);
    expect(isLeaseValid(lease, 100)).toBe(false);
    expect(isLeaseValid(undefined, 0)).toBe(false);
  });
});

describe("SyncService single flight (R14.3)", () => {
  it("joins same-runtime callers to the in-flight sync and runs the body once", async () => {
    const gate = gatedBody();
    const { service } = setup("rt-a", gate.body);

    const first = service.sync("launch");
    // A pull joiner gets its own 14 s bound (18.5), so the promise differs;
    // it still resolves to the very same result object below.
    const second = service.sync("pull");
    expect(service.syncing).toBe(true);

    await flush();
    gate.open();
    const [a, b] = await Promise.all([first, second]);
    expect(gate.runs).toHaveLength(1);
    expect(a).toBe(b);
    expect(a).toMatchObject({ status: "completed", trigger: "launch" });
    expect(service.syncing).toBe(false);
  });

  it("persists a lease with expiresAt = now + 2 min while running and releases it after", async () => {
    const gate = gatedBody();
    const { repos, service } = setup("rt-a", gate.body);
    await repos.syncState.save({ lastSuccessAt: 7 });

    const run = service.sync("foreground");
    await flush();
    expect(await repos.syncState.get()).toEqual({
      lastSuccessAt: 7,
      lease: { owner: "rt-a#1", expiresAt: T0 + SYNC_LEASE_MS },
    });
    expect(gate.runs[0]).toEqual({ trigger: "foreground", startedAt: T0, leaseOwner: "rt-a#1" });

    gate.open();
    await run;
    expect(await repos.syncState.get()).toEqual({ lastSuccessAt: 7 });
  });

  it("starts a new sync after the previous one finished", async () => {
    const runs: string[] = [];
    const { service } = setup("rt-a", async (ctx) => {
      runs.push(ctx.leaseOwner);
      return { stepsRun: [] };
    });
    await service.sync("launch");
    await service.sync("pull");
    expect(runs).toEqual(["rt-a#1", "rt-a#2"]);
  });

  it("another process never starts while a valid lease exists", async () => {
    const gate = gatedBody();
    const kv = new MemoryKeyValueStore();
    const a = setup("rt-a", gate.body, kv);
    const otherRuns: string[] = [];
    const b = setup("rt-b", async (ctx) => {
      otherRuns.push(ctx.leaseOwner);
      return { stepsRun: [] };
    }, kv);

    const running = a.service.sync("foreground");
    await flush();
    const result = await b.service.sync("background");
    expect(result).toEqual({
      status: "busy",
      trigger: "background",
      lease: { owner: "rt-a#1", expiresAt: T0 + SYNC_LEASE_MS },
    });
    expect(otherRuns).toEqual([]);

    gate.open();
    await running;
    expect((await b.service.sync("background")).status).toBe("completed");
    expect(otherRuns).toEqual(["rt-b#1"]);
  });

  it("a new process waits out a crashed run's lease, then takes it over at expiry", async () => {
    const kv = new MemoryKeyValueStore();
    const runs: string[] = [];
    const { clock, repos, service } = setup("rt-new", async (ctx) => {
      runs.push(ctx.leaseOwner);
      return { stepsRun: [] };
    }, kv);
    await repos.syncState.save({ lease: { owner: "rt-dead#3", expiresAt: T0 + 60_000 } });

    clock.set(T0 + 59_999);
    expect((await service.sync("background")).status).toBe("busy");
    expect(runs).toEqual([]);

    clock.set(T0 + 60_000);
    const result = await service.sync("background");
    expect(result.status).toBe("completed");
    expect(runs).toEqual(["rt-new#1"]);
    expect((await repos.syncState.get()).lease).toBeUndefined();
  });

  it("releases the lease and rejects every joined caller when the body throws", async () => {
    let fail = true;
    const { repos, service } = setup("rt-a", async () => {
      await flush();
      if (fail) throw new Error("boom");
      return { stepsRun: [] };
    });
    const first = service.sync("launch");
    const second = service.sync("pull");
    await expect(first).rejects.toThrow("boom");
    await expect(second).rejects.toThrow("boom");
    expect((await repos.syncState.get()).lease).toBeUndefined();

    fail = false;
    expect((await service.sync("pull")).status).toBe("completed");
  });

  it("takes over its own stale lease when a release write failed", async () => {
    const kv = new MemoryKeyValueStore();
    let runs = 0;
    const { repos, service } = setup("rt-a", async () => {
      runs += 1;
      if (runs === 1) kv.failNextWrite(); // the first run's release write fails
      return { stepsRun: [] };
    }, kv);
    expect((await service.sync("launch")).status).toBe("completed");
    expect((await repos.syncState.get()).lease?.owner).toBe("rt-a#1");

    // Still within 2 min, but nothing is in flight in this runtime.
    expect((await service.sync("pull")).status).toBe("completed");
    expect((await repos.syncState.get()).lease).toBeUndefined();
  });

  it("does not release a lease that another owner has since taken", async () => {
    const kv = new MemoryKeyValueStore();
    const { clock, repos, service } = setup("rt-a", async () => {
      // Run overran its lease and another process took over.
      clock.advance(SYNC_LEASE_MS);
      await repos.syncState.save({ lease: { owner: "rt-b#1", expiresAt: clock.now() + SYNC_LEASE_MS } });
      return { stepsRun: [] };
    }, kv);
    await service.sync("background");
    expect((await repos.syncState.get()).lease?.owner).toBe("rt-b#1");
  });
});

describe("SyncService default body", () => {
  class RecordingSync extends SyncService {
    readonly calls: SyncStep[] = [];
    stopAt?: SyncStep;

    private record(step: SyncStep): StepOutcome {
      this.calls.push(step);
      return step === this.stopAt ? "stop" : "continue";
    }
    protected override async flushOutbox() {
      return this.record("flushOutbox");
    }
    protected override async readAndReconcile() {
      return this.record("readAndReconcile");
    }
    protected override async promptConflicts() {
      return this.record("promptConflicts");
    }
    protected override async complete() {
      return this.record("complete");
    }
  }

  const make = () =>
    new RecordingSync({
      repos: new Repositories(new MemoryKeyValueStore()),
      clock: new FakeClock(T0),
      runtimeId: "rt-a",
    });

  it("runs flush → read/reconcile → conflict prompts → completion in order", async () => {
    const service = make();
    const result = await service.sync("launch");
    expect(service.calls).toEqual([...SYNC_STEPS]);
    expect(result).toEqual({
      status: "completed",
      trigger: "launch",
      startedAt: T0,
      finishedAt: T0,
      report: { stepsRun: [...SYNC_STEPS] },
    });
  });

  it("skips the remaining steps when a step returns stop", async () => {
    const service = make();
    service.stopAt = "flushOutbox";
    const result = await service.sync("background");
    expect(service.calls).toEqual(["flushOutbox"]);
    expect(result).toMatchObject({ report: { stepsRun: ["flushOutbox"], stoppedAfter: "flushOutbox" } });
  });

  it("the unfilled skeleton steps all continue", async () => {
    const service = new SyncService({
      repos: new Repositories(new MemoryKeyValueStore()),
      clock: new FakeClock(T0),
      runtimeId: "rt-a",
    });
    const result = await service.sync("pull");
    expect(result).toMatchObject({ status: "completed", report: { stepsRun: [...SYNC_STEPS] } });
  });
});
