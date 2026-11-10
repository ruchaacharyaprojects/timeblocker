/**
 * Unit tests for `UsageRiskService` (R6.1, R7.1, R7.3, R12.9).
 */
import type { AppUsageRecord, UsageWindow } from "@timeblocker/usage-metrics";
import { describe, expect, it } from "vitest";
import type { DeviceBlock } from "../models.js";
import { Repositories } from "../repositories.js";
import { FakeClock, FakeNotifier, FakeUsageSource, MemoryKeyValueStore } from "../testkit.js";
import { USAGE_RISK_HORIZON_MS, UsageRiskService, usageRiskCandidates } from "./usageRisk.js";

const MIN = 60_000;
/** Wednesday 2025-06-11 09:00 America/Toronto (EDT). */
const NOW = Date.parse("2025-06-11T13:00:00Z");
const WEEK_ID = "2025-06-08";
const DISTRACTION = "com.instagram.android";
const iso = (ms: number) => new Date(ms).toISOString();

function block(id: string, startMs: number, extra: Partial<DeviceBlock> = {}): DeviceBlock {
  return {
    id,
    itemId: `item-${id}`,
    title: `Block ${id}`,
    start: iso(startMs),
    end: iso(startMs + 30 * MIN),
    category: "work",
    status: "scheduled",
    weekId: WEEK_ID,
    calendarEventId: `tb${id}`,
    calendarSynced: true,
    promptedMeetingIds: [],
    usagePrompted: false,
    updatedAt: 0,
    ...extra,
  };
}

/** Heavy distraction use: 8 minutes of Instagram in the lookback. */
const HEAVY: AppUsageRecord[] = [
  { packageName: DISTRACTION, foregroundTimeMs: 8 * MIN },
  { packageName: "com.google.android.calendar", foregroundTimeMs: 1 * MIN },
];

async function setup(options: {
  blocks?: DeviceBlock[];
  weekId?: string;
  records?: AppUsageRecord[];
  permission?: "granted" | "denied";
  now?: number;
  distractionApps?: string[];
} = {}) {
  const kv = new MemoryKeyValueStore();
  const repos = new Repositories(kv);
  const clock = new FakeClock(options.now ?? NOW);
  const notifier = new FakeNotifier();
  const usage = new FakeUsageSource(options.records ?? HEAVY, options.permission ?? "granted");
  await repos.settings.save({
    planningMode: "earliest-fit",
    holidays: [],
    distractionApps: options.distractionApps ?? [DISTRACTION],
  });
  await repos.blocks.save(options.weekId ?? WEEK_ID, options.blocks ?? []);
  const service = new UsageRiskService({ repos, usage, notifier, clock });
  return { kv, repos, clock, notifier, usage, service };
}

describe("UsageRiskService.checkUpcoming", () => {
  it("raises the miss prompt for an at-risk block starting within 30 minutes and persists it", async () => {
    const b = block("b1", NOW + 20 * MIN);
    const { repos, notifier, usage, service } = await setup({ blocks: [b] });

    const result = await service.checkUpcoming();

    expect(result).toEqual({ status: "evaluated", candidates: ["b1"], prompted: ["b1"], failed: [] });
    expect(usage.reads).toEqual<UsageWindow[]>([{ startMs: NOW - 10 * MIN, endMs: NOW }]);
    expect(notifier.shown).toHaveLength(1);
    expect(notifier.shown[0]).toMatchObject({
      id: "miss:b1",
      kind: "miss-prompt",
      channel: "prompts",
      title: "Will you miss this block?",
      body: "Block b1",
      sourceId: "b1",
      weekId: WEEK_ID,
      actions: [
        { id: "yes", label: "Yes" },
        { id: "no", label: "No" },
      ],
    });

    const [stored] = await repos.blocks.get(WEEK_ID);
    expect(stored).toMatchObject({ usagePrompted: true, updatedAt: NOW, status: "scheduled", start: b.start });
    expect(await repos.openPrompts.get()).toEqual([
      { promptId: "miss:b1", blockId: "b1", meetingIds: [], shownAt: NOW },
    ]);
    expect(await repos.notifRegistry.get()).toEqual([
      {
        id: "miss:b1",
        kind: "miss-prompt",
        sourceId: "b1",
        startMs: Date.parse(b.start),
        fireAtMs: NOW,
        exact: false,
        state: "shown",
      },
    ]);
  });

  it("prompts at most once per block across passes", async () => {
    const { notifier, service, repos } = await setup({ blocks: [block("b1", NOW + 20 * MIN)] });
    await service.checkUpcoming();
    // The user answers the prompt (removed from openPrompts); usage stays heavy.
    await repos.openPrompts.save([]);

    const second = await service.checkUpcoming();

    expect(second.status).toBe("no-candidates");
    expect(notifier.shown).toHaveLength(1);
  });

  it("raises nothing and reads no usage when the usage permission is denied", async () => {
    const { kv, notifier, usage, service, repos } = await setup({
      blocks: [block("b1", NOW + 20 * MIN)],
      permission: "denied",
    });
    const writesBefore = kv.writes;

    const result = await service.checkUpcoming();

    expect(result.status).toBe("permission-denied");
    expect(result.prompted).toEqual([]);
    expect(usage.reads).toEqual([]);
    expect(notifier.shown).toEqual([]);
    expect(kv.writes).toBe(writesBefore);
    expect((await repos.blocks.get(WEEK_ID))[0]!.usagePrompted).toBe(false);
  });

  it("does not prompt when recent usage is below the threshold or not on the distraction list", async () => {
    const { notifier, service, repos } = await setup({
      blocks: [block("b1", NOW + 20 * MIN)],
      records: [
        { packageName: DISTRACTION, foregroundTimeMs: 2 * MIN },
        { packageName: "com.google.android.gm", foregroundTimeMs: 9 * MIN },
      ],
    });

    const result = await service.checkUpcoming();

    expect(result).toMatchObject({ status: "evaluated", candidates: ["b1"], prompted: [] });
    expect(notifier.shown).toEqual([]);
    expect((await repos.blocks.get(WEEK_ID))[0]!.usagePrompted).toBe(false);
    expect(await repos.openPrompts.get()).toEqual([]);
  });

  it("counts the built-in distraction apps when the user list is empty (R30.3)", async () => {
    const { service, usage } = await setup({
      blocks: [block("b1", NOW + 20 * MIN)],
      distractionApps: [],
    });
    const result = await service.checkUpcoming();
    expect(result.status).toBe("evaluated");
    expect(result.prompted).toEqual(["b1"]);
    expect(usage.reads).toHaveLength(1);
  });
  it("still counts apps the user added, besides the built-ins", async () => {
    const { service } = await setup({
      blocks: [block("b1", NOW + 20 * MIN)],
      records: [{ packageName: "com.my.timewaster", foregroundTimeMs: 8 * MIN }],
      distractionApps: ["com.my.timewaster"],
    });
    expect((await service.checkUpcoming()).prompted).toEqual(["b1"]);
  });
  it("does not count unlisted apps", async () => {
    const { service } = await setup({
      blocks: [block("b1", NOW + 20 * MIN)],
      records: [{ packageName: "com.my.timewaster", foregroundTimeMs: 8 * MIN }],
      distractionApps: [],
    });
    expect((await service.checkUpcoming()).prompted).toEqual([]);
  });

  it("keeps going (no throw, no prompt) when reading usage fails", async () => {
    const { usage, notifier, service } = await setup({ blocks: [block("b1", NOW + 20 * MIN)] });
    usage.setRecords(() => {
      throw new Error("UsageStatsManager unavailable");
    });

    const result = await service.checkUpcoming();

    expect(result.status).toBe("usage-error");
    expect(notifier.shown).toEqual([]);
  });

  it("records a failed show but keeps usagePrompted so the prompt is at-most-once", async () => {
    const { notifier, service, repos } = await setup({ blocks: [block("b1", NOW + 20 * MIN)] });
    notifier.showNow = async () => {
      throw new Error("post failed");
    };

    const result = await service.checkUpcoming();

    expect(result.prompted).toEqual([]);
    expect(result.failed).toEqual([{ blockId: "b1", error: "post failed" }]);
    expect((await repos.blocks.get(WEEK_ID))[0]!.usagePrompted).toBe(true);
  });

  it("checks a block just past the week boundary (Saturday night → Sunday)", async () => {
    // Saturday 2025-06-14 23:50 Toronto (EDT) = 2025-06-15T03:50Z; next week is 2025-06-15.
    const now = Date.parse("2025-06-15T03:50:00Z");
    const next = block("b9", now + 20 * MIN, { weekId: "2025-06-15" });
    const { notifier, service, repos } = await setup({ now, blocks: [next], weekId: "2025-06-15" });

    const result = await service.checkUpcoming();

    expect(result.prompted).toEqual(["b9"]);
    expect(notifier.shown.map((n) => n.id)).toEqual(["miss:b9"]);
    expect((await repos.blocks.get("2025-06-15"))[0]!.usagePrompted).toBe(true);
  });

  it("never persists raw usage on the device store (R7.3, R12.9)", async () => {
    const { kv, service } = await setup({ blocks: [block("b1", NOW + 20 * MIN)] });
    await service.checkUpcoming();
    const stored = Object.values(kv.snapshot()).join("\n");
    expect(stored).not.toContain("com.google.android.calendar");
    expect(stored).not.toContain("foregroundTimeMs");
  });
});

describe("usageRiskCandidates", () => {
  it("keeps only scheduled, unprompted blocks with no open prompt starting in (now, now + 30 min]", () => {
    const blocks = [
      block("late", NOW + USAGE_RISK_HORIZON_MS),
      block("edge-out", NOW + USAGE_RISK_HORIZON_MS + 1),
      block("now", NOW),
      block("past", NOW - 5 * MIN),
      block("skipped", NOW + 10 * MIN, { status: "skipped" }),
      block("done", NOW + 10 * MIN, { usagePrompted: true }),
      block("open", NOW + 10 * MIN),
      block("soon", NOW + 1 * MIN),
    ];

    const ids = usageRiskCandidates(blocks, new Set(["open"]), NOW).map((b) => b.id);

    expect(ids).toEqual(["soon", "late"]);
  });
});
