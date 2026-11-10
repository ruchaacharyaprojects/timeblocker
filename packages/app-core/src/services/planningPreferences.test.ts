import type { IntakeItem } from "@timeblocker/flows";
import { torontoInstant, torontoMinutesOfDay, torontoDateKey } from "@timeblocker/scheduling-engine";
import { describe, expect, it } from "vitest";
import type { DeviceBlock } from "../models.js";
import { NotificationService } from "../notifications/service.js";
import { Repositories } from "../repositories.js";
import { DeterministicIdGenerator, FakeClock, FakeNotifier, MemoryKeyValueStore } from "../testkit.js";
import { HistoryReader } from "./history.js";
import { PlanningService, type PlanningServiceDeps } from "./planning.js";

const WEEK = "2025-07-06";
const NOW = "2025-07-06T04:00:00.000Z";

const item = (id: string, o: Partial<IntakeItem> = {}): IntakeItem => ({
  id, text: `Task ${id}`, durationMin: 60, priority: 2, category: "work",
  confirmed: true, weekId: WEEK, ...o,
});

const past = (n: number, hour: number, status: DeviceBlock["status"]): DeviceBlock => {
  // One block per day in June 2025, start at `hour` Toronto time.
  const start = torontoInstant(2025, 6, 1 + n, hour, 0);
  return {
    id: `p${hour}-${n}`, itemId: `pi${hour}-${n}`, title: "Old", category: "work", status,
    start: start.toISOString(), end: new Date(start.getTime() + 3_600_000).toISOString(),
    weekId: "2025-06-01", calendarEventId: "tb0000old0", calendarSynced: true,
    promptedMeetingIds: [], usagePrompted: false, updatedAt: 0,
  };
};

async function setup(
  history: DeviceBlock[],
  mutate?: (deps: PlanningServiceDeps, repos: Repositories) => void,
) {
  const repos = new Repositories(new MemoryKeyValueStore());
  const clock = new FakeClock(NOW);
  // Group by stored weekId; all test history sits in one fake past week.
  await repos.blocks.save("2025-06-01", history);
  const deps: PlanningServiceDeps = {
    repos, clock, ids: new DeterministicIdGenerator("blk"),
    notifications: new NotificationService(repos, new FakeNotifier(), clock),
    history: new HistoryReader({ repos, clock }),
  };
  mutate?.(deps, repos);
  return { repos, service: new PlanningService(deps) };
}

const startMinutes = (b: { start: string }) => torontoMinutesOfDay(new Date(b.start));

describe("PlanningService with learned placement (R23)", () => {
  const eveningsDone = [0, 1, 2, 3, 4, 5].flatMap((n) => [past(n, 19, "done"), past(n, 9, "missed")]);
  const morningsDone = [0, 1, 2, 3, 4, 5].flatMap((n) => [past(n, 9, "done"), past(n, 19, "missed")]);

  it("moves a work item into the evening when evenings were completed", async () => {
    const { repos, service } = await setup(eveningsDone);
    await repos.items.save(WEEK, [item("a")]);
    const r = await service.plan(WEEK);
    const m = startMinutes(r.blocks[0]!);
    expect(m).toBeGreaterThanOrEqual(18 * 60);
    expect(m).toBeLessThan(20 * 60);
  });

  it("keeps a work item in the morning when mornings were completed", async () => {
    const { repos, service } = await setup(morningsDone);
    await repos.items.save(WEEK, [item("a")]);
    const r = await service.plan(WEEK);
    expect(startMinutes(r.blocks[0]!)).toBeLessThan(12 * 60);
  });

  it("behaves as before with fewer than 5 counted blocks", async () => {
    const few = eveningsDone.filter((b) => b.id.endsWith("-0") || b.id.endsWith("-1")).slice(0, 4);
    const withFew = await setup(few);
    const without = await setup([], (d) => delete d.history);
    await withFew.repos.items.save(WEEK, [item("a")]);
    await without.repos.items.save(WEEK, [item("a")]);
    const a = await withFew.service.plan(WEEK);
    const b = await without.service.plan(WEEK);
    expect(a.placed.map((p) => p.slot)).toEqual(b.placed.map((p) => p.slot));
  });

  it("plans without preferences when the history read fails", async () => {
    const { repos, service } = await setup(eveningsDone, (d) => {
      d.history = { placementHistory: async () => { throw new Error("boom"); } };
    });
    const baseline = await setup([], (d) => delete d.history);
    await repos.items.save(WEEK, [item("a")]);
    await baseline.repos.items.save(WEEK, [item("a")]);
    const r = await service.plan(WEEK);
    const base = await baseline.service.plan(WEEK);
    expect(r.placed.map((p) => p.slot)).toEqual(base.placed.map((p) => p.slot));
  });

  it("still spreads a series over different days", async () => {
    const { repos, service } = await setup(eveningsDone);
    await repos.items.save(WEEK, [1, 2, 3].map((i) => item(`s${i}`, { seriesId: "ser" })));
    const r = await service.plan(WEEK);
    const days = new Set(r.blocks.map((b) => torontoDateKey(new Date(b.start))));
    expect(r.blocks).toHaveLength(3);
    expect(days.size).toBe(3);
  });
});

describe("HistoryReader.placementHistory", () => {
  it("returns category/start/status from the 26 weeks and the target week", async () => {
    const repos = new Repositories(new MemoryKeyValueStore());
    const clock = new FakeClock(NOW);
    const old = past(0, 9, "done");
    await repos.blocks.save("2025-06-01", [old]);
    await repos.blocks.save(WEEK, [{ ...past(1, 9, "scheduled"), weekId: WEEK }]);
    await repos.blocks.save("2024-01-07", [{ ...past(2, 9, "done"), weekId: "2024-01-07" }]); // > 26 weeks back
    const out = await new HistoryReader({ repos, clock }).placementHistory(WEEK);
    expect(out).toHaveLength(2);
    expect(out).toContainEqual({ category: "work", start: old.start, status: "done" });
  });
});
