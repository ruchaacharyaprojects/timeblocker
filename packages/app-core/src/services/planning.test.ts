import type { CalendarEvent } from "@timeblocker/calendar-integration";
import type { IntakeItem } from "@timeblocker/flows";
import { describe, expect, it } from "vitest";
import type { DeviceBlock } from "../models.js";
import { NotificationService } from "../notifications/service.js";
import { isCalendarEventId } from "../ports.js";
import { Repositories } from "../repositories.js";
import {
  DeterministicIdGenerator,
  FakeClock,
  FakeNotifier,
  MemoryKeyValueStore,
} from "../testkit.js";
import { IntakeService } from "./intake.js";
import {
  itemsToPlan,
  PlanningService,
  weekOfId,
  type PlanningFlusher,
  type PlanningNotifications,
  type PlanningServiceDeps,
  type PlanningSync,
} from "./planning.js";

const WEEK = "2025-07-06";
/** Sunday 2025-07-06 00:00 in Toronto (EDT). */
const NOW = "2025-07-06T04:00:00.000Z";

const item = (id: string, overrides: Partial<IntakeItem> = {}): IntakeItem => ({
  id,
  text: `Task ${id}`,
  durationMin: 60,
  priority: 2,
  category: "work",
  confirmed: true,
  weekId: WEEK,
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

const overlaps = (a: { start: string; end: string }, b: { start: string; end: string }) =>
  Date.parse(a.start) < Date.parse(b.end) && Date.parse(b.start) < Date.parse(a.end);

function setup(overrides: Partial<PlanningServiceDeps> = {}) {
  const kv = new MemoryKeyValueStore();
  const repos = new Repositories(kv);
  const clock = new FakeClock(NOW);
  const notifier = new FakeNotifier();
  const notifications = new NotificationService(repos, notifier, clock);
  const service = new PlanningService({
    repos,
    clock,
    ids: new DeterministicIdGenerator("blk"),
    notifications,
    ...overrides,
  });
  return { kv, repos, clock, notifier, service };
}

describe("PlanningService.plan", () => {
  it("persists scheduled blocks with pre-assigned event ids and outbox upserts in one write", async () => {
    const { kv, repos, notifier, service } = setup();
    await repos.items.save(WEEK, [item("a", { priority: 1 }), item("b")]);

    const writesBefore = kv.writes;
    const result = await service.plan(WEEK);

    expect(result.unplaced).toEqual([]);
    expect(result.alert).toBeUndefined();
    expect(result.sync).toBe("skipped");
    expect(result.placed.map((p) => p.item.id).sort()).toEqual(["a", "b"]);

    const stored = await repos.blocks.get(WEEK);
    expect(stored).toEqual(result.blocks);
    expect(stored).toHaveLength(2);
    for (const b of stored) {
      expect(b).toMatchObject({
        status: "scheduled",
        weekId: WEEK,
        calendarSynced: false,
        promptedMeetingIds: [],
        usagePrompted: false,
        updatedAt: Date.parse(NOW),
      });
      expect(isCalendarEventId(b.calendarEventId)).toBe(true);
      const week = weekOfId(WEEK);
      expect(Date.parse(b.start)).toBeGreaterThanOrEqual(Date.parse(week.sunday));
      expect(Date.parse(b.end)).toBeLessThanOrEqual(Date.parse(week.saturday));
    }
    expect(new Set(stored.map((b) => b.calendarEventId)).size).toBe(2);

    const outbox = await repos.outbox.get();
    expect(outbox).toEqual(
      stored.map((b) => ({
        blockId: b.id,
        calendarEventId: b.calendarEventId,
        op: "upsert",
        attempts: 0,
        enqueuedAt: Date.parse(NOW),
      })),
    );

    // Blocks + outbox in one setMany, then the reconcile's registry write.
    expect(kv.writes - writesBefore).toBe(2);
    // Each new block got its reminder (R13.1).
    for (const b of stored) {
      expect([...notifier.pending.keys()]).toContain(`rem:block:${b.id}@${Date.parse(b.start)}`);
    }
  });

  it("saves neither blocks nor outbox when the write fails", async () => {
    const { kv, repos, service } = setup();
    await repos.items.save(WEEK, [item("a")]);
    kv.failNextWrite();
    await expect(service.plan(WEEK)).rejects.toThrow("Simulated storage failure");
    expect(await repos.blocks.get(WEEK)).toEqual([]);
    expect(await repos.outbox.get()).toEqual([]);
  });

  it("returns unplaced items and the nothing-fits alert without forcing a block", async () => {
    let reconciles = 0;
    const notifications: PlanningNotifications = {
      reconcile: async () => {
        reconciles += 1;
      },
    };
    const { kv, repos, service } = setup({ notifications });
    const week = weekOfId(WEEK);
    await repos.items.save(WEEK, [item("a"), item("b", { category: "fitness" })]);
    await repos.calendarCache.save(WEEK, {
      syncedAt: 0,
      events: [meeting("all-week", week.sunday, week.saturday)],
    });

    const writesBefore = kv.writes;
    const result = await service.plan(WEEK);

    expect(result.placed).toEqual([]);
    expect(result.blocks).toEqual([]);
    expect(result.unplaced.map((i) => i.id).sort()).toEqual(["a", "b"]);
    expect(result.alert?.options).toEqual(["shrink", "drop", "roll-to-next-week"]);
    expect(result.alert?.items).toEqual(result.unplaced);
    expect(kv.writes).toBe(writesBefore);
    expect(await repos.outbox.get()).toEqual([]);
    expect(reconciles).toBe(0);
  });

  it("avoids cached meetings and local blocks, skips planned and unconfirmed items", async () => {
    const { repos, service } = setup();
    const existing: DeviceBlock = {
      id: "old",
      itemId: "done-item",
      title: "Old",
      start: "2025-07-07T13:00:00.000Z",
      end: "2025-07-07T15:00:00.000Z",
      category: "work",
      status: "scheduled",
      weekId: WEEK,
      calendarEventId: "tb0000old0",
      calendarSynced: true,
      promptedMeetingIds: [],
      usagePrompted: false,
      updatedAt: 0,
    };
    await repos.blocks.save(WEEK, [existing]);
    const meet = meeting("m1", "2025-07-07T15:00:00.000Z", "2025-07-07T17:00:00.000Z");
    // A 🧱 event in the cache is ignored (the local block stands in for it).
    const brick: CalendarEvent = { ...meet, id: existing.calendarEventId, isBlock: true };
    await repos.calendarCache.save(WEEK, { syncedAt: 0, events: [meet, brick] });
    await repos.items.save(WEEK, [
      item("done-item"),
      item("draft", { confirmed: false }),
      item("new", { priority: 1 }),
    ]);

    const result = await service.plan(WEEK);
    expect(result.placed.map((p) => p.item.id)).toEqual(["new"]);
    const [created] = result.blocks;
    expect(overlaps(created!, existing)).toBe(false);
    expect(overlaps(created!, meet)).toBe(false);
    expect((await repos.blocks.get(WEEK)).map((b) => b.id)).toEqual(["old", created!.id]);

    // A second pass places nothing new.
    const again = await service.plan(WEEK);
    expect(again.placed).toEqual([]);
    expect(again.unplaced).toEqual([]);
    expect(await repos.blocks.get(WEEK)).toHaveLength(2);
  });

  it("serializes overlapping calls so an item is placed once", async () => {
    const { repos, service } = setup();
    await repos.items.save(WEEK, [item("a")]);
    const [first, second] = await Promise.all([service.plan(WEEK), service.plan(WEEK)]);
    expect(first.blocks.length + second.blocks.length).toBe(1);
    expect(await repos.blocks.get(WEEK)).toHaveLength(1);
    expect(await repos.outbox.get()).toHaveLength(1);
  });
});

describe("PlanningService sync first and flush", () => {
  it("syncs before reading the cache", async () => {
    const order: string[] = [];
    const repoHolder: { repos?: Repositories } = {};
    const sync: PlanningSync = {
      syncForeground: async () => {
        order.push("sync");
        await repoHolder.repos!.calendarCache.save(WEEK, {
          syncedAt: 1,
          events: [meeting("fresh", weekOfId(WEEK).sunday, weekOfId(WEEK).saturday)],
        });
      },
    };
    const { repos, service } = setup({ sync });
    repoHolder.repos = repos;
    await repos.items.save(WEEK, [item("a")]);
    const result = await service.plan(WEEK);
    expect(order).toEqual(["sync"]);
    expect(result.sync).toBe("ok");
    // The meeting written by the sync blocked the whole week.
    expect(result.unplaced.map((i) => i.id)).toEqual(["a"]);
  });

  it("plans from the cache when the sync fails or exceeds its budget", async () => {
    const failing = setup({ sync: { syncForeground: () => Promise.reject(new Error("offline")) } });
    await failing.repos.items.save(WEEK, [item("a")]);
    const failed = await failing.service.plan(WEEK);
    expect(failed.sync).toBe("failed");
    expect(failed.blocks).toHaveLength(1);

    const hanging = setup({
      sync: { syncForeground: () => new Promise<void>(() => {}) },
      syncBudgetMs: 20,
    });
    await hanging.repos.items.save(WEEK, [item("a")]);
    const timedOut = await hanging.service.plan(WEEK);
    expect(timedOut.sync).toBe("timed-out");
    expect(timedOut.blocks).toHaveLength(1);
  });

  it("kicks a flush after saving new blocks without waiting for it", async () => {
    let flushes = 0;
    const flusher: PlanningFlusher = {
      flush: () => {
        flushes += 1;
        return Promise.reject(new Error("still offline"));
      },
    };
    const { repos, service } = setup({ flusher });
    await repos.items.save(WEEK, [item("a")]);
    await service.plan(WEEK);
    expect(flushes).toBe(1);
    // Nothing new to write: no flush.
    await service.plan(WEEK);
    expect(flushes).toBe(1);
    expect(await repos.outbox.get()).toHaveLength(1);
  });

  it("keeps the saved blocks and reports a reconcile failure", async () => {
    const { repos, service } = setup({
      notifications: { reconcile: () => Promise.reject(new Error("notifier down")) },
    });
    await repos.items.save(WEEK, [item("a")]);
    const result = await service.plan(WEEK);
    expect(result.notificationError).toBe("notifier down");
    expect(await repos.blocks.get(WEEK)).toHaveLength(1);
  });

  it("plugs into IntakeService as its planner", async () => {
    const { repos, clock, service } = setup();
    const intake = new IntakeService({
      repos,
      clock,
      ids: new DeterministicIdGenerator("item"),
      planner: service,
    });
    await intake.validate("Finish report | 60 | 1 | work");
    const confirmed = await intake.confirm(WEEK);
    expect(confirmed.ok && confirmed.plan.placed.map((p) => p.item.text)).toEqual([
      "Finish report",
    ]);
    expect(await repos.blocks.get(WEEK)).toHaveLength(1);
  });
});

describe("itemsToPlan series", () => {
  it("passes seriesId as group and omits it otherwise", () => {
    const out = itemsToPlan(
      [item("a", { seriesId: "s1", seriesIndex: 1, seriesSize: 2, text: "Gym (1 of 2)" }), item("b")],
      [],
    );
    expect(out[0]).toMatchObject({ id: "a", text: "Gym (1 of 2)", group: "s1" });
    expect("group" in out[1]!).toBe(false);
  });
});

describe("PlanningService.rollToNextWeek / dropUnplaced", () => {
  const NEXT = "2025-07-13";
  /** Too long for any single day, so it never fits. */
  const huge = (id: string, extra: Partial<IntakeItem> = {}) => item(id, { durationMin: 1500, ...extra });

  it("moves only the selected unplaced items and plans next week, even when now is Friday", async () => {
    const { repos, clock, service } = setup();
    clock.set("2025-07-11T20:00:00.000Z"); // Friday afternoon
    await repos.items.save(WEEK, [item("a"), huge("big"), huge("other")]);
    await service.plan(WEEK);
    const blocksBefore = await repos.blocks.get(WEEK);
    const outboxBefore = await repos.outbox.get();
    const result = await service.rollToNextWeek(WEEK, ["big"]);
    expect(result.weekId).toBe(NEXT);
    expect((await repos.items.get(WEEK)).map((i) => i.id).sort()).toEqual(["a", "other"]);
    const next = await repos.items.get(NEXT);
    expect(next.map((i) => i.id)).toEqual(["big"]);
    expect(next[0]).toMatchObject({ weekId: NEXT, confirmed: true, durationMin: 1500 });
    expect(await repos.blocks.get(WEEK)).toEqual(blocksBefore);
    expect(await repos.outbox.get()).toEqual(outboxBefore);
    // Still too long for next week: returned unplaced.
    expect(result.unplaced.map((i) => i.id)).toEqual(["big"]);
  });

  it("places moved items in next week with the whole week available", async () => {
    const { repos, clock, service } = setup();
    clock.set("2025-07-11T20:00:00.000Z");
    await repos.items.save(WEEK, [item("x"), item("y")]);
    // Both have no block yet: roll them without planning this week first.
    const result = await service.rollToNextWeek(WEEK, ["x", "y"]);
    expect(result.blocks).toHaveLength(2);
    for (const b of await repos.blocks.get(NEXT)) {
      expect(b.weekId).toBe(NEXT);
      expect(Date.parse(b.start)).toBeGreaterThanOrEqual(Date.parse(`${NEXT}T00:00:00-04:00`));
    }
    expect(await repos.blocks.get(WEEK)).toEqual([]);
    expect(await repos.items.get(WEEK)).toEqual([]);
  });

  it("ignores ids with blocks or unknown ids and is idempotent", async () => {
    const { repos, service } = setup();
    await repos.items.save(WEEK, [item("a"), huge("big")]);
    await service.plan(WEEK);
    const first = await service.rollToNextWeek(WEEK, ["a", "nope", "big"]);
    expect((await repos.items.get(NEXT)).map((i) => i.id)).toEqual(["big"]);
    expect(first.blocks).toEqual([]);
    const second = await service.rollToNextWeek(WEEK, ["a", "nope", "big"]);
    expect((await repos.items.get(NEXT)).map((i) => i.id)).toEqual(["big"]);
    expect((await repos.items.get(WEEK)).map((i) => i.id)).toEqual(["a"]);
    expect(second.weekId).toBe(NEXT);
  });

  it("keeps series ids so a series still spreads over days", async () => {
    const { repos, service } = setup();
    const series = [1, 2, 3].map((n) =>
      item(`s${n}`, { seriesId: "ser", seriesIndex: n, seriesSize: 3, durationMin: 60 }),
    );
    await repos.items.save(WEEK, series);
    const result = await service.rollToNextWeek(WEEK, ["s1", "s2", "s3"]);
    expect(result.blocks).toHaveLength(3);
    expect((await repos.items.get(NEXT)).every((i) => i.seriesId === "ser")).toBe(true);
    const days = new Set(result.blocks.map((b) => b.start.slice(0, 10)));
    expect(days.size).toBe(3);
  });

  it("dropUnplaced removes only items without blocks", async () => {
    const { repos, service } = setup();
    await repos.items.save(WEEK, [item("a"), huge("big"), huge("keep")]);
    await service.plan(WEEK);
    const res = await service.dropUnplaced(WEEK, ["a", "big", "ghost"]);
    expect(res).toEqual({ removed: 1 });
    expect((await repos.items.get(WEEK)).map((i) => i.id).sort()).toEqual(["a", "keep"]);
    expect(await service.dropUnplaced(WEEK, ["big"])).toEqual({ removed: 0 });
  });
});

describe("PlanningService with country holidays (R30.2)", () => {
  // A holiday is a day off: the Mon-Fri 08:30-16:30 work block disappears, so
  // that time becomes plannable (R3.2).
  const HOLIDAY = "2025-07-07"; // Monday
  const toronto = (iso: string) =>
    new Date(iso).toLocaleString("en-CA", { timeZone: "America/Toronto", hour12: false });
  const inWorkHours = (b: { start: string }, date: string) => {
    const [d, t] = toronto(b.start).split(", ");
    const hour = Number(t!.slice(0, 2));
    return d === date && hour >= 9 && hour < 16;
  };
  const many = () => Array.from({ length: 24 }, (_, i) => item(`i${i}`));
  async function planWith(deps: Partial<PlanningServiceDeps>, holidays: string[] = []) {
    const { repos, service } = setup(deps);
    await repos.settings.save({ planningMode: "earliest-fit", holidays, distractionApps: [] });
    await repos.items.save(WEEK, many());
    return service.plan(WEEK);
  }

  it("control: without holidays the Monday work hours stay empty", async () => {
    const result = await planWith({});
    expect(result.blocks.some((b) => inWorkHours(b, HOLIDAY))).toBe(false);
  });

  it("treats a country holiday as a day off (work hours open up)", async () => {
    const result = await planWith({ holidays: { dates: async () => [HOLIDAY] } });
    expect(result.blocks.some((b) => inWorkHours(b, HOLIDAY))).toBe(true);
  });

  it("still honours settings.holidays", async () => {
    const result = await planWith({}, [HOLIDAY]);
    expect(result.blocks.some((b) => inWorkHours(b, HOLIDAY))).toBe(true);
  });

  it("combines settings holidays with country holidays", async () => {
    const result = await planWith({ holidays: { dates: async () => [HOLIDAY] } }, ["2025-07-08"]);
    expect(result.blocks.some((b) => inWorkHours(b, HOLIDAY))).toBe(true);
  });

  it("falls back to settings holidays when the holiday source fails", async () => {
    const failing = {
      dates: async (): Promise<string[]> => {
        throw new Error("boom");
      },
    };
    expect((await planWith({ holidays: failing })).blocks.some((b) => inWorkHours(b, HOLIDAY))).toBe(false);
    expect((await planWith({ holidays: failing }, [HOLIDAY])).blocks.some((b) => inWorkHours(b, HOLIDAY))).toBe(true);
  });
});

describe("PlanningService schedule fields (R28)", () => {
  // Wednesday 2025-07-09. Free windows are outside work hours, so use 5-6 PM.
  const WED_2PM = "2025-07-09T21:00:00.000Z"; // 5 PM Toronto (a free window)
  const WED_3PM = "2025-07-09T22:00:00.000Z";

  it("leaves plain items unchanged by schedule mapping", () => {
    expect(itemsToPlan([item("a")], [])).toEqual([
      { id: "a", text: "Task a", durationMin: 60, priority: 2, category: "work" },
    ]);
  });

  it("maps schedule fields onto engine items", () => {
    const [mapped] = itemsToPlan(
      [item("a", { fixedStart: WED_2PM }), item("b", { onDay: "2025-07-09" }), item("c", { dueAt: WED_3PM })],
      [],
    );
    expect(mapped!.fixedStartMs).toBe(Date.parse(WED_2PM));
    const rest = itemsToPlan([item("b", { onDay: "2025-07-09" }), item("c", { dueAt: WED_3PM, priority: 1 })], []);
    expect(rest[0]!.earliestMs).toBeDefined();
    expect(rest[0]!.latestEndMs).toBeDefined();
    expect(rest[1]!.earliestMs).toBeUndefined();
    expect(rest[1]!.latestEndMs).toBe(Date.parse(WED_3PM));
    expect(rest[1]!.priority).toBe(1);
  });

  it("places a fixed start exactly", async () => {
    const { repos, service } = setup();
    await repos.items.save(WEEK, [item("fx", { fixedStart: WED_2PM })]);
    const r = await service.plan(WEEK);
    expect(r.unplaced).toEqual([]);
    expect(r.blocks[0]).toMatchObject({ start: WED_2PM, end: WED_3PM });
  });

  it("reports a clash with a meeting as unplaced and creates no block", async () => {
    const { repos, service } = setup();
    await repos.calendarCache.save(WEEK, {
      weekId: WEEK,
      syncedAt: 0,
      events: [meeting("m1", "2025-07-09T20:30:00.000Z", "2025-07-09T21:30:00.000Z")],
    } as never);
    await repos.items.save(WEEK, [item("fx", { fixedStart: WED_2PM })]);
    const r = await service.plan(WEEK);
    expect(r.blocks).toEqual([]);
    expect(r.unplaced.map((u) => [u.id, u.reason])).toEqual([["fx", "clash"]]);
    expect(await repos.blocks.get(WEEK)).toEqual([]);
  });

  it("reports a fixed start in the past as 'past'", async () => {
    const { repos, service, clock } = setup();
    clock.set("2025-07-10T12:00:00Z");
    await repos.items.save(WEEK, [item("fx", { fixedStart: WED_2PM })]);
    const r = await service.plan(WEEK);
    expect(r.unplaced.map((u) => u.reason)).toEqual(["past"]);
    expect(r.blocks).toEqual([]);
  });

  it("schedules a deadline item before its deadline at top priority and copies dueAt", async () => {
    const { repos, service } = setup();
    const dueAt = "2025-07-08T21:00:00.000Z"; // Tue 5 PM Toronto
    await repos.items.save(WEEK, [
      item("other", { priority: 2 }),
      item("dl", { dueAt, priority: 1, durationMin: 120 }),
    ]);
    const r = await service.plan(WEEK);
    const dl = r.blocks.find((b) => b.itemId === "dl")!;
    expect(Date.parse(dl.end)).toBeLessThanOrEqual(Date.parse(dueAt));
    expect(dl.dueAt).toBe(dueAt);
    expect((await repos.blocks.get(WEEK)).find((b) => b.itemId === "dl")!.dueAt).toBe(dueAt);
    expect(r.blocks.find((b) => b.itemId === "other")!.dueAt).toBeUndefined();
  });

  it("reports no-time-before-deadline when nothing fits before it", async () => {
    const { repos, service } = setup();
    // Deadline Sunday 6 AM Toronto is before any working window of the week.
    const dueAt = "2025-07-06T10:00:00.000Z";
    await repos.items.save(WEEK, [item("dl", { dueAt, priority: 1 })]);
    const r = await service.plan(WEEK);
    expect(r.blocks).toEqual([]);
    expect(r.unplaced.map((u) => u.reason)).toEqual(["no-time-before-deadline"]);
  });

  it("keeps an onDay item on that day", async () => {
    const { repos, service } = setup();
    await repos.items.save(WEEK, [item("d", { onDay: "2025-07-10" })]);
    const r = await service.plan(WEEK);
    expect(r.blocks).toHaveLength(1);
    const start = new Date(r.blocks[0]!.start);
    expect(start.toISOString().slice(0, 10) === "2025-07-10" || start.toISOString().slice(0, 10) === "2025-07-11").toBe(true);
    expect(Date.parse(r.blocks[0]!.start)).toBeGreaterThanOrEqual(Date.parse("2025-07-10T04:00:00Z"));
    expect(Date.parse(r.blocks[0]!.end)).toBeLessThanOrEqual(Date.parse("2025-07-11T04:00:00Z"));
  });
});
