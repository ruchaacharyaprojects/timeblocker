import { nightWindow } from "@timeblocker/usage-metrics";
import { describe, expect, it } from "vitest";
import type { DeviceBlock } from "../models.js";
import { weekIdAt } from "../notifications/service.js";
import { Repositories } from "../repositories.js";
import { shiftWeekId } from "../services/history.js";
import { SleepService } from "../services/sleep.js";
import { FakeClock, FakeSleepSource, FakeUsageSource, MemoryKeyValueStore } from "../testkit.js";
import { DEMO_DISTRACTION_APPS, demoSleepScores, demoSleepSessions, demoUsageRecords } from "./demoData.js";
import { DemoDataService, DemoSleepSource, DemoUsageSource } from "./demoService.js";

const NOW = "2025-06-18T16:00:00Z";

function setup() {
  const kv = new MemoryKeyValueStore();
  const repos = new Repositories(kv);
  const clock = new FakeClock(NOW);
  const demo = new DemoDataService({ repos, clock });
  return { kv, repos, clock, demo, currentWeek: weekIdAt(Date.parse(NOW)) };
}

const realBlock = (weekId: string, id = "real-1"): DeviceBlock => ({
  id,
  itemId: "item-1",
  start: `${weekId}T15:00:00.000Z`,
  end: `${weekId}T16:00:00.000Z`,
  category: "work",
  status: "done",
  weekId,
  title: "Real work",
  calendarEventId: "realevent1",
  calendarSynced: true,
  promptedMeetingIds: [],
  usagePrompted: false,
  updatedAt: 1,
});

describe("DemoDataService.load", () => {
  it("writes 8 past weeks of demo blocks, 14 nights, and distraction apps", async () => {
    const { demo, repos, currentWeek } = setup();
    const r = await demo.load();
    expect(r.weeks).toBe(8);
    expect(r.nights).toBe(14);
    expect(r.blocks).toBeGreaterThanOrEqual(8 * 12);
    expect(r.blocks).toBeLessThanOrEqual(8 * 16);

    let total = 0;
    for (let k = 1; k <= 8; k++) {
      const blocks = await repos.blocks.get(shiftWeekId(currentWeek, k));
      expect(blocks.length).toBeGreaterThan(0);
      expect(blocks.every((b) => b.id.startsWith("demo-") && b.calendarSynced)).toBe(true);
      total += blocks.length;
    }
    expect(total).toBe(r.blocks);
    const scores = Object.values(await repos.sleepScores.get());
    expect(scores).toHaveLength(14);
    expect(scores.every((s) => s.demo === true && s.source === "health+usage")).toBe(true);
    expect((await repos.settings.get()).distractionApps).toEqual([...DEMO_DISTRACTION_APPS]);
    expect(await repos.demoMode.get()).toEqual({
      loadedAt: Date.parse(NOW),
      blockWeeks: Array.from({ length: 8 }, (_, i) => shiftWeekId(currentWeek, 8 - i)),
      demoUsage: false,
      addedDistractionApps: true,
    });
  });

  it("never touches the current or a future week and never enqueues outbox entries", async () => {
    const { demo, repos, kv, currentWeek } = setup();
    const mine = realBlock(currentWeek);
    await repos.blocks.save(currentWeek, [mine]);
    await repos.blocks.save(shiftWeekId(currentWeek, -1), [realBlock(shiftWeekId(currentWeek, -1), "future")]);
    const before = kv.snapshot();
    await demo.load();
    const after = kv.snapshot();
    expect(after[`blocks:${currentWeek}`]).toBe(before[`blocks:${currentWeek}`]);
    expect(after[`blocks:${shiftWeekId(currentWeek, -1)}`]).toBe(before[`blocks:${shiftWeekId(currentWeek, -1)}`]);
    expect(after["outbox"]).toBeUndefined();
    expect(await repos.outbox.get()).toEqual([]);
    expect(Object.keys(after).filter((k) => k.startsWith("blocks:")).sort()).toEqual(
      [
        ...Array.from({ length: 8 }, (_, i) => `blocks:${shiftWeekId(currentWeek, i + 1)}`),
        `blocks:${currentWeek}`,
        `blocks:${shiftWeekId(currentWeek, -1)}`,
      ].sort(),
    );
  });

  it("is idempotent", async () => {
    const { demo, kv } = setup();
    await demo.load();
    const first = kv.snapshot();
    const r = await demo.load();
    expect(kv.snapshot()).toEqual(first);
    expect(r.weeks).toBe(8);
  });

  it("keeps real blocks (first, in order) and real scores; does not overwrite a real night", async () => {
    const { demo, repos, currentWeek } = setup();
    const week = shiftWeekId(currentWeek, 2);
    const real = [realBlock(week, "r1"), realBlock(week, "r2")];
    await repos.blocks.save(week, real);
    const nightKey = demoSleepScores(Date.parse(NOW))[13]!.dateKey;
    const realScore = { dateKey: nightKey, usageMin: 2, score: 55, scoredAt: 5, source: "usage" as const };
    await repos.sleepScores.save({ [nightKey]: realScore });

    const r = await demo.load();
    expect(r.nights).toBe(13);
    const blocks = await repos.blocks.get(week);
    expect(blocks.slice(0, 2)).toEqual(real);
    expect(blocks.slice(2).every((b) => b.id.startsWith("demo-"))).toBe(true);
    expect((await repos.sleepScores.get())[nightKey]).toEqual(realScore);
  });

  it("leaves a non-empty distraction list alone", async () => {
    const { demo, repos } = setup();
    await repos.settings.save({ planningMode: "spread", holidays: ["2025-07-01"], distractionApps: ["com.mine"] });
    await demo.load();
    expect(await repos.settings.get()).toEqual({
      planningMode: "spread",
      holidays: ["2025-07-01"],
      distractionApps: ["com.mine"],
    });
    expect((await repos.demoMode.get())?.addedDistractionApps).toBe(false);
  });

  it("moves with the clock: a later load drops demo blocks of weeks that left the set", async () => {
    const { demo, repos, clock, currentWeek } = setup();
    await demo.load();
    const oldest = shiftWeekId(currentWeek, 8);
    clock.set("2025-06-25T16:00:00Z");
    await demo.load();
    expect(await repos.blocks.get(oldest)).toEqual([]);
    expect((await repos.demoMode.get())?.blockWeeks).toHaveLength(8);
    expect((await repos.blocks.get(currentWeek)).length).toBeGreaterThan(0); // now a past week
  });
});

describe("DemoDataService.remove", () => {
  it("restores the state exactly and leaves real data alone", async () => {
    const { demo, repos, currentWeek } = setup();
    const week = shiftWeekId(currentWeek, 3);
    const real = [realBlock(week, "r1")];
    await repos.blocks.save(week, real);
    await repos.blocks.save(currentWeek, [realBlock(currentWeek, "cur")]);
    const realScore = { dateKey: "2025-05-01", usageMin: 0, score: 100, scoredAt: 1, source: "usage" as const };
    await repos.sleepScores.save({ "2025-05-01": realScore });
    const settingsBefore = await repos.settings.get();

    const loaded = await demo.load();
    await demo.setDemoUsage(true);
    const removed = await demo.remove();

    expect(removed).toEqual({ blocks: loaded.blocks, nights: 14 });
    expect(await repos.blocks.get(week)).toEqual(real);
    expect(await repos.blocks.get(currentWeek)).toHaveLength(1);
    for (let k = 1; k <= 8; k++) {
      if (k === 3) continue;
      expect(await repos.blocks.get(shiftWeekId(currentWeek, k))).toEqual([]);
    }
    expect(await repos.sleepScores.get()).toEqual({ "2025-05-01": realScore });
    expect(await repos.settings.get()).toEqual(settingsBefore);
    expect(await repos.demoMode.get()).toBeNull();
    expect(await demo.isDemoUsageEnabled()).toBe(false);
  });

  it("removes only the demo apps it added, keeping apps the user added since", async () => {
    const { demo, repos } = setup();
    await demo.load();
    const s = await repos.settings.get();
    await repos.settings.save({ ...s, distractionApps: [...s.distractionApps, "com.mine"] });
    await demo.remove();
    expect((await repos.settings.get()).distractionApps).toEqual(["com.mine"]);
  });

  it("is a no-op when nothing was loaded", async () => {
    const { demo, kv } = setup();
    expect(await demo.remove()).toEqual({ blocks: 0, nights: 0 });
    expect(kv.snapshot()).toEqual({});
  });
});

describe("demo usage switch", () => {
  it("persists, survives load, and is cleared by remove", async () => {
    const { demo, repos } = setup();
    expect(await demo.isDemoUsageEnabled()).toBe(false);
    await demo.setDemoUsage(true);
    expect(await demo.isDemoUsageEnabled()).toBe(true);
    expect(await new DemoDataService({ repos, clock: new FakeClock(NOW) }).isDemoUsageEnabled()).toBe(true);
    await demo.load();
    expect(await demo.isDemoUsageEnabled()).toBe(true);
    await demo.setDemoUsage(false);
    expect(await demo.isDemoUsageEnabled()).toBe(false);
    expect(await repos.demoMode.get()).not.toBeNull(); // data is still loaded
    await demo.setDemoUsage(true);
    await demo.remove();
    expect(await demo.isDemoUsageEnabled()).toBe(false);
  });

  it("turning the switch off with nothing loaded clears the document", async () => {
    const { demo, repos } = setup();
    await demo.setDemoUsage(true);
    await demo.setDemoUsage(false);
    expect(await repos.demoMode.get()).toBeNull();
    await demo.setDemoUsage(false);
    expect(await repos.demoMode.get()).toBeNull();
  });
});

describe("DemoUsageSource", () => {
  const w = { startMs: Date.parse("2025-06-18T13:00:00Z"), endMs: Date.parse("2025-06-18T15:00:00Z") };

  it("delegates to the real source while the switch is off", async () => {
    const { repos } = setup();
    const real = new FakeUsageSource([{ packageName: "com.real", foregroundTimeMs: 5 }], "denied");
    const src = new DemoUsageSource(real, repos);
    expect(await src.permission()).toBe("denied");
    expect(await src.readUsage(w)).toEqual([]);
    real.permissionState = "granted";
    expect(await src.readUsage(w)).toEqual([{ packageName: "com.real", foregroundTimeMs: 5 }]);
    expect(real.reads).toHaveLength(2);
  });

  it("answers granted with synthetic usage while on, then restores the real source", async () => {
    const { repos, demo } = setup();
    const real = new FakeUsageSource([{ packageName: "com.real", foregroundTimeMs: 5 }], "denied");
    const src = new DemoUsageSource(real, repos);
    await demo.setDemoUsage(true);
    expect(await src.permission()).toBe("granted");
    expect(await src.readUsage(w)).toEqual(demoUsageRecords(w));
    expect(real.reads).toHaveLength(0);
    await demo.setDemoUsage(false);
    expect(await src.permission()).toBe("denied");
    expect(await src.readUsage(w)).toEqual([]);
    expect(real.reads).toHaveLength(1);
  });
});

describe("DemoSleepSource", () => {
  const real = (permission: "granted" | "denied" = "denied") =>
    new FakeSleepSource([{ startMs: 1, endMs: 2, asleepMin: 3 }], permission, "needs-install");
  const win = { startMs: Date.parse("2025-06-17T22:00:00Z"), endMs: Date.parse("2025-06-18T16:00:00Z") };

  it("delegates while the switch is off", async () => {
    const { repos } = setup();
    const r = real();
    const src = new DemoSleepSource(r, repos);
    expect(await src.availability()).toBe("needs-install");
    expect(await src.permission()).toBe("denied");
    expect(await src.readSessions(win)).toEqual([{ startMs: 1, endMs: 2, asleepMin: 3 }]);
  });

  it("serves demo sessions when the switch is on and the real permission is not granted", async () => {
    const { repos, demo } = setup();
    const r = real();
    const src = new DemoSleepSource(r, repos);
    await demo.setDemoUsage(true);
    expect(await src.availability()).toBe("available");
    expect(await src.permission()).toBe("granted");
    const sessions = await src.readSessions(win);
    expect(sessions.length).toBeGreaterThan(0);
    expect(sessions).toEqual(
      demoSleepSessions(win.endMs, 5).filter((s) => s.endMs > win.startMs && s.startMs < win.endMs),
    );
    expect(r.reads).toHaveLength(0);
  });

  it("delegates when the real permission is granted, even with the switch on", async () => {
    const { repos, demo } = setup();
    const r = real("granted");
    const src = new DemoSleepSource(r, repos);
    await demo.setDemoUsage(true);
    expect(await src.permission()).toBe("granted");
    expect(await src.availability()).toBe("needs-install");
    expect(await src.readSessions(win)).toEqual([{ startMs: 1, endMs: 2, asleepMin: 3 }]);
  });

  it("drives the SleepService health path end to end without Health Connect", async () => {
    const { repos, demo, clock } = setup();
    const usage = new DemoUsageSource(new FakeUsageSource([], "denied"), repos);
    const sleepSource = new DemoSleepSource(real(), repos);
    const service = new SleepService({ repos, usage, clock, sleepSource });
    expect((await service.recordRecentNights()).skipped).toBe("permission-denied");
    await demo.setDemoUsage(true);
    const r = await service.recordRecentNights();
    expect(r.recorded).toHaveLength(3);
    const expected = new Map(demoSleepScores(Date.parse(NOW)).map((s) => [s.dateKey, s]));
    const stored = await repos.sleepScores.get();
    for (const key of r.recorded) {
      const e = expected.get(key)!;
      expect(stored[key]).toMatchObject({
        source: "health+usage",
        asleepMin: e.asleepMin,
        usageMin: e.usageMin,
        score: e.score,
      });
      expect(stored[key]!.demo).toBeUndefined(); // scored live, so it is real data
    }
    expect(nightWindow(r.recorded[0]!)).toBeDefined();
  });
});
