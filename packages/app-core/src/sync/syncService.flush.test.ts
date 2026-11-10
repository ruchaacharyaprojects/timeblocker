import { describe, expect, it } from "vitest";
import { weekBounds } from "@timeblocker/scheduling-engine";
import { SessionEnded, type DeviceBlock } from "../models.js";
import type { CalendarApi, CalendarBlockWrite } from "../ports.js";
import { Repositories, type OutboxRequest } from "../repositories.js";
import { FakeCalendar, FakeClock, MemoryKeyValueStore } from "../testkit.js";
import {
  SYNC_STEPS,
  SYNC_WRITE_ERROR_MESSAGE,
  SyncService,
  classifyWriteFailure,
  outboxSearchWeekIds,
  type StepOutcome,
  type SyncContext,
} from "./syncService.js";
import { CalendarHttpError } from "@timeblocker/calendar-integration";

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
    calendarSynced: false,
    promptedMeetingIds: [],
    usagePrompted: false,
    updatedAt: T0,
    ...overrides,
  };
}

const upsert = (b: DeviceBlock): OutboxRequest => ({
  blockId: b.id,
  calendarEventId: b.calendarEventId,
  op: "upsert",
  enqueuedAt: T0,
});

/** Records the read so tests can check writes come first (R14.11). */
class ReadingSync extends SyncService {
  protected override async readAndReconcile(_ctx: SyncContext): Promise<StepOutcome> {
    await this.calendar!.readWeek(weekBounds(new Date(this.clock.now())));
    return "continue";
  }
}

function setup(calendar: CalendarApi | undefined = new FakeCalendar(), runtimeId = "rt-a", kv = new MemoryKeyValueStore()) {
  const clock = new FakeClock(T0);
  const repos = new Repositories(kv);
  const service = new ReadingSync({ repos, clock, runtimeId, calendar });
  return { kv, clock, repos, service, calendar };
}

async function seed(repos: Repositories, blocks: DeviceBlock[], requests = blocks.map(upsert)) {
  await repos.saveBlocksWithOutbox(WEEK, blocks, requests);
}

describe("classifyWriteFailure", () => {
  it("treats network, 5xx, 408 and 429 as transient and other 4xx as rejected", () => {
    expect(classifyWriteFailure(new Error("offline"))).toBe("transient");
    expect(classifyWriteFailure(new CalendarHttpError("insert", 503))).toBe("transient");
    expect(classifyWriteFailure(new CalendarHttpError("insert", 429))).toBe("transient");
    expect(classifyWriteFailure(new CalendarHttpError("update", 408))).toBe("transient");
    expect(classifyWriteFailure(new CalendarHttpError("insert", 400))).toBe("rejected");
    expect(classifyWriteFailure(new CalendarHttpError("update", 403))).toBe("rejected");
  });
});

describe("outboxSearchWeekIds", () => {
  it("starts at the current Toronto week and only yields Sundays", () => {
    const ids = outboxSearchWeekIds(T0);
    expect(ids[0]).toBe(WEEK);
    expect(ids).toContain("2025-06-08");
    expect(ids).toContain("2025-05-25");
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(new Date(`${id}T12:00:00Z`).getUTCDay()).toBe(0);
  });
});

describe("SyncService outbox flush (R14.8-R14.11)", () => {
  it("sends every write before the read and marks blocks synced", async () => {
    const calendar = new FakeCalendar();
    const { repos, service } = setup(calendar);
    const a = block("a", "tb00000001", { title: "🧱 Already prefixed" });
    const b = block("b", "tb00000002", { category: "fitness" });
    await seed(repos, [a, b]);

    const result = await service.sync("launch");

    expect(result).toMatchObject({ status: "completed", report: { stepsRun: [...SYNC_STEPS] } });
    expect(calendar.opLog()).toEqual(["upsertBlock", "upsertBlock", "readWeek"]);
    expect(calendar.calls.map((c) => c.target).slice(0, 2)).toEqual(["tb00000001", "tb00000002"]);
    const events = calendar.blockEvents();
    expect(events.map((e) => e.summary)).toEqual(["🧱 Already prefixed", "🧱 Task b"]);
    expect((await repos.blocks.get(WEEK)).every((x) => x.calendarSynced)).toBe(true);
    expect(await repos.outbox.get()).toEqual([]);
    expect((await repos.syncState.get()).error).toBeUndefined();
  });

  it("a lost response never creates a duplicate; the retry converges to one event", async () => {
    const calendar = new FakeCalendar().loseNextResponse("upsertBlock");
    const { repos, service } = setup(calendar);
    await seed(repos, [block("a", "tb00000001")]);

    const first = await service.sync("background");
    expect(first).toMatchObject({ report: { stoppedAfter: "flushOutbox" } });
    expect(calendar.opLog()).toEqual(["upsertBlock"]); // read skipped
    expect(await repos.outbox.get()).toMatchObject([{ blockId: "a", attempts: 1 }]);
    expect((await repos.blocks.get(WEEK))[0]!.calendarSynced).toBe(false);
    expect((await repos.syncState.get()).error).toMatchObject({
      message: SYNC_WRITE_ERROR_MESSAGE,
      dismissed: false,
    });

    await service.sync("foreground");
    expect(calendar.blockEvents()).toHaveLength(1);
    expect(await repos.outbox.get()).toEqual([]);
    expect((await repos.blocks.get(WEEK))[0]!.calendarSynced).toBe(true);
  });

  it("a 5xx keeps the entry and local blocks, sets the banner, and skips later writes and the read", async () => {
    const calendar = new FakeCalendar().failNext("upsertBlock", { kind: "status", status: 503 });
    const { repos, service } = setup(calendar);
    const blocks = [block("a", "tb00000001"), block("b", "tb00000002")];
    await seed(repos, blocks);
    const before = await repos.blocks.get(WEEK);

    const result = await service.sync("pull");

    expect(result).toMatchObject({ report: { stoppedAfter: "flushOutbox" } });
    expect(calendar.opLog()).toEqual(["upsertBlock"]);
    expect(await repos.blocks.get(WEEK)).toEqual(before);
    const outbox = await repos.outbox.get();
    expect(outbox.map((w) => [w.blockId, w.attempts])).toEqual([["a", 1], ["b", 0]]);
    expect(outbox[0]!.lastError).toContain("503");
    expect((await repos.syncState.get()).error?.message).toBe(SYNC_WRITE_ERROR_MESSAGE);
    expect((await repos.syncState.get()).lease).toBeUndefined();
  });

  it("another 4xx keeps that entry, sets the banner, and continues with the other writes and the read", async () => {
    const calendar = new FakeCalendar().failNext("upsertBlock", { kind: "status", status: 400 });
    const { repos, service } = setup(calendar);
    await seed(repos, [block("a", "tb00000001"), block("b", "tb00000002")]);

    const result = await service.sync("pull");

    expect(result).toMatchObject({ report: { stepsRun: [...SYNC_STEPS] } });
    expect(calendar.opLog()).toEqual(["upsertBlock", "upsertBlock", "readWeek"]);
    expect(await repos.outbox.get()).toMatchObject([{ blockId: "a", attempts: 1 }]);
    expect((await repos.blocks.get(WEEK)).map((b) => b.calendarSynced)).toEqual([false, true]);
    expect((await repos.syncState.get()).error?.message).toBe(SYNC_WRITE_ERROR_MESSAGE);
  });

  it("deletes the event for a delete entry, and an already-gone event counts as success", async () => {
    const calendar = new FakeCalendar();
    const { repos, service } = setup(calendar);
    await calendar.upsertBlock({ ...block("a", "tb00000001"), calendarEventId: "tb00000001" });
    await seed(repos, [], [
      { blockId: "a", calendarEventId: "tb00000001", op: "delete", enqueuedAt: T0 },
      { blockId: "z", calendarEventId: "tb0000000z", op: "delete", enqueuedAt: T0 },
    ]);

    await service.sync("launch");

    expect(calendar.event("tb00000001")).toBeUndefined();
    expect(await repos.outbox.get()).toEqual([]);
    expect((await repos.syncState.get()).error).toBeUndefined();
  });

  it("a PUT 404/410 on a synced block is treated as a remote deletion", async () => {
    const calendar = new FakeCalendar();
    const { repos, service } = setup(calendar);
    const a = block("a", "tb00000001", { calendarSynced: true });
    const b = block("b", "tb00000002");
    await calendar.upsertBlock({ ...a, calendarEventId: a.calendarEventId });
    calendar.deleteRemotely(a.calendarEventId);
    await seed(repos, [a, b]);

    await service.sync("foreground");

    expect((await repos.blocks.get(WEEK)).map((x) => x.id)).toEqual(["b"]);
    expect(await repos.outbox.get()).toEqual([]);
    expect(calendar.blockEvents().map((e) => e.id)).toEqual(["tb00000002"]);
  });

  it("finds blocks in other weeks and drops upserts whose block is gone", async () => {
    const calendar = new FakeCalendar();
    const { repos, service } = setup(calendar);
    const next = block("n", "tb00000003", {
      weekId: "2025-06-08",
      start: "2025-06-10T14:00:00Z",
      end: "2025-06-10T15:00:00Z",
    });
    await repos.saveBlocksWithOutbox("2025-06-08", [next], [
      upsert(next),
      { blockId: "ghost", calendarEventId: "tb00000009", op: "upsert", enqueuedAt: T0 },
    ]);

    await service.sync("launch");

    expect((await repos.blocks.get("2025-06-08"))[0]!.calendarSynced).toBe(true);
    expect(calendar.event("tb00000003")?.start).toBe("2025-06-10T14:00:00Z");
    expect(calendar.event("tb00000009")).toBeUndefined();
    expect(await repos.outbox.get()).toEqual([]);
  });

  it("keeps the entry when the block changed while its write was in flight", async () => {
    const inner = new FakeCalendar();
    let repos!: Repositories;
    const moved = { start: "2025-06-04T14:00:00Z", end: "2025-06-04T15:00:00Z" };
    const calendar: CalendarApi = {
      readWeek: (w) => inner.readWeek(w),
      getEvent: (id) => inner.getEvent(id),
      deleteBlock: (id) => inner.deleteBlock(id),
      upsertBlock: async (write: CalendarBlockWrite) => {
        const result = await inner.upsertBlock(write);
        // A local move lands while the request is in flight.
        const [b] = await repos.blocks.get(WEEK);
        await repos.saveBlocksWithOutbox(WEEK, [{ ...b!, ...moved }], [upsert(b!)]);
        return result;
      },
    };
    const env = setup(calendar);
    repos = env.repos;
    await seed(repos, [block("a", "tb00000001")]);

    await env.service.flush();
    expect(await repos.outbox.get()).toHaveLength(1);
    expect((await repos.blocks.get(WEEK))[0]).toMatchObject({ ...moved, calendarSynced: true });
  });

  it("SessionEnded propagates, keeps the outbox, and releases the lease", async () => {
    const calendar = new FakeCalendar().failNext("upsertBlock", {
      kind: "network",
      error: new SessionEnded("revoked"),
    });
    const { repos, service } = setup(calendar);
    await seed(repos, [block("a", "tb00000001")]);

    await expect(service.sync("background")).rejects.toBeInstanceOf(SessionEnded);
    expect(await repos.outbox.get()).toMatchObject([{ blockId: "a", attempts: 0 }]);
    expect((await repos.syncState.get()).lease).toBeUndefined();
  });

  it("without a calendar the flush keeps the outbox", async () => {
    const repos = new Repositories(new MemoryKeyValueStore());
    await seed(repos, [block("a", "tb00000001")]);
    await new SyncService({ repos, clock: new FakeClock(T0), runtimeId: "rt-x" }).sync("launch");
    expect(await repos.outbox.get()).toHaveLength(1);
  });
});

describe("SyncService.flush (PlanningFlusher)", () => {
  it("flushes without reading", async () => {
    const calendar = new FakeCalendar();
    const { repos, service } = setup(calendar);
    await seed(repos, [block("a", "tb00000001")]);

    const result = await service.flush();

    expect(result).toMatchObject({ status: "flushed", report: { synced: ["a"], stopped: false } });
    expect(calendar.opLog()).toEqual(["upsertBlock"]);
    expect((await repos.syncState.get()).lease).toBeUndefined();
  });

  it("joins an in-flight sync instead of sending writes twice", async () => {
    const calendar = new FakeCalendar();
    const { repos, service } = setup(calendar);
    await seed(repos, [block("a", "tb00000001")]);

    const sync = service.sync("launch");
    const flushed = await service.flush();

    expect(flushed).toMatchObject({ status: "joined", result: { status: "completed" } });
    await sync;
    expect(calendar.opLog()).toEqual(["upsertBlock", "readWeek"]);
  });

  it("a sync requested during a flush runs after it", async () => {
    const calendar = new FakeCalendar();
    const { repos, service } = setup(calendar);
    await seed(repos, [block("a", "tb00000001")]);

    const flushing = service.flush();
    const sync = service.sync("pull");
    await Promise.all([flushing, sync]);

    expect((await sync).status).toBe("completed");
    expect(calendar.opLog()).toEqual(["upsertBlock", "readWeek"]);
  });

  it("is busy while another process holds the lease", async () => {
    const kv = new MemoryKeyValueStore();
    const { repos, service } = setup(new FakeCalendar(), "rt-a", kv);
    await repos.syncState.save({ lease: { owner: "rt-b#1", expiresAt: T0 + 1000 } });
    expect(await service.flush()).toEqual({
      status: "busy",
      lease: { owner: "rt-b#1", expiresAt: T0 + 1000 },
    });
  });
});
