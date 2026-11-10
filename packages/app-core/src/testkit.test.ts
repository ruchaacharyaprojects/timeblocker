/**
 * Smoke tests for the in-memory fakes: each fake's key behaviors that later
 * service tests rely on (failure injection, lost responses, permission and
 * exact-alarm toggles, deterministic ids).
 */
import { CalendarHttpError } from "@timeblocker/calendar-integration";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { isCalendarEventId, type CalendarBlockWrite, type NotificationPayload } from "./ports.js";
import {
  DeterministicIdGenerator,
  FakeBackgroundJobs,
  FakeCalendar,
  FakeClock,
  FakeHttpTransport,
  FakeNetworkError,
  FakeNotifier,
  FakeSystemSettings,
  FakeTokenVault,
  FakeUsageSource,
  MemoryKeyValueStore,
  ScriptableAuthClient,
  makeTokens,
} from "./testkit.js";

const WEEK = { sunday: "2025-03-09T05:00:00.000Z", saturday: "2025-03-16T04:00:00.000Z" };

function block(id: string, start = "2025-03-10T14:00:00.000Z", end = "2025-03-10T15:00:00.000Z"): CalendarBlockWrite {
  return { title: "Run", start, end, category: "fitness", calendarEventId: id };
}

function note(id: string): NotificationPayload {
  return { id, kind: "block-reminder", channel: "reminders", title: "t", body: "b", actions: [], sourceId: "b1" };
}

describe("MemoryKeyValueStore", () => {
  it("round-trips and keeps setMany all-or-nothing on injected failure", async () => {
    const kv = new MemoryKeyValueStore({ a: "1" });
    await kv.setMany([["b", "2"], ["c", "3"]]);
    expect(await kv.getMany(["a", "b", "x"])).toEqual([["a", "1"], ["b", "2"], ["x", null]]);
    kv.failNextWrite();
    await expect(kv.setMany([["a", "9"], ["d", "4"]])).rejects.toThrow();
    expect(kv.snapshot()).toEqual({ a: "1", b: "2", c: "3" });
    await kv.remove(["a", "b"]);
    expect(await kv.get("a")).toBeNull();
  });
});

describe("FakeTokenVault", () => {
  it("saves copies and counts clears", async () => {
    const vault = new FakeTokenVault();
    const tokens = makeTokens();
    await vault.save(tokens);
    tokens.accessToken = "mutated";
    expect((await vault.load())?.accessToken).toBe("access-0");
    await vault.clear();
    expect(await vault.load()).toBeNull();
    expect([vault.saves, vault.clears]).toEqual([1, 1]);
  });
});

describe("ScriptableAuthClient", () => {
  it("serves scripted results, then defaults; records refresh and revoke", async () => {
    const clock = new FakeClock(1_000);
    const auth = new ScriptableAuthClient(clock)
      .nextAuthorize({ kind: "cancelled" })
      .nextRefresh({ kind: "invalid-grant" });
    expect(await auth.authorize()).toEqual({ kind: "cancelled" });
    expect((await auth.authorize()).kind).toBe("ok");
    expect(await auth.refresh("r1")).toEqual({ kind: "invalid-grant" });
    const fresh = await auth.refresh("r1");
    expect(fresh.kind === "ok" && fresh.grant.expiresAtMs).toBe(1_000 + 3_600_000);
    expect(fresh.kind === "ok" && fresh.grant.refreshToken).toBeUndefined();
    await auth.revoke("r1");
    expect(auth.refreshCalls).toEqual(["r1", "r1"]);
    expect(auth.revoked).toEqual(["r1"]);
  });
});

describe("FakeHttpTransport", () => {
  it("records requests, fails and hangs on demand", async () => {
    const http = new FakeHttpTransport(() => ({ status: 200, body: "{}" }));
    http.failNext();
    await expect(http.request("GET", "https://www.googleapis.com/x", {}, undefined, { timeoutMs: 5 })).rejects.toBeInstanceOf(FakeNetworkError);
    http.hangNext();
    const hung = http.request("GET", "https://www.googleapis.com/y", {}, undefined, { timeoutMs: 5 });
    const raced = await Promise.race([hung, new Promise((r) => setTimeout(() => r("timeout"), 10))]);
    expect(raced).toBe("timeout");
    expect(await http.request("POST", "https://www.googleapis.com/z", { a: "b" }, "x", { timeoutMs: 5 })).toEqual({ status: 200, body: "{}" });
    expect(http.requests.map((r) => r.method)).toEqual(["GET", "GET", "POST"]);
  });
});

describe("FakeCalendar", () => {
  it("upserts 🧱 events idempotently and reads the week", async () => {
    const cal = new FakeCalendar([
      { id: "meet1", summary: "Standup", start: "2025-03-10T13:00:00.000Z", end: "2025-03-10T13:30:00.000Z", withOthers: true },
      { id: "out", summary: "Next week", start: "2025-03-17T13:00:00.000Z", end: "2025-03-17T14:00:00.000Z", withOthers: false },
    ]);
    expect(await cal.upsertBlock(block("tb00000001"))).toBe("tb00000001");
    expect(await cal.upsertBlock(block("tb00000001", "2025-03-11T14:00:00.000Z", "2025-03-11T15:00:00.000Z"))).toBe("tb00000001");
    expect(cal.blockEvents()).toHaveLength(1);
    expect(cal.event("tb00000001")).toMatchObject({ summary: "🧱 Run", isBlock: true, start: "2025-03-11T14:00:00.000Z" });
    expect((await cal.readWeek(WEEK)).map((e) => e.id)).toEqual(["meet1", "tb00000001"]);
  });

  it("injects status and network failures before any effect", async () => {
    const cal = new FakeCalendar();
    cal.failNext("upsertBlock", { kind: "status", status: 503 }).failNext("any", { kind: "network" });
    const err = await cal.upsertBlock(block("tb00000001")).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CalendarHttpError);
    expect((err as CalendarHttpError).status).toBe(503);
    await expect(cal.readWeek(WEEK)).rejects.toBeInstanceOf(FakeNetworkError);
    expect(cal.events()).toEqual([]);
    cal.failAll();
    await expect(cal.getEvent("x")).rejects.toThrow();
    await expect(cal.deleteBlock("x")).rejects.toThrow();
    cal.clearFailures();
    expect(await cal.getEvent("x")).toBe("deleted");
    expect(cal.opLog("failed")).toEqual(["upsertBlock", "readWeek", "getEvent", "deleteBlock"]);
  });

  it("a lost response applies the write but throws; the retry creates no duplicate", async () => {
    const cal = new FakeCalendar().loseNextResponse("upsertBlock");
    await expect(cal.upsertBlock(block("tb00000001"))).rejects.toBeInstanceOf(FakeNetworkError);
    expect(cal.blockEvents()).toHaveLength(1);
    expect(await cal.upsertBlock(block("tb00000001"))).toBe("tb00000001");
    expect(cal.blockEvents()).toHaveLength(1);
    expect(cal.calls.map((c) => c.outcome)).toEqual(["lost", "ok"]);
  });

  it("models remote deletion and moves", async () => {
    const cal = new FakeCalendar();
    await cal.upsertBlock(block("tb00000001"));
    await cal.upsertBlock(block("tb00000002"));
    cal.moveRemotely("tb00000002", "2025-03-12T14:00:00.000Z", "2025-03-12T15:00:00.000Z");
    expect(cal.event("tb00000002")?.start).toBe("2025-03-12T14:00:00.000Z");
    cal.deleteRemotely("tb00000001");
    expect(await cal.getEvent("tb00000001")).toBe("deleted");
    expect(await cal.upsertBlock(block("tb00000001"))).toBe("deleted");
    await expect(cal.deleteBlock("tb00000001")).resolves.toBeUndefined();
  });
});

describe("FakeNotifier", () => {
  it("replaces alarms by id, fires due ones, and cancels", async () => {
    const n = new FakeNotifier();
    await n.schedule(note("a"), 100, true);
    await n.schedule(note("a"), 200, false);
    await n.schedule(note("b"), 500, false);
    expect(n.pending.get("a")).toMatchObject({ fireAtMs: 200, exact: false });
    expect(n.fireDue(300).map((x) => x.id)).toEqual(["a"]);
    expect(await n.listPending()).toEqual(["b"]);
    await n.cancel("a");
    await n.cancel("b");
    expect([...n.posted.keys()]).toEqual([]);
    expect(await n.listPending()).toEqual([]);
    expect(n.shown.map((x) => x.id)).toEqual(["a"]);
  });

  it("honors permission and exact-alarm toggles", async () => {
    const n = new FakeNotifier({ permission: "undetermined", exactAllowed: false });
    expect(await n.canScheduleExact()).toBe(false);
    await expect(n.schedule(note("a"), 1, true)).rejects.toThrow();
    await n.showNow(note("s"));
    expect(n.dropped.map((x) => x.id)).toEqual(["s"]);
    n.requestOutcome = "denied";
    expect(await n.requestPermission()).toBe("denied");
    n.setPermission("granted");
    n.setExactAllowed(true);
    await n.schedule(note("a"), 1, true);
    await n.showNow(note("s"));
    expect(n.shown.map((x) => x.id)).toEqual(["s"]);
    expect(n.permissionRequests).toBe(1);
  });
});

describe("FakeClock", () => {
  it("sets and advances", () => {
    const c = new FakeClock("2025-03-10T14:00:00.000Z");
    c.advance(60_000);
    expect(new Date(c.now()).toISOString()).toBe("2025-03-10T14:01:00.000Z");
  });
});

describe("DeterministicIdGenerator", () => {
  it("is deterministic across instances", () => {
    const a = new DeterministicIdGenerator("blk");
    const b = new DeterministicIdGenerator("blk");
    expect([a.next(), a.next(), a.calendarEventId()]).toEqual([b.next(), b.next(), b.calendarEventId()]);
    expect(new DeterministicIdGenerator().calendarEventId()).toBe("tb00000001");
  });

  it("calendarEventId is always valid base32hex and unique (property)", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 2_000 }), (n) => {
        const gen = new DeterministicIdGenerator();
        const ids = Array.from({ length: n }, () => gen.calendarEventId());
        return ids.every(isCalendarEventId) && new Set(ids).size === n;
      }),
      { numRuns: 30 },
    );
  });
});

describe("FakeBackgroundJobs, FakeUsageSource, FakeSystemSettings", () => {
  it("record their calls", async () => {
    const jobs = new FakeBackgroundJobs();
    await jobs.startPeriodicSync(15);
    await jobs.stopPeriodicSync();
    expect([jobs.running, jobs.intervalMin, jobs.starts, jobs.stops]).toEqual([false, 15, 1, 1]);

    const usage = new FakeUsageSource([{ packageName: "com.x", foregroundTimeMs: 1_000 }]);
    expect(await usage.readUsage({ startMs: 0, endMs: 1 })).toHaveLength(1);
    usage.permissionState = "denied";
    expect(await usage.permission()).toBe("denied");
    expect(await usage.readUsage({ startMs: 0, endMs: 1 })).toEqual([]);

    const settings = new FakeSystemSettings();
    await settings.openExactAlarmSettings();
    await settings.openUsageAccess();
    expect(settings.opened).toEqual(["exact-alarms", "usage-access"]);
  });
});
