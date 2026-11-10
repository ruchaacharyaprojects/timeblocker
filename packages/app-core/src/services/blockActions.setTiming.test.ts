import type { CalendarEvent } from "@timeblocker/calendar-integration";
import { describe, expect, it } from "vitest";
import { UNDO_WINDOW_MS, undoEntriesOf, type DeviceBlock, type UndoToken } from "../models.js";
import { NotificationService } from "../notifications/service.js";
import { Repositories } from "../repositories.js";
import { FakeClock, FakeNotifier, MemoryKeyValueStore } from "../testkit.js";
import { buildDashboard } from "../viewModels/dashboard.js";
import {
  BlockActionService,
  TIMING_DISPLACED_REASON,
  TIMING_MOVED_REASON,
  describeSetTiming,
  type SetTimingResult,
} from "./blockActions.js";

const WEEK = "2025-07-06";
/** Monday 2025-07-07 08:00 Toronto (EDT = UTC-4). */
const NOW = "2025-07-07T12:00:00.000Z";
const ms = (iso: string) => Date.parse(iso);

// Free windows this week (Toronto): Mon 16:30-18:00, Mon 19:00-21:30, Tue 07:10-08:00,
// Sat 10:00-18:00, Sat 19:00-21:00 (weekday work hours, dinner, commutes and sleep are protected).
const MON_1630 = "2025-07-07T20:30:00.000Z";
const MON_1900 = "2025-07-07T23:00:00.000Z";
const MON_2000 = "2025-07-08T00:00:00.000Z";

const at = (iso: string, min: number) => new Date(ms(iso) + min * 60_000).toISOString();
const block = (id: string, start: string, min: number, overrides: Partial<DeviceBlock> = {}): DeviceBlock => ({
  id,
  itemId: `item-${id}`,
  title: `Task ${id}`,
  start,
  end: at(start, min),
  category: "self-development",
  status: "scheduled",
  weekId: WEEK,
  calendarEventId: `tbevent${id}`,
  calendarSynced: true,
  promptedMeetingIds: [],
  usagePrompted: false,
  updatedAt: 0,
  ...overrides,
});
const meeting = (id: string, start: string, end: string): CalendarEvent => ({
  id,
  summary: `Meeting ${id}`,
  start,
  end,
  withOthers: true,
  isBlock: false,
});

async function setup(blocks: DeviceBlock[], events: CalendarEvent[] = []) {
  const kv = new MemoryKeyValueStore();
  const repos = new Repositories(kv);
  const clock = new FakeClock(NOW);
  const notifier = new FakeNotifier();
  const real = new NotificationService(repos, notifier, clock);
  await repos.blocks.save(WEEK, blocks);
  await repos.calendarCache.save(WEEK, { syncedAt: ms(NOW), events });
  await real.reconcile();
  const track = { reconciles: 0, flushes: 0, writesAtReconcile: -1, writesStart: kv.writes };
  const notifications = {
    reconcile: () => {
      track.reconciles += 1;
      if (track.writesAtReconcile < 0) track.writesAtReconcile = kv.writes - track.writesStart;
      return real.reconcile();
    },
  };
  const flusher = {
    flush: async () => {
      track.flushes += 1;
    },
  };
  const service = new BlockActionService({ repos, clock, notifier, notifications, flusher });
  const ref = (blockId: string) => ({ weekId: WEEK, blockId });
  const byId = async (id: string) => (await repos.blocks.get(WEEK)).find((b) => b.id === id)!;
  return { kv, repos, clock, service, track, ref, byId };
}

describe("setTiming: moving", () => {
  it("moves a task to a free slot with one write, one upsert, and a single-entry undo", async () => {
    const { repos, service, ref, track, byId } = await setup([block("t", MON_1630, 60)]);
    const result = await service.setTiming(ref("t"), { start: MON_1900 });
    expect(result).toMatchObject({
      kind: "changed",
      moved: [],
      from: { start: MON_1630, end: at(MON_1630, 60) },
      to: { start: MON_1900, end: at(MON_1900, 60) },
      undo: { expiresAt: ms(NOW) + UNDO_WINDOW_MS, blockIds: ["t"] },
    });
    expect(await byId("t")).toMatchObject({
      start: MON_1900,
      end: at(MON_1900, 60),
      movedFrom: { start: MON_1630, end: at(MON_1630, 60) },
      moveReason: TIMING_MOVED_REASON,
      updatedAt: ms(NOW),
    });
    expect(track.writesAtReconcile).toBe(1);
    expect(track.reconciles).toBe(1);
    expect(track.flushes).toBe(1);
    const outbox = await repos.outbox.get();
    expect(outbox.map((o) => [o.blockId, o.op])).toEqual([["t", "upsert"]]);
    expect(describeSetTiming(result)).toBe("Moved Task t.");
  });

  it("displaces a scheduled task it lands on to the nearest later slot", async () => {
    const { service, ref, byId, repos } = await setup([
      block("t", MON_1630, 60),
      block("b", MON_1900, 60),
    ]);
    const result = await service.setTiming(ref("t"), { start: MON_1900 });
    expect(result.kind).toBe("changed");
    if (result.kind !== "changed") return;
    expect(result.moved).toHaveLength(1);
    expect(result.moved[0]).toMatchObject({
      from: { start: MON_1900, end: MON_2000 },
      to: { start: MON_2000, end: at(MON_2000, 60) },
    });
    expect(await byId("b")).toMatchObject({
      start: MON_2000,
      movedFrom: { start: MON_1900, end: MON_2000 },
      moveReason: TIMING_DISPLACED_REASON,
    });
    expect((await repos.outbox.get()).map((o) => o.blockId).sort()).toEqual(["b", "t"]);
    expect(describeSetTiming(result)).toBe("Moved Task t. Also moved Task b.");
  });

  it("goes earlier when there is no later slot (end of Saturday)", async () => {
    const SAT_10 = "2025-07-12T14:00:00.000Z";
    const SAT_20 = "2025-07-13T00:00:00.000Z";
    const SAT_19 = "2025-07-12T23:00:00.000Z";
    const { service, ref, byId } = await setup([block("t", SAT_10, 60), block("b", SAT_20, 60)]);
    const result = await service.setTiming(ref("t"), { start: SAT_20 });
    expect(result.kind).toBe("changed");
    expect(await byId("b")).toMatchObject({ start: SAT_19, end: SAT_20 });
  });

  it("re-places a chain of displaced tasks in start order", async () => {
    const { service, ref, byId } = await setup([
      block("t", MON_1630, 60),
      // Listed out of order on purpose.
      block("b2", at(MON_1900, 45), 45),
      block("b1", MON_1900, 45),
    ]);
    const result = await service.setTiming(ref("t"), { start: MON_1900 });
    expect(result.kind).toBe("changed");
    if (result.kind !== "changed") return;
    expect(result.moved.map((m) => m.block.id)).toEqual(["b1", "b2"]);
    expect(await byId("b1")).toMatchObject({ start: MON_2000, end: at(MON_2000, 45) });
    expect(await byId("b2")).toMatchObject({ start: at(MON_2000, 45), end: at(MON_2000, 90) });
    expect(describeSetTiming(result)).toBe("Moved Task t. Also moved Task b1 and Task b2.");
  });

  it("duration-only change records no movedFrom and keeps an earlier one", async () => {
    const prior = { start: MON_1630, end: at(MON_1630, 30) };
    const { service, ref, byId } = await setup([
      block("t", MON_1900, 45, { movedFrom: prior, moveReason: "Moved by you" }),
    ]);
    const result = await service.setTiming(ref("t"), { start: MON_1900, durationMin: 60 });
    expect(result).toMatchObject({ kind: "changed", to: { start: MON_1900, end: MON_2000 } });
    expect(await byId("t")).toMatchObject({ end: MON_2000, movedFrom: prior, moveReason: "Moved by you" });

    const fresh = await setup([block("u", MON_1900, 45)]);
    await fresh.service.setTiming(fresh.ref("u"), { start: MON_1900, durationMin: 60 });
    const u = await fresh.byId("u");
    expect(u.end).toBe(MON_2000);
    expect(u.movedFrom).toBeUndefined();
    expect(u.moveReason).toBeUndefined();
  });

  it("a longer duration displaces the task it now overlaps", async () => {
    const { service, ref, byId } = await setup([block("t", MON_1900, 30), block("b", at(MON_1900, 30), 30)]);
    const result = await service.setTiming(ref("t"), { start: MON_1900, durationMin: 60 });
    expect(result).toMatchObject({ kind: "changed", moved: [{ block: { id: "b" } }] });
    expect(await byId("b")).toMatchObject({ start: MON_2000, end: at(MON_2000, 30) });
  });

  it("counts every moved task on the dashboard", async () => {
    const { service, ref, repos } = await setup([block("t", MON_1630, 60), block("b", MON_1900, 60)]);
    await service.setTiming(ref("t"), { start: MON_1900 });
    const view = buildDashboard({
      now: ms(NOW),
      weekId: WEEK,
      blocks: await repos.blocks.get(WEEK),
      sleepScores: [],
      usageStatus: "unknown",
    });
    expect(view.widgets.find((w) => w.id === "moved")!.value).toBe("2");
  });
});

describe("setTiming: rejections", () => {
  it("rejects a calendar event with its summary", async () => {
    const { service, ref } = await setup(
      [block("t", MON_1630, 60)],
      [meeting("m1", at(MON_1900, 30), at(MON_1900, 90))],
    );
    expect(await service.setTiming(ref("t"), { start: MON_1900 })).toEqual({
      kind: "rejected",
      reason: "meeting",
      detail: "Meeting m1",
    });
  });

  it("ignores TimeBlocker's own calendar events", async () => {
    const own: CalendarEvent = { ...meeting("own", MON_1900, MON_2000), withOthers: false, isBlock: true };
    const { service, ref } = await setup([block("t", MON_1630, 60)], [own]);
    expect((await service.setTiming(ref("t"), { start: MON_1900 })).kind).toBe("changed");
  });

  it("rejects sleep, work hours and the Friday evening rule as protected", async () => {
    const { service, ref } = await setup([block("t", MON_1630, 60), block("w", MON_1900, 30, { category: "work" })]);
    // Mon 22:30 Toronto: sleep time.
    expect(await service.setTiming(ref("t"), { start: "2025-07-08T02:30:00.000Z" })).toMatchObject({
      kind: "rejected",
      reason: "protected",
    });
    // Tue 10:00 Toronto: work hours.
    expect(await service.setTiming(ref("t"), { start: "2025-07-08T14:00:00.000Z" })).toMatchObject({
      reason: "protected",
    });
    // Fri 17:00 Toronto is free time, but heavy work is not allowed there.
    expect(await service.setTiming(ref("w"), { start: "2025-07-11T21:00:00.000Z" })).toMatchObject({
      reason: "protected",
    });
  });

  it("uses the engine's holiday rule (a holiday is a day off, so work hours open up)", async () => {
    const TUE_10 = "2025-07-08T14:00:00.000Z";
    const { service, ref, repos } = await setup([block("t", MON_1630, 60)]);
    expect(await service.setTiming(ref("t"), { start: TUE_10 })).toMatchObject({ reason: "protected" });
    await repos.settings.save({ ...(await repos.settings.get()), holidays: ["2025-07-08"] });
    expect((await service.setTiming(ref("t"), { start: TUE_10 })).kind).toBe("changed");
  });

  it("rejects overlapping a done, in-progress, or started task", async () => {
    for (const other of [
      block("o", MON_1900, 60, { status: "done" }),
      block("o", MON_1900, 60, { status: "in-progress" }),
      block("o", MON_1900, 60, { status: "partial" }),
    ]) {
      const { service, ref, repos } = await setup([block("t", MON_1630, 60), other]);
      const before = await repos.blocks.get(WEEK);
      expect(await service.setTiming(ref("t"), { start: at(MON_1900, 30) })).toEqual({
        kind: "rejected",
        reason: "started-block",
      });
      expect(await repos.blocks.get(WEEK)).toEqual(before);
    }
  });

  it("rejects a target that has started or is not scheduled", async () => {
    const started = await setup([block("t", "2025-07-07T11:30:00.000Z", 60)]);
    expect(await started.service.setTiming(started.ref("t"), { start: MON_1900 })).toMatchObject({
      reason: "started-block",
    });
    const inProgress = await setup([block("t", MON_1630, 60, { status: "in-progress" })]);
    expect(await inProgress.service.setTiming(inProgress.ref("t"), { start: MON_1900 })).toMatchObject({
      reason: "started-block",
    });
  });

  it("rejects the past, other weeks, bad input and no-ops", async () => {
    const { service, ref } = await setup([block("t", MON_1630, 60)]);
    expect(await service.setTiming(ref("t"), { start: "2025-07-07T11:30:00.000Z" })).toMatchObject({
      reason: "past",
    });
    expect(await service.setTiming(ref("t"), { start: "2025-07-14T14:00:00.000Z" })).toMatchObject({
      reason: "wrong-week",
    });
    expect(await service.setTiming(ref("t"), { start: "nope" })).toMatchObject({ reason: "invalid-start" });
    expect(await service.setTiming(ref("t"), { start: MON_1900, durationMin: 600 })).toMatchObject({
      reason: "invalid-duration",
    });
    expect(await service.setTiming(ref("t"), { start: MON_1900, durationMin: 2 })).toMatchObject({
      reason: "invalid-duration",
    });
    expect(await service.setTiming(ref("t"), { start: MON_1630 })).toMatchObject({ reason: "unchanged" });
    expect(await service.setTiming({ weekId: WEEK, blockId: "nope" }, { start: MON_1900 })).toEqual({
      kind: "not-found",
    });
  });

  it("changes nothing when a displaced task cannot be placed", async () => {
    const SAT_10 = "2025-07-12T14:00:00.000Z";
    const SAT_12 = "2025-07-12T16:00:00.000Z";
    const { service, ref, repos, kv, track } = await setup([
      block("t", MON_1630, 60),
      block("big", SAT_10, 480, { title: "Big one" }),
    ]);
    const before = await repos.blocks.get(WEEK);
    const writes = kv.writes;
    const result = await service.setTiming(ref("t"), { start: SAT_12 });
    expect(result).toMatchObject({ kind: "nothing-fits", block: { id: "big" } });
    expect(describeSetTiming(result)).toBe("Big one would not fit this week, so nothing was changed.");
    expect(await repos.blocks.get(WEEK)).toEqual(before);
    expect(await repos.outbox.get()).toEqual([]);
    expect(await repos.undo.get()).toBeNull();
    expect(kv.writes).toBe(writes);
    expect(track.reconciles).toBe(0);
    expect(track.flushes).toBe(0);
  });
});

describe("setTiming: workout rule", () => {
  const SAT_10 = "2025-07-12T14:00:00.000Z";
  const SAT_15 = "2025-07-12T19:00:00.000Z";

  it("keeps one workout per day for the target", async () => {
    const { service, ref } = await setup([
      block("t", MON_1630, 60, { category: "fitness" }),
      block("f", SAT_10, 60, { category: "fitness" }),
    ]);
    expect(await service.setTiming(ref("t"), { start: SAT_15 })).toMatchObject({
      kind: "rejected",
      reason: "protected",
    });
  });

  it("keeps one workout per day for displaced tasks", async () => {
    const MON_0700 = "2025-07-07T11:10:00.000Z"; // earlier today (before now? no: 07:10 < 08:00)
    const { service, ref, byId } = await setup([
      block("t", MON_1630, 60),
      // A finished workout earlier on Monday.
      block("x", at(MON_0700, -60), 45, { category: "fitness", status: "done" }),
      block("d", MON_1900, 45, { category: "fitness" }),
    ]);
    const result = await service.setTiming(ref("t"), { start: MON_1900 });
    expect(result.kind).toBe("changed");
    // Monday already has a workout, so the displaced one lands on Tuesday 07:10.
    expect(await byId("d")).toMatchObject({ start: "2025-07-08T11:10:00.000Z" });
  });
});

describe("setTiming: undo", () => {
  async function moved() {
    const prior = { start: MON_1630, end: at(MON_1630, 30) };
    const ctx = await setup([
      block("t", MON_1630, 60),
      block("b", MON_1900, 60, { movedFrom: prior, moveReason: "Shortened to fit" }),
      block("c", at(MON_1900, 60), 30),
    ]);
    const before = await ctx.repos.blocks.get(WEEK);
    const result = await ctx.service.setTiming(ctx.ref("t"), { start: MON_1900, durationMin: 90 });
    expect(result.kind).toBe("changed");
    return { ...ctx, before, result };
  }

  it("stores one token with an entry per changed block, target first", async () => {
    const { repos } = await moved();
    const token = (await repos.undo.get())!;
    expect(token.blockId).toBe("t");
    expect(token.expiresAt).toBe(ms(NOW) + UNDO_WINDOW_MS);
    expect(token.entries!.map((e) => e.blockId)).toEqual(["t", "b", "c"]);
    expect(token.entries![1]).toMatchObject({
      previousMovedFrom: { start: MON_1630 },
      previousMoveReason: "Shortened to fit",
    });
  });

  it("restores every block, their prior movedFrom/moveReason, and queues upserts", async () => {
    const { repos, service, before, clock } = await moved();
    clock.set(ms(NOW) + 5_000);
    const result = await service.undo();
    expect(result).toMatchObject({ kind: "undone", block: { id: "t" } });
    const after = await repos.blocks.get(WEEK);
    const strip = (bs: DeviceBlock[]) => bs.map(({ updatedAt: _u, ...rest }) => rest);
    expect(strip(after)).toEqual(strip(before));
    expect(await repos.undo.get()).toBeNull();
    expect((await repos.outbox.get()).map((o) => [o.blockId, o.op]).sort()).toEqual([
      ["b", "upsert"],
      ["c", "upsert"],
      ["t", "upsert"],
    ]);
  });

  it("is rejected after the 10-second window and when any block moved again", async () => {
    const late = await moved();
    late.clock.set(ms(NOW) + UNDO_WINDOW_MS);
    expect(await late.service.undo()).toEqual({ kind: "rejected", reason: "expired" });

    const again = await moved();
    const list = await again.repos.blocks.get(WEEK);
    await again.repos.blocks.save(
      WEEK,
      list.map((b) => (b.id === "c" ? { ...b, start: at(b.start, 15), end: at(b.end, 15) } : b)),
    );
    expect(await again.service.undo()).toEqual({ kind: "rejected", reason: "moved-again" });
    expect(await again.repos.undo.get()).not.toBeNull();
  });

  it("an undo for a displaced block id is accepted, another id is not", async () => {
    const { service } = await moved();
    expect(await service.undo({ blockId: "zzz" })).toEqual({ kind: "rejected", reason: "other-block" });
    expect((await service.undo({ blockId: "b" })).kind).toBe("undone");
  });

  it("still undoes an old single-block token", async () => {
    const { repos, service, byId } = await setup([block("t", MON_1900, 60, { movedFrom: { start: MON_1630, end: MON_1900 } })]);
    const old: UndoToken = {
      blockId: "t",
      weekId: WEEK,
      calendarEventId: "tbeventt",
      previous: { start: MON_1630, end: at(MON_1630, 60) },
      previousStatus: "scheduled",
      movedTo: { start: MON_1900, end: MON_2000 },
      expiresAt: ms(NOW) + UNDO_WINDOW_MS,
    };
    expect(undoEntriesOf(old)).toHaveLength(1);
    await repos.undo.save(old);
    expect((await repos.undo.get())!.entries).toBeUndefined();
    expect(await service.undo()).toMatchObject({ kind: "undone", restored: old.previous });
    const t = await byId("t");
    expect(t).toMatchObject({ start: MON_1630 });
    expect(t.movedFrom).toBeUndefined();
  });

  it("drops a malformed entries list on read", async () => {
    const { repos } = await setup([block("t", MON_1900, 60)]);
    await repos.undo.save({ blockId: "t", entries: [] } as unknown as UndoToken);
    expect(await repos.undo.get()).toBeNull();
  });
});

describe("describeSetTiming", () => {
  const b = (title: string) => block(title, MON_1900, 30, { title });
  const changed = (...titles: string[]): SetTimingResult => ({
    kind: "changed",
    block: b("Gym"),
    moved: titles.map((t) => ({ block: b(t), from: { start: MON_1900, end: MON_2000 }, to: { start: MON_2000, end: MON_2000 } })),
    from: { start: MON_1900, end: MON_2000 },
    to: { start: MON_2000, end: MON_2000 },
    undo: { expiresAt: 0, blockIds: [] },
  });

  it("lists moved tasks without an Oxford comma", () => {
    expect(describeSetTiming(changed())).toBe("Moved Gym.");
    expect(describeSetTiming(changed("A"))).toBe("Moved Gym. Also moved A.");
    expect(describeSetTiming(changed("A", "B"))).toBe("Moved Gym. Also moved A and B.");
    expect(describeSetTiming(changed("A", "B", "C"))).toBe("Moved Gym. Also moved A, B and C.");
  });

  it("explains rejections", () => {
    expect(describeSetTiming({ kind: "rejected", reason: "meeting", detail: "Standup" })).toBe(
      "That time overlaps Standup.",
    );
    expect(describeSetTiming({ kind: "rejected", reason: "past" })).toBe("That time has already passed.");
  });
});
