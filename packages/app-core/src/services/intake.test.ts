import type { IntakeItem } from "@timeblocker/flows";
import { describe, expect, it } from "vitest";
import { Repositories } from "../repositories.js";
import { DeterministicIdGenerator, FakeClock, MemoryKeyValueStore } from "../testkit.js";
import { IntakeService, type IntakePlanner } from "./intake.js";
import { PlanningService } from "./planning.js";
import { NotificationService } from "../notifications/service.js";
import { FakeNotifier } from "../testkit.js";

const WEEK = "2025-07-06";

/** Records each plan call and what was persisted at that moment. */
class FakePlanner implements IntakePlanner<{ planned: string }> {
  readonly calls: { weekId: string; itemsAtCall: IntakeItem[] }[] = [];
  constructor(private readonly repos: Repositories) {}
  async plan(weekId: string) {
    this.calls.push({ weekId, itemsAtCall: await this.repos.items.get(weekId) });
    return { planned: weekId };
  }
}

function setup(kv = new MemoryKeyValueStore()) {
  const repos = new Repositories(kv);
  const clock = new FakeClock("2025-07-05T15:00:00Z");
  const planner = new FakePlanner(repos);
  const service = new IntakeService({
    repos,
    clock,
    ids: new DeterministicIdGenerator("item"),
    planner,
  });
  return { kv, repos, clock, planner, service };
}

describe("IntakeService.validate", () => {
  it("returns candidates and stores the exact text and candidates in the draft", async () => {
    const { service, repos, clock, planner } = setup();
    const raw = "  Finish report | 90 | 1 | work\n\nGym\n";
    const result = await service.validate(raw);
    expect(result).toEqual({
      ok: true,
      text: raw,
      candidates: [
        {
          text: "Finish report",
          durationMin: 90,
          priority: 1,
          category: "work",
          lowConfidence: false,
          count: 1,
          source: { duration: "stated", category: "stated" },
        },
        {
          // Nothing stated: the keyword picks the category and its default duration.
          text: "Gym",
          durationMin: 45,
          priority: 3,
          category: "fitness",
          lowConfidence: true,
          count: 1,
          source: { duration: "default", category: "keyword" },
        },
      ],
    });
    const draft = await repos.intakeDraft.get();
    expect(draft).toEqual({ text: raw, candidates: result.ok ? result.candidates : [], updatedAt: clock.now() });
    // Nothing is persisted as items and nothing is planned before confirm.
    expect(await repos.items.get(WEEK)).toEqual([]);
    expect(planner.calls).toEqual([]);
  });

  it.each([
    ["", "empty"],
    ["   \n\t ", "empty"],
    ["[oops", "malformed-json"],
    [Array.from({ length: 101 }, (_, i) => `task ${i}`).join("\n"), "too-many-items"],
    ["x".repeat(20_001), "too-long"],
  ] as const)("rejects %j with %s and keeps the exact text", async (raw, reason) => {
    const { service, repos } = setup();
    const result = await service.validate(raw);
    expect(result).toEqual({ ok: false, text: raw, reason });
    const draft = await repos.intakeDraft.get();
    expect(draft?.text).toBe(raw);
    expect(draft?.candidates).toBeUndefined();
  });

  it("a rejection replaces earlier candidates so they cannot be confirmed", async () => {
    const { service, planner } = setup();
    await service.validate("Gym");
    await service.validate("[oops");
    expect(await service.confirm(WEEK)).toEqual({ ok: false, error: "no-draft" });
    expect(planner.calls).toEqual([]);
  });

  it("the draft survives an app restart", async () => {
    const { kv, service } = setup();
    await service.validate("Gym\nRead");
    const reopened = setup(kv).service;
    expect((await reopened.draft())?.text).toBe("Gym\nRead");
    expect((await reopened.draft())?.candidates).toHaveLength(2);
  });
});

describe("IntakeService.confirm", () => {
  it("does nothing without a draft", async () => {
    const { service, planner, kv } = setup();
    expect(await service.confirm(WEEK)).toEqual({ ok: false, error: "no-draft" });
    expect(planner.calls).toEqual([]);
    expect(kv.writes).toBe(0);
  });

  it("persists confirmed items with edits before planning, then clears the draft", async () => {
    const { service, repos, planner } = setup();
    await service.validate("Finish report | 90 | 1 | work\nGym");
    const result = await service.confirm(WEEK, [
      { index: 1, durationMin: 45, priority: 2, category: "fitness" },
      { index: 7, durationMin: 10 }, // out of range: ignored
    ]);
    const expected: IntakeItem[] = [
      { id: "item-1", text: "Finish report", durationMin: 90, priority: 1, category: "work", confirmed: true, weekId: WEEK },
      { id: "item-2", text: "Gym", durationMin: 45, priority: 2, category: "fitness", confirmed: true, weekId: WEEK },
    ];
    expect(result).toEqual({ ok: true, weekId: WEEK, confirmed: expected, plan: { planned: WEEK } });
    expect(await repos.items.get(WEEK)).toEqual(expected);
    // Planning ran once, after the confirmed items were already persisted.
    expect(planner.calls).toEqual([{ weekId: WEEK, itemsAtCall: expected }]);
    expect(await repos.intakeDraft.get()).toBeNull();
  });

  it("normalizes out-of-range edits and ignores a blank text edit", async () => {
    const { service } = setup();
    await service.validate("Gym");
    const result = await service.confirm(WEEK, [
      { index: 0, text: "   ", durationMin: 10_000, priority: 9 },
    ]);
    expect(result.ok && result.confirmed[0]).toMatchObject({
      text: "Gym",
      durationMin: 480,
      priority: 5,
    });
  });

  it("appends to the week's existing items", async () => {
    const { service, repos } = setup();
    await service.validate("Gym");
    await service.confirm(WEEK);
    await service.validate("Read");
    await service.confirm(WEEK);
    const items = await repos.items.get(WEEK);
    expect(items.map((i) => [i.id, i.text, i.confirmed])).toEqual([
      ["item-1", "Gym", true],
      ["item-2", "Read", true],
    ]);
  });

  it("does not plan when persisting the confirmed items fails", async () => {
    const { service, kv, planner, repos } = setup();
    await service.validate("Gym");
    kv.failNextWrite();
    await expect(service.confirm(WEEK)).rejects.toThrow("Simulated storage failure");
    expect(planner.calls).toEqual([]);
    expect(await repos.items.get(WEEK)).toEqual([]);
    expect((await repos.intakeDraft.get())?.text).toBe("Gym");
  });
});

describe("IntakeService.submit", () => {
  const entry = (title: string, durationMin: number, extra: Record<string, unknown> = {}) => ({
    title,
    category: "work" as const,
    durationMin,
    ...extra,
  });

  function withHistory(history: { blocks: ReturnType<typeof entry>[]; events: ReturnType<typeof entry>[] }) {
    const base = setup();
    const service = new IntakeService({
      repos: base.repos,
      clock: base.clock,
      ids: new DeterministicIdGenerator("item"),
      planner: base.planner,
      history: { load: async () => history },
    });
    return { ...base, service };
  }

  it("without history uses keywords, inline durations and defaults, then plans", async () => {
    const { service, repos, planner } = setup();
    const result = await service.submit("Gym\nWrite report 2h\nMisc thing", WEEK);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan).toEqual({ planned: WEEK });
    expect(result.confirmed.map((i) => [i.text, i.category, i.durationMin])).toEqual([
      ["Gym", "fitness", 45],
      ["Write report", "work", 120],
      ["Misc thing", "misc", 30],
    ]);
    expect(await repos.items.get(WEEK)).toEqual(result.confirmed);
    expect(planner.calls).toHaveLength(1);
    expect(await repos.intakeDraft.get()).toBeNull();
  });

  it("uses the median duration of similar past blocks", async () => {
    const { service } = withHistory({
      blocks: [entry("Weekly report", 60), entry("Weekly report", 90), entry("Weekly report", 120)],
      events: [],
    });
    const result = await service.submit("Weekly report", WEEK);
    expect(result.ok && result.confirmed[0]?.durationMin).toBe(90);
  });

  it("ignores skipped past blocks when estimating", async () => {
    const { service } = withHistory({
      blocks: [
        entry("Weekly report", 15, { status: "skipped" }),
        entry("Weekly report", 15, { status: "skipped" }),
        entry("Weekly report", 75, { status: "done" }),
      ],
      events: [],
    });
    const result = await service.submit("Weekly report", WEEK);
    expect(result.ok && result.confirmed[0]?.durationMin).toBe(75);
  });

  it("keeps explicit pipe values over history", async () => {
    const { service } = withHistory({ blocks: [entry("Weekly report", 90)], events: [] });
    const result = await service.submit("Weekly report | 25 | 2 | self-care", WEEK);
    expect(result.ok && result.confirmed[0]).toMatchObject({
      durationMin: 25,
      priority: 2,
      category: "self-care",
    });
  });

  it("passes the target week to the history reader", async () => {
    const weeks: string[] = [];
    const base = setup();
    const service = new IntakeService({
      repos: base.repos,
      clock: base.clock,
      ids: new DeterministicIdGenerator("item"),
      planner: base.planner,
      history: { load: async (w) => (weeks.push(w), { blocks: [], events: [] }) },
    });
    await service.submit("Gym", WEEK);
    expect(weeks).toEqual([WEEK]);
  });

  it("falls back to empty history when the reader throws", async () => {
    const base = setup();
    const service = new IntakeService({
      repos: base.repos,
      clock: base.clock,
      ids: new DeterministicIdGenerator("item"),
      planner: base.planner,
      history: { load: async () => Promise.reject(new Error("boom")) },
    });
    const result = await service.submit("Gym", WEEK);
    expect(result.ok && result.confirmed[0]?.category).toBe("fitness");
  });

  it.each([
    ["", "empty"],
    ["[oops", "malformed-json"],
    ["x".repeat(20_001), "too-long"],
  ] as const)("rejects %j with %s without planning", async (raw, reason) => {
    const { service, planner, repos } = setup();
    expect(await service.submit(raw, WEEK)).toEqual({ ok: false, error: "rejected", reason });
    expect(planner.calls).toEqual([]);
    expect(await repos.items.get(WEEK)).toEqual([]);
    expect((await repos.intakeDraft.get())?.text).toBe(raw);
  });
});

describe("IntakeService counted tasks (R20)", () => {
  it("expands a count of 3 into 3 items sharing a seriesId", async () => {
    const { service, repos } = setup();
    await service.validate("Gym 3x");
    const result = await service.confirm(WEEK);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.confirmed.map((i) => i.text)).toEqual(["Gym (1 of 3)", "Gym (2 of 3)", "Gym (3 of 3)"]);
    expect(new Set(result.confirmed.map((i) => i.id)).size).toBe(3);
    expect(new Set(result.confirmed.map((i) => i.seriesId)).size).toBe(1);
    expect(result.confirmed[0]?.seriesId).toBeDefined();
    expect(result.confirmed[0]?.seriesId).not.toBe(result.confirmed[0]?.id);
    expect(result.confirmed.map((i) => [i.seriesIndex, i.seriesSize])).toEqual([[1, 3], [2, 3], [3, 3]]);
    expect(await repos.items.get(WEEK)).toEqual(result.confirmed);
  });

  it("leaves a count of 1 unchanged, without series fields", async () => {
    const { service } = setup();
    await service.validate("Gym");
    const result = await service.confirm(WEEK);
    expect(result.ok && result.confirmed).toEqual([
      { id: "item-1", text: "Gym", durationMin: 45, priority: 3, category: "fitness", confirmed: true, weekId: WEEK },
    ]);
  });

  it("applies edits to every item of the series, keeping the suffix", async () => {
    const { service } = setup();
    await service.validate("Read 2x\nGym");
    const result = await service.confirm(WEEK, [
      { index: 0, durationMin: 20, priority: 1, category: "self-development", text: "Novel" },
      { index: 1, priority: 2 },
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.confirmed.map((i) => [i.text, i.durationMin, i.priority, i.category])).toEqual([
      ["Novel (1 of 2)", 20, 1, "self-development"],
      ["Novel (2 of 2)", 20, 1, "self-development"],
      ["Gym", 45, 2, "fitness"],
    ]);
  });

  it("treats a stored draft without count as 1", async () => {
    const { service, repos } = setup();
    await repos.intakeDraft.save({
      text: "Gym",
      updatedAt: 1,
      candidates: [{ text: "Gym", durationMin: 45, priority: 3, category: "fitness", lowConfidence: false } as never],
    });
    const result = await service.confirm(WEEK);
    expect(result.ok && result.confirmed.map((i) => i.text)).toEqual(["Gym"]);
  });

  it("rejects an expanded total over 100 and keeps the draft", async () => {
    const { service, repos, planner } = setup();
    const raw = Array.from({ length: 51 }, (_, i) => `task${i} 2x`).join("\n");
    expect(await service.submit(raw, WEEK)).toEqual({ ok: false, error: "rejected", reason: "too-many-items" });
    // A stored draft that slipped past validation is rejected by confirm too.
    await repos.intakeDraft.save({
      text: raw,
      updatedAt: 1,
      candidates: Array.from({ length: 51 }, (_, i) => ({
        text: `task${i}`, durationMin: 30, priority: 3, category: "misc" as const, lowConfidence: false, count: 2,
      })),
    });
    expect(await service.confirm(WEEK)).toEqual({ ok: false, error: "rejected", reason: "too-many-items" });
    expect(planner.calls).toEqual([]);
    expect(await repos.items.get(WEEK)).toEqual([]);
    expect(await repos.intakeDraft.get()).not.toBeNull();
  });

  it("gives duration + count on one line equal durations", async () => {
    const { service } = setup();
    const result = await service.submit("Write report 3x 2h", WEEK);
    expect(result.ok && result.confirmed.map((i) => i.durationMin)).toEqual([120, 120, 120]);
  });

  it("matches suffixed history titles against a new plain item", async () => {
    const base = setup();
    const e = (n: number) => ({ title: `Zumba (${n} of 3)`, category: "self-care" as const, durationMin: 40 });
    const service = new IntakeService({
      repos: base.repos,
      clock: base.clock,
      ids: new DeterministicIdGenerator("item"),
      planner: base.planner,
      history: { load: async () => ({ blocks: [e(1), e(2), e(3)], events: [] }) },
    });
    const result = await service.submit("Zumba", WEEK);
    expect(result.ok && result.confirmed[0]).toMatchObject({ durationMin: 40, category: "self-care" });
  });
});

describe("IntakeService + PlanningService spread (R20.5)", () => {
  const dayOf = (iso: string) =>
    new Intl.DateTimeFormat("en-CA", { timeZone: "America/Toronto" }).format(new Date(iso));

  function wired() {
    const kv = new MemoryKeyValueStore();
    const repos = new Repositories(kv);
    const clock = new FakeClock("2025-07-06T13:00:00Z"); // Sunday morning, Toronto
    const planning = new PlanningService({
      repos,
      clock,
      ids: new DeterministicIdGenerator("blk"),
      notifications: new NotificationService(repos, new FakeNotifier(), clock),
    });
    const intake = new IntakeService({
      repos,
      clock,
      ids: new DeterministicIdGenerator("item"),
      planner: planning,
    });
    return { repos, intake };
  }

  it.each([["Study 3x", "work"], ["Gym 3x", "fitness"]])("puts %s on 3 different days", async (line) => {
    const { repos, intake } = wired();
    const result = await intake.submit(line, WEEK);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.unplaced).toEqual([]);
    const blocks = await repos.blocks.get(WEEK);
    expect(blocks).toHaveLength(3);
    expect(blocks.map((b) => b.title).sort()).toEqual(
      [1, 2, 3].map((n) => `${line.split(" ")[0]} (${n} of 3)`),
    );
    expect(new Set(blocks.map((b) => dayOf(b.start))).size).toBe(3);
  });

  it("falls back to sharing a day when the count exceeds the days, without nothing-fits", async () => {
    const { repos, intake } = wired();
    const result = await intake.submit("Study 8x 30min", WEEK);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.unplaced).toEqual([]);
    expect(result.plan.alert).toBeUndefined();
    const blocks = await repos.blocks.get(WEEK);
    expect(blocks).toHaveLength(8);
    expect(blocks.map((b) => b.title)).toContain("Study (8 of 8)");
    expect(new Set(blocks.map((b) => dayOf(b.start))).size).toBeLessThan(8);
  });
});

describe("IntakeService real-world lines (R22)", () => {
  const RAW = [
    "Go to the gym x 3 – Legs/Chest/Full Body",
    "Study for cloud certification exam – 10 hours",
    "Do laundry",
    "Go grocery shopping",
    "Meal prep – 40 minutes, twice this week",
    "Get 8 hours of sleep every night",
    "Study AI concepts",
    "Build out networking project – 6 hours",
  ].join("\n");

  it("validate carries ignored lines into the result and the draft", async () => {
    const { service } = setup();
    const result = await service.validate(RAW);
    const ignored = [{ text: "Get 8 hours of sleep every night", reason: "sleep" }];
    expect(result).toMatchObject({ ok: true, ignored });
    expect((await service.draft())?.ignored).toEqual(ignored);
  });

  it("submit expands splits, drops sleep and reports ignored", async () => {
    const { service, repos } = setup();
    const result = await service.submit(RAW, WEEK);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.ignored).toEqual([{ text: "Get 8 hours of sleep every night", reason: "sleep" }]);
    const items = await repos.items.get(WEEK);
    // 3 gym + 5 cloud + laundry + groceries + 2 meal prep + AI + 3 networking
    expect(items).toHaveLength(16);
    const net = items.filter((i) => i.text.startsWith("Build out networking project"));
    expect(net.map((i) => [i.text, i.durationMin])).toEqual([
      ["Build out networking project (1 of 3)", 120],
      ["Build out networking project (2 of 3)", 120],
      ["Build out networking project (3 of 3)", 120],
    ]);
    const cloud = items.filter((i) => i.text.startsWith("Study for cloud certification exam"));
    expect(cloud).toHaveLength(5);
    expect(cloud.every((i) => i.durationMin === 120 && i.category === "self-development")).toBe(true);
    expect(items.some((i) => /sleep/i.test(i.text))).toBe(false);
  });

  it("a sleep-only submission is rejected as no-items", async () => {
    const { service } = setup();
    expect(await service.submit("Get 8 hours of sleep", WEEK)).toEqual({
      ok: false,
      error: "rejected",
      reason: "no-items",
    });
  });
});

describe("IntakeService scheduling text routing (R28)", () => {
  const FRI = "2025-07-11T15:00:00Z"; // Friday 11:00 Toronto
  const THIS_WEEK = "2025-07-06";
  const NEXT_WEEK = "2025-07-13";
  function setupAt(now: string) {
    const s = setup();
    s.clock.set(now);
    return s;
  }

  it("routes a Tuesday-dated item into next week and plans both weeks", async () => {
    const { service, repos, planner } = setupAt(FRI);
    await service.validate("Dentist Tuesday 3pm | 60 | 2 | personal\nWrite report | 60 | 2 | work");
    const draft = await repos.intakeDraft.get();
    expect(draft?.candidates?.[0]?.fixedStart).toBeDefined();
    const result = await service.confirm(THIS_WEEK);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan).toEqual({ planned: THIS_WEEK });
    expect(result.otherPlans).toEqual([{ planned: NEXT_WEEK }]);
    expect(planner.calls.map((c) => c.weekId)).toEqual([THIS_WEEK, NEXT_WEEK]);
    const now = await repos.items.get(THIS_WEEK);
    const next = await repos.items.get(NEXT_WEEK);
    expect(now.map((i) => i.text)).toEqual(["Write report"]);
    expect(next).toHaveLength(1);
    expect(next[0]).toMatchObject({ weekId: NEXT_WEEK, confirmed: true });
    expect(next[0]!.fixedStart).toBeDefined();
    // Both weeks were already persisted when the first plan ran.
    expect(planner.calls[0]!.itemsAtCall).toHaveLength(1);
    expect(await repos.items.get(NEXT_WEEK)).toHaveLength(1);
  });

  it("merges into items already stored for the other week", async () => {
    const { service, repos } = setupAt(FRI);
    const old: IntakeItem = { id: "old", text: "Old", durationMin: 30, priority: 3, category: "work", confirmed: true, weekId: NEXT_WEEK };
    await repos.items.save(NEXT_WEEK, [old]);
    await service.validate("Dentist Tuesday 3pm | 60 | 2 | personal");
    await service.confirm(THIS_WEEK);
    expect((await repos.items.get(NEXT_WEEK)).map((i) => i.id)).toEqual(["old", "item-1"]);
  });

  it("commits both weeks and clears the draft in one atomic write", async () => {
    const { service, repos, kv } = setupAt(FRI);
    await service.validate("Dentist Tuesday 3pm | 60 | 2 | personal\nWrite report | 60 | 2 | work");
    const before = kv.writes;
    let commits = 0;
    const orig = repos.commit.bind(repos);
    repos.commit = (w) => {
      commits += 1;
      return orig(w);
    };
    await service.confirm(THIS_WEEK);
    expect(commits).toBe(1);
    expect(kv.writes - before).toBeGreaterThanOrEqual(1);
    expect(await repos.intakeDraft.get()).toBeNull();
    expect(await repos.items.get(THIS_WEEK)).toHaveLength(1);
    expect(await repos.items.get(NEXT_WEEK)).toHaveLength(1);
  });

  it("returns an empty plan for the requested week when every item is dated elsewhere", async () => {
    const { service, planner } = setupAt(FRI);
    await service.validate("Dentist Tuesday 3pm | 60 | 2 | personal");
    const result = await service.confirm(THIS_WEEK);
    expect(result.ok && result.plan).toEqual({ planned: THIS_WEEK });
    expect(planner.calls.map((c) => c.weekId)).toEqual([THIS_WEEK, NEXT_WEEK]);
  });

  it("routes onDay items to the week of that day", async () => {
    const { service, repos } = setupAt(FRI);
    await service.validate("Laundry on Monday | 30 | 3 | personal");
    const draft = await repos.intakeDraft.get();
    expect(draft?.candidates?.[0]?.onDay).toBe("2025-07-14");
    await service.confirm(THIS_WEEK);
    const next = await repos.items.get(NEXT_WEEK);
    expect(next[0]).toMatchObject({ onDay: "2025-07-14", weekId: NEXT_WEEK });
  });

  it("keeps a deadline item in the requested week (R28.5)", async () => {
    const { service, repos } = setupAt(FRI);
    await service.validate("Essay due Tuesday 5pm | 120 | 3 | school");
    const result = await service.confirm(THIS_WEEK);
    expect(result.ok && result.otherPlans).toBeUndefined();
    const items = await repos.items.get(THIS_WEEK);
    expect(items).toHaveLength(1);
    expect(items[0]!.dueAt).toBeDefined();
    expect(items[0]!.priority).toBe(1);
    expect(await repos.items.get(NEXT_WEEK)).toEqual([]);
  });

  it("surfaces notes prefixed with the task title and plans a past date as normal", async () => {
    const { service, repos } = setupAt(FRI);
    await service.validate("Dentist on 2025-07-01 | 60 | 2 | personal");
    const result = await service.confirm(THIS_WEEK);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.notes?.length).toBe(1);
    expect(result.notes![0]).toMatch(/^Dentist.*: Date in the past was ignored$/);
    expect(result.otherPlans).toBeUndefined();
    const items = await repos.items.get(THIS_WEEK);
    expect(items[0]!.fixedStart).toBeUndefined();
    expect(items[0]!.onDay).toBeUndefined();
  });

  it("a counted line with a fixed time expands without fixed fields and notes it", async () => {
    const { service, repos } = setupAt(FRI);
    await service.validate("Gym 3 times Tuesday 3pm | 45 | 3 | fitness");
    const result = await service.confirm(THIS_WEEK);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.notes?.some((n) => n.endsWith("Fixed time ignored for repeated tasks"))).toBe(true);
    const items = await repos.items.get(THIS_WEEK);
    expect(items).toHaveLength(3);
    for (const i of items) {
      expect(i.fixedStart).toBeUndefined();
      expect(i.onDay).toBeUndefined();
    }
  });

  it("passes the clock to validation (past date relative to the fake clock)", async () => {
    const { service, clock } = setupAt("2030-01-01T15:00:00Z");
    clock.set("2030-01-01T15:00:00Z");
    const r = await service.validate("Dentist on 2025-07-01 | 60 | 2 | personal");
    expect(r.ok && r.candidates[0]!.scheduleNotes?.length).toBe(1);
  });
});
