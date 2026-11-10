import type { CalendarEvent } from "@timeblocker/calendar-integration";
import type { AppUsageRecord } from "@timeblocker/usage-metrics";
import { describe, expect, it } from "vitest";
import type { DeviceBlock, DeviceBlockStatus } from "../models.js";
import type { ForecastHistoryEntry } from "../notifications/forecast.js";
import { Repositories } from "../repositories.js";
import { FakeClock, FakeUsageSource, MemoryKeyValueStore } from "../testkit.js";
import { createForecastProvider } from "./forecasts.js";

const MIN = 60_000;
const NOW = Date.parse("2025-06-11T13:00:00Z");
const DISTRACTION = "com.instagram.android";
const HEAVY: AppUsageRecord[] = [{ packageName: DISTRACTION, foregroundTimeMs: 8 * MIN }];

function block(id: string, startMs: number, extra: Partial<DeviceBlock> = {}): DeviceBlock {
  return {
    id,
    itemId: `i-${id}`,
    title: id,
    start: new Date(startMs).toISOString(),
    end: new Date(startMs + 30 * MIN).toISOString(),
    category: "work",
    status: "scheduled",
    weekId: "2025-06-08",
    calendarEventId: `tb${id}`,
    calendarSynced: true,
    promptedMeetingIds: [],
    usagePrompted: false,
    updatedAt: 0,
    ...extra,
  };
}

const outcomes = (finished: number, missed: number, category = "work"): ForecastHistoryEntry[] => [
  ...Array.from({ length: finished }, () => ({ category, status: "done" as DeviceBlockStatus })),
  ...Array.from({ length: missed }, () => ({ category, status: "missed" as DeviceBlockStatus })),
];

async function setup(opts: {
  history?: ForecastHistoryEntry[];
  usage?: FakeUsageSource | "none";
  distractionApps?: string[];
  historyThrows?: boolean;
} = {}) {
  const repos = new Repositories(new MemoryKeyValueStore());
  await repos.settings.save({
    planningMode: "earliest-fit",
    holidays: [],
    distractionApps: opts.distractionApps ?? [DISTRACTION],
  });
  const usage = opts.usage === "none" ? undefined : (opts.usage ?? new FakeUsageSource(HEAVY));
  const asked: string[] = [];
  const provider = createForecastProvider({
    repos,
    clock: new FakeClock(NOW),
    usage,
    history: {
      categoryOutcomes: async (w) => {
        asked.push(w);
        if (opts.historyThrows) throw new Error("boom");
        return opts.history ?? [];
      },
    },
  });
  return { provider, usage, asked };
}

describe("createForecastProvider", () => {
  it("forecasts likely, unlikely and unknown from category history", async () => {
    const { provider, asked } = await setup({
      history: [...outcomes(4, 1, "work"), ...outcomes(1, 3, "fitness"), ...outcomes(1, 0, "misc")],
    });
    const blocks = [
      block("w", NOW + 3 * 60 * MIN),
      block("f", NOW + 4 * 60 * MIN, { category: "fitness" }),
      block("m", NOW + 5 * 60 * MIN, { category: "misc" }),
    ];
    const result = await provider({ blocks, events: [], now: NOW });
    expect(result.get("w")?.verdict).toBe("likely");
    expect(result.get("f")?.verdict).toBe("unlikely");
    expect(result.get("m")).toMatchObject({ verdict: "unknown", line: "" });
    expect(asked).toEqual(["2025-06-08"]);
  });

  it("skips past and non-scheduled blocks", async () => {
    const { provider } = await setup({ history: outcomes(4, 1) });
    const blocks = [
      block("past", NOW - 10 * MIN),
      block("done", NOW + 60 * MIN, { status: "done" }),
      block("ok", NOW + 60 * MIN),
    ];
    const result = await provider({ blocks, events: [], now: NOW });
    expect([...result.keys()]).toEqual(["ok"]);
  });

  it("flags an overlapping meeting", async () => {
    const { provider } = await setup({ history: outcomes(5, 0) });
    const meeting: CalendarEvent = {
      id: "m1",
      summary: "Planning",
      start: new Date(NOW + 3 * 60 * MIN + 10 * MIN).toISOString(),
      end: new Date(NOW + 5 * 60 * MIN).toISOString(),
      withOthers: true,
    };
    const result = await provider({ blocks: [block("b", NOW + 3 * 60 * MIN)], events: [meeting], now: NOW });
    expect(result.get("b")).toMatchObject({ verdict: "unlikely", reason: "Overlaps Planning" });
  });

  it("uses distraction only for blocks starting within 30 minutes, reading usage once", async () => {
    const { provider, usage } = await setup({ history: outcomes(5, 0) });
    const blocks = [block("soon", NOW + 20 * MIN), block("soon2", NOW + 25 * MIN), block("later", NOW + 40 * MIN)];
    const result = await provider({ blocks, events: [], now: NOW });
    expect(result.get("soon")?.verdict).toBe("unlikely");
    expect(result.get("soon2")?.verdict).toBe("unlikely");
    expect(result.get("later")?.verdict).toBe("likely");
    expect((usage as FakeUsageSource).reads).toEqual([{ startMs: NOW - 10 * MIN, endMs: NOW }]);
  });

  it("does not read usage when no block is near", async () => {
    const { provider, usage } = await setup({ history: outcomes(5, 0) });
    await provider({ blocks: [block("later", NOW + 60 * MIN)], events: [], now: NOW });
    expect((usage as FakeUsageSource).reads).toEqual([]);
  });

  it("uses the built-in distraction apps when the user list is empty", async () => {
    const { provider } = await setup({ history: outcomes(5, 0), distractionApps: [] });
    const result = await provider({ blocks: [block("soon", NOW + 20 * MIN)], events: [], now: NOW });
    expect(result.get("soon")?.verdict).toBe("unlikely");
  });
  it("ignores usage with denied permission or no usage source", async () => {
    const near = [block("soon", NOW + 20 * MIN)];
    for (const opts of [
      { usage: new FakeUsageSource(HEAVY, "denied") },
      { usage: "none" as const },
    ]) {
      const { provider, usage } = await setup({ history: outcomes(5, 0), ...opts });
      const result = await provider({ blocks: near, events: [], now: NOW });
      expect(result.get("soon")?.verdict).toBe("likely");
      if (usage instanceof FakeUsageSource) expect(usage.reads).toEqual([]);
    }
  });

  it("treats a usage error as no distraction", async () => {
    const usage = new FakeUsageSource(() => {
      throw new Error("usage broke");
    });
    const { provider } = await setup({ history: outcomes(5, 0), usage });
    const result = await provider({ blocks: [block("soon", NOW + 20 * MIN)], events: [], now: NOW });
    expect(result.get("soon")?.verdict).toBe("likely");
  });

  it("returns an empty map instead of throwing", async () => {
    const { provider } = await setup({ historyThrows: true });
    const result = await provider({ blocks: [block("b", NOW + 60 * MIN)], events: [], now: NOW });
    expect(result.size).toBe(0);
  });
});
