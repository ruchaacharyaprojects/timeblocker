import { describe, expect, it } from "vitest";
import type { CalendarEvent } from "@timeblocker/calendar-integration";
import { SessionEnded, type DeviceBlock } from "../models.js";
import type { CalendarApi } from "../ports.js";
import { Repositories } from "../repositories.js";
import { FakeCalendar, FakeClock, MemoryKeyValueStore } from "../testkit.js";
import {
  MOVED_IN_CALENDAR_REASON,
  SYNC_READ_ERROR_MESSAGE,
  SYNC_STEPS,
  SyncService,
  decisionForLookup,
  diffBlocksAgainstWeek,
  weekIdOf,
} from "./syncService.js";

const T0 = Date.parse("2025-06-02T14:00:00Z"); // Monday; Toronto week of 2025-06-01
const WEEK = "2025-06-01";
const NEXT_WEEK = "2025-06-08";

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

const meeting = (id: string, overrides: Partial<CalendarEvent> = {}): CalendarEvent => ({
  id,
  summary: `Meeting ${id}`,
  start: "2025-06-04T15:00:00Z",
  end: "2025-06-04T16:00:00Z",
  withOthers: true,
  isBlock: false,
  ...overrides,
});

/** Synced local blocks plus their 🧱 events in the fake calendar. */
async function setup(blocks: DeviceBlock[], calendar = new FakeCalendar()) {
  for (const b of blocks) await calendar.upsertBlock({ ...b, calendarEventId: b.calendarEventId });
  calendar.calls.length = 0;
  const repos = new Repositories(new MemoryKeyValueStore());
  await repos.blocks.save(WEEK, blocks);
  const clock = new FakeClock(T0);
  const service = new SyncService({ repos, clock, runtimeId: "rt-a", calendar });
  return { repos, clock, service, calendar };
}

describe("weekIdOf", () => {
  it("is the Toronto Sunday of the instant's week", () => {
    expect(weekIdOf(T0)).toBe(WEEK);
    expect(weekIdOf("2025-06-01T04:00:00Z")).toBe(WEEK); // Sunday 00:00 Toronto
    expect(weekIdOf("2025-06-01T03:59:00Z")).toBe("2025-05-25"); // Saturday 23:59
    expect(weekIdOf("2025-06-10T14:00:00Z")).toBe(NEXT_WEEK);
  });
});

describe("pure reconciliation helpers", () => {
  it("only considers synced blocks without a pending write", () => {
    const blocks = [
      block("a", "tb0000000a"),
      block("b", "tb0000000b", { calendarSynced: false }),
      block("c", "tb0000000c"),
    ];
    const { decisions, missing } = diffBlocksAgainstWeek(blocks, new Set(["c"]), []);
    expect(decisions).toEqual([]);
    expect(missing.map((b) => b.id)).toEqual(["a"]);
  });

  it("ignores non-🧱 events with a matching id and equal instants in other formats", () => {
    const a = block("a", "tb0000000a");
    const sameTime = { ...meeting("tb0000000a"), isBlock: true, start: "2025-06-03T10:00:00-04:00", end: a.end };
    expect(diffBlocksAgainstWeek([a], new Set(), [sameTime]).decisions).toEqual([]);
    expect(diffBlocksAgainstWeek([a], new Set(), [meeting("tb0000000a")]).missing).toHaveLength(1);
  });

  it("a lookup at the same time and week changes nothing", () => {
    const a = block("a", "tb0000000a");
    const found = { ...meeting("tb0000000a"), start: a.start, end: a.end, isBlock: true };
    expect(decisionForLookup(a, found)).toBeUndefined();
    expect(decisionForLookup(a, "deleted")).toEqual({ kind: "remove", blockId: "a" });
  });
});

describe("SyncService read and reconcile (R14.1, R14.6, R14.7, R11.7)", () => {
  it("reads the current Toronto week and caches only non-🧱 events with syncedAt", async () => {
    const calendar = new FakeCalendar([
      meeting("m1"),
      meeting("solo", { withOthers: false, start: "2025-06-05T15:00:00Z", end: "2025-06-05T16:00:00Z" }),
      meeting("later", { start: "2025-06-10T15:00:00Z", end: "2025-06-10T16:00:00Z" }),
    ]);
    const { repos, service } = await setup([block("a", "tb0000000a")], calendar);

    const result = await service.sync("launch");

    expect(result).toMatchObject({ status: "completed", report: { stepsRun: [...SYNC_STEPS] } });
    const read = calendar.calls.find((c) => c.op === "readWeek")!;
    expect(read.target).toMatchObject({
      sunday: new Date(Date.parse("2025-06-01T04:00:00Z")).toISOString(),
    });
    const cache = await repos.calendarCache.get(WEEK);
    expect(cache?.syncedAt).toBe(T0);
    expect(cache?.events.map((e) => e.id)).toEqual(["m1", "solo"]);
    expect(calendar.opLog()).not.toContain("getEvent");
  });

  it("a 🧱 event moved within the week updates start/end, keeps status, and sets moveReason", async () => {
    const a = block("a", "tb0000000a", { status: "in-progress" });
    const { repos, service, calendar } = await setup([a, block("b", "tb0000000b")]);
    calendar.moveRemotely("tb0000000a", "2025-06-05T18:00:00Z", "2025-06-05T19:30:00Z");

    await service.sync("foreground");

    const [movedA, b] = await repos.blocks.get(WEEK);
    expect(movedA).toMatchObject({
      id: "a",
      start: "2025-06-05T18:00:00Z",
      end: "2025-06-05T19:30:00Z",
      status: "in-progress",
      weekId: WEEK,
      moveReason: MOVED_IN_CALENDAR_REASON,
      movedFrom: { start: a.start, end: a.end },
    });
    expect(b).toEqual(block("b", "tb0000000b"));
  });

  it("a 🧱 event deleted in Calendar removes the block", async () => {
    const { repos, service, calendar } = await setup([block("a", "tb0000000a"), block("b", "tb0000000b")]);
    calendar.deleteRemotely("tb0000000a");

    await service.sync("pull");

    expect((await repos.blocks.get(WEEK)).map((b) => b.id)).toEqual(["b"]);
    expect(calendar.opLog()).toEqual(["readWeek", "getEvent", "readWeek"]);
  });

  it("a 🧱 event moved to another week moves the block and its weekId", async () => {
    const { repos, service, calendar } = await setup([block("a", "tb0000000a")]);
    const n = block("n", "tb0000000n", {
      weekId: NEXT_WEEK,
      start: "2025-06-11T14:00:00Z",
      end: "2025-06-11T15:00:00Z",
    });
    await calendar.upsertBlock(n);
    await repos.blocks.save(NEXT_WEEK, [n]);
    calendar.moveRemotely("tb0000000a", "2025-06-10T14:00:00Z", "2025-06-10T15:00:00Z");

    await service.sync("launch");

    expect(await repos.blocks.get(WEEK)).toEqual([]);
    const next = await repos.blocks.get(NEXT_WEEK);
    expect(next.map((b) => b.id)).toEqual(["n", "a"]);
    expect(next[1]).toMatchObject({
      weekId: NEXT_WEEK,
      start: "2025-06-10T14:00:00Z",
      moveReason: MOVED_IN_CALENDAR_REASON,
    });
  });

  it("is idempotent: a second sync on the same calendar state changes no block", async () => {
    const { repos, service, calendar } = await setup([
      block("a", "tb0000000a"),
      block("b", "tb0000000b"),
      block("c", "tb0000000c"),
    ]);
    calendar.moveRemotely("tb0000000a", "2025-06-05T18:00:00Z", "2025-06-05T19:00:00Z");
    calendar.deleteRemotely("tb0000000b");
    calendar.moveRemotely("tb0000000c", "2025-06-11T18:00:00Z", "2025-06-11T19:00:00Z");

    await service.sync("launch");
    const after = [await repos.blocks.get(WEEK), await repos.blocks.get(NEXT_WEEK)];
    await service.sync("foreground");

    expect([await repos.blocks.get(WEEK), await repos.blocks.get(NEXT_WEEK)]).toEqual(after);
  });

  it("skips blocks with a pending write and unsynced blocks (local intent wins)", async () => {
    const pendingBlock = block("a", "tb0000000a");
    const unsynced = block("u", "tb0000000u", { calendarSynced: false });
    // The upsert is rejected (400), so the entry survives the flush and the read runs.
    const calendar = new FakeCalendar();
    const { repos, service } = await setup([pendingBlock], calendar);
    await repos.saveBlocksWithOutbox(WEEK, [pendingBlock, unsynced], [
      { blockId: "a", calendarEventId: "tb0000000a", op: "upsert", enqueuedAt: T0 },
    ]);
    calendar.moveRemotely("tb0000000a", "2025-06-05T18:00:00Z", "2025-06-05T19:00:00Z");
    calendar.failNext("upsertBlock", { kind: "status", status: 400 });

    await service.sync("launch");

    expect(await repos.blocks.get(WEEK)).toEqual([pendingBlock, unsynced]);
    expect(calendar.opLog()).toEqual(["upsertBlock", "readWeek", "readWeek"]);
  });

  it("a local change made while lookups are in flight wins over the calendar", async () => {
    const inner = new FakeCalendar();
    const a = block("a", "tb0000000a");
    const env = await setup([a], inner);
    inner.deleteRemotely("tb0000000a");
    const local = { ...a, status: "skipped" as const, updatedAt: T0 + 1 };
    const calendar: CalendarApi = {
      upsertBlock: (w) => inner.upsertBlock(w),
      deleteBlock: (id) => inner.deleteBlock(id),
      readWeek: (w) => inner.readWeek(w),
      getEvent: async (id) => {
        const found = await inner.getEvent(id);
        await env.repos.blocks.save(WEEK, [local]);
        return found;
      },
    };
    const service = new SyncService({ repos: env.repos, clock: env.clock, runtimeId: "rt-b", calendar });

    await service.sync("foreground");

    expect(await env.repos.blocks.get(WEEK)).toEqual([local]);
  });

  it("a read failure keeps local blocks and the cache, sets the banner, and stops", async () => {
    const { repos, service, calendar } = await setup([block("a", "tb0000000a")]);
    await repos.calendarCache.save(WEEK, { syncedAt: 1, events: [meeting("old")] });
    calendar.deleteRemotely("tb0000000a");
    calendar.failNext("readWeek", { kind: "status", status: 503 });

    const result = await service.sync("pull");

    expect(result).toMatchObject({ report: { stoppedAfter: "readAndReconcile" } });
    expect((await repos.blocks.get(WEEK)).map((b) => b.id)).toEqual(["a"]);
    expect(await repos.calendarCache.get(WEEK)).toEqual({ syncedAt: 1, events: [meeting("old")] });
    expect((await repos.syncState.get()).error).toMatchObject({
      message: SYNC_READ_ERROR_MESSAGE,
      dismissed: false,
    });
  });

  it("a failed lookup keeps that block, still caches the week, and stops", async () => {
    const calendar = new FakeCalendar([meeting("m1")]);
    const { repos, service } = await setup([block("a", "tb0000000a"), block("b", "tb0000000b")], calendar);
    calendar.deleteRemotely("tb0000000a");
    calendar.deleteRemotely("tb0000000b");
    calendar.failNext("getEvent", { kind: "network" });

    const result = await service.sync("background");

    expect(result).toMatchObject({ report: { stoppedAfter: "readAndReconcile" } });
    expect((await repos.blocks.get(WEEK)).map((b) => b.id)).toEqual(["a"]);
    expect((await repos.calendarCache.get(WEEK))?.events.map((e) => e.id)).toEqual(["m1"]);
    expect((await repos.syncState.get()).error?.message).toBe(SYNC_READ_ERROR_MESSAGE);
  });

  it("SessionEnded during the read propagates and keeps local blocks", async () => {
    const { repos, service, calendar } = await setup([block("a", "tb0000000a")]);
    calendar.failNext("readWeek", { kind: "network", error: new SessionEnded("revoked") });

    await expect(service.sync("launch")).rejects.toBeInstanceOf(SessionEnded);
    expect((await repos.blocks.get(WEEK)).map((b) => b.id)).toEqual(["a"]);
    expect((await repos.syncState.get()).lease).toBeUndefined();
  });
});
