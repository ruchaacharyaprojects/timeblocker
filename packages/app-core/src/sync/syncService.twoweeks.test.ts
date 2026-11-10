import { describe, expect, it, vi } from "vitest";
import type { CalendarEvent } from "@timeblocker/calendar-integration";
import { SessionEnded, type DeviceBlock } from "../models.js";
import type { CalendarApi, Notifier } from "../ports.js";
import { Repositories } from "../repositories.js";
import { FakeCalendar, FakeClock, MemoryKeyValueStore } from "../testkit.js";
import { SyncService } from "./syncService.js";

// Monday of Toronto week 2025-06-01; next week is 2025-06-08.
const T0 = Date.parse("2025-06-02T14:00:00Z");
const WEEK = "2025-06-01";
const NEXT = "2025-06-08";

function block(id: string, eventId: string, overrides: Partial<DeviceBlock> = {}): DeviceBlock {
  return {
    id,
    itemId: `item-${id}`,
    title: `Task ${id}`,
    start: "2025-06-10T14:00:00Z",
    end: "2025-06-10T15:00:00Z",
    category: "work",
    status: "scheduled",
    weekId: NEXT,
    calendarEventId: eventId,
    calendarSynced: true,
    promptedMeetingIds: [],
    usagePrompted: false,
    updatedAt: T0,
    ...overrides,
  };
}
const meeting = (id: string, start: string, end: string): CalendarEvent => ({
  id,
  summary: `Meeting ${id}`,
  start,
  end,
  withOthers: true,
  isBlock: false,
});

type Wrap = (inner: FakeCalendar, readCount: () => number) => CalendarApi;

async function setup(blocks: DeviceBlock[], wrap?: Wrap, notifier?: Notifier) {
  const inner = new FakeCalendar();
  for (const b of blocks) await inner.upsertBlock(b);
  inner.calls.length = 0;
  const repos = new Repositories(new MemoryKeyValueStore());
  for (const b of blocks) {
    await repos.blocks.save(b.weekId, [...(await repos.blocks.get(b.weekId)), b]);
  }
  let reads = 0;
  const counting: CalendarApi = {
    upsertBlock: (w) => inner.upsertBlock(w),
    deleteBlock: (id) => inner.deleteBlock(id),
    getEvent: (id) => inner.getEvent(id),
    readWeek: (w) => {
      reads += 1;
      return inner.readWeek(w);
    },
  };
  const calendar = wrap ? wrap(inner, () => reads) : counting;
  const clock = new FakeClock(T0);
  const service = new SyncService({ repos, clock, runtimeId: "rt", calendar, notifier });
  return { inner, repos, service, clock };
}

/** Fails (or throws `error`) on the second `readWeek` only. */
const failSecondRead =
  (error: Error): Wrap =>
  (inner) => {
    let n = 0;
    return {
      upsertBlock: (w) => inner.upsertBlock(w),
      deleteBlock: (id) => inner.deleteBlock(id),
      getEvent: (id) => inner.getEvent(id),
      readWeek: (w) => {
        n += 1;
        return n === 2 ? Promise.reject(error) : inner.readWeek(w);
      },
    };
  };

describe("SyncService two-week read (R31.2)", () => {
  it("reads the current then the next week once each and caches both", async () => {
    const { inner, repos, service } = await setup([]);
    inner.addEvent(meeting("cur", "2025-06-03T14:00:00Z", "2025-06-03T15:00:00Z"));
    inner.addEvent(meeting("nxt", "2025-06-11T14:00:00Z", "2025-06-11T15:00:00Z"));

    await service.sync("launch");

    expect(inner.calls.filter((c) => c.op === "readWeek").map((c) => (c.target as { sunday: string }).sunday.slice(0, 10)))
      .toEqual(["2025-06-01", "2025-06-08"]);
    expect((await repos.calendarCache.get(WEEK))?.events.map((e) => e.id)).toEqual(["cur"]);
    const next = await repos.calendarCache.get(NEXT);
    expect(next?.events.map((e) => e.id)).toEqual(["nxt"]);
    expect(next?.syncedAt).toBe(T0);
    expect((await repos.syncState.get()).lastSuccessAt).toBe(T0);
  });

  it("keeps next-week blocks whose events exist and does not cache 🧱 events", async () => {
    const b = block("n", "tb0000000n");
    const { repos, service } = await setup([b]);

    await service.sync("pull");

    expect(await repos.blocks.get(NEXT)).toEqual([b]);
    expect((await repos.calendarCache.get(NEXT))?.events).toEqual([]);
  });

  it("applies move/delete rules to next-week blocks", async () => {
    const m = block("m", "tb0000000m");
    const d = block("d", "tb0000000d");
    const { inner, repos, service } = await setup([m, d]);
    inner.moveRemotely("tb0000000m", "2025-06-12T14:00:00Z", "2025-06-12T15:00:00Z");
    inner.deleteRemotely("tb0000000d");

    await service.sync("launch");

    const blocks = await repos.blocks.get(NEXT);
    expect(blocks.map((x) => x.id)).toEqual(["m"]);
    expect(blocks[0]).toMatchObject({ start: "2025-06-12T14:00:00Z", weekId: NEXT });
  });

  it("a failed next-week read keeps its cache and blocks, sets no banner, and succeeds", async () => {
    const b = block("n", "tb0000000n");
    const { repos, service } = await setup([b], failSecondRead(new Error("boom")));
    await repos.calendarCache.save(NEXT, { syncedAt: 1, events: [] });

    const result = await service.sync("foreground");

    expect(result).toMatchObject({ status: "completed" });
    expect(await repos.calendarCache.get(NEXT)).toEqual({ syncedAt: 1, events: [] });
    expect(await repos.blocks.get(NEXT)).toEqual([b]);
    const state = await repos.syncState.get();
    expect(state.error).toBeUndefined();
    expect(state.lastSuccessAt).toBe(T0);
    expect((await repos.calendarCache.get(WEEK))?.syncedAt).toBe(T0);
  });

  it("a failed current-week read does not read next week (behavior unchanged)", async () => {
    const { inner, repos, service } = await setup([]);
    inner.failNext("readWeek", { kind: "status", status: 503 });

    const result = await service.sync("pull");

    expect(result).toMatchObject({ report: { stoppedAfter: "readAndReconcile" } });
    expect(inner.opLog()).toEqual(["readWeek"]);
    expect(await repos.calendarCache.get(NEXT)).toBeNull();
    expect((await repos.syncState.get()).error?.dismissed).toBe(false);
  });

  it("SessionEnded on the next-week read ends the session", async () => {
    const onSessionEnded = vi.fn();
    const inner = new FakeCalendar();
    const repos = new Repositories(new MemoryKeyValueStore());
    const service = new SyncService({
      repos,
      clock: new FakeClock(T0),
      runtimeId: "rt",
      calendar: failSecondRead(new SessionEnded("revoked"))(inner, () => 0),
      onSessionEnded,
    });

    await expect(service.sync("launch")).rejects.toBeInstanceOf(SessionEnded);
    expect(onSessionEnded).toHaveBeenCalledTimes(1);
    expect((await repos.syncState.get()).lease).toBeUndefined();
  });

  it("skips the next-week read when the run passed its deadline", async () => {
    vi.useFakeTimers();
    try {
      const inner = new FakeCalendar();
      let reads = 0;
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      const calendar: CalendarApi = {
        upsertBlock: (w) => inner.upsertBlock(w),
        deleteBlock: (id) => inner.deleteBlock(id),
        getEvent: (id) => inner.getEvent(id),
        readWeek: async (w) => {
          reads += 1;
          if (reads === 1) await gate;
          return inner.readWeek(w);
        },
      };
      const repos = new Repositories(new MemoryKeyValueStore());
      const service = new SyncService({ repos, clock: new FakeClock(T0), runtimeId: "rt", calendar });

      const pending = service.sync("pull");
      await vi.advanceTimersByTimeAsync(14_000);
      await expect(pending).resolves.toMatchObject({ status: "timed-out" });
      release();
      await vi.advanceTimersByTimeAsync(10);

      expect(reads).toBe(1);
      expect(await repos.calendarCache.get(NEXT)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("joins a concurrent sync: two reads in total, not four", async () => {
    const { inner, service } = await setup([]);

    await Promise.all([service.sync("pull"), service.sync("foreground")]);

    expect(inner.opLog().filter((o) => o === "readWeek")).toHaveLength(2);
  });

  it("prompts for a next-week block overlapping a next-week meeting, once", async () => {
    const shown: string[] = [];
    const notifier = { showNow: async (p: { id: string }) => void shown.push(p.id) } as unknown as Notifier;
    const b = block("n", "tb0000000n");
    const { inner, repos, service } = await setup([b], undefined, notifier);
    inner.addEvent(meeting("mx", "2025-06-10T14:30:00Z", "2025-06-10T15:30:00Z"));
    inner.addEvent(meeting("far", "2025-06-18T14:00:00Z", "2025-06-18T15:00:00Z"));

    await service.sync("launch");
    await service.sync("launch");

    expect(shown).toEqual(["miss:n"]);
    expect((await repos.blocks.get(NEXT))[0]?.promptedMeetingIds).toEqual(["mx"]);
  });
});
