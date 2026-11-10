import type { IntakeCandidate } from "@timeblocker/flows";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NotificationService } from "../notifications/service.js";
import { Repositories } from "../repositories.js";
import {
  DeterministicIdGenerator,
  FakeClock,
  FakeNotifier,
  MemoryKeyValueStore,
} from "../testkit.js";
import {
  INTAKE_ENHANCER_TIMEOUT_MS,
  IntakeService,
  type IntakeEnhancer,
} from "./intake.js";
import { PlanningService } from "./planning.js";

const WEEK = "2025-07-06";
// Sunday 2025-07-06 00:00 Toronto, so the whole week is plannable.
const NOW = "2025-07-06T04:00:00.000Z";

function setup(enhancer?: IntakeEnhancer) {
  const kv = new MemoryKeyValueStore();
  const repos = new Repositories(kv);
  const clock = new FakeClock(NOW);
  const ids = new DeterministicIdGenerator("id");
  const notifications = new NotificationService(repos, new FakeNotifier(), clock);
  const planning = new PlanningService({ repos, clock, ids, notifications });
  const service = new IntakeService({
    repos,
    clock,
    ids,
    planner: planning,
    ...(enhancer ? { enhancer } : {}),
  });
  return { repos, service };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("IntakeService enhancer (R33)", () => {
  it("is applied after the built-in estimation and before the draft is saved", async () => {
    const seen: IntakeCandidate[][] = [];
    const { service, repos } = setup(async (cs) => {
      seen.push(cs.map((c) => ({ ...c })));
      return cs.map((c) => ({ ...c, kind: "email" as const, category: "work" as const }));
    });
    const result = await service.validate("email prof | 20\nGym");
    expect(seen).toHaveLength(1);
    // The enhancer receives the built-in estimate (durations already set).
    expect(seen[0]![0]).toMatchObject({ text: "email prof", durationMin: 20 });
    expect(result.ok && result.candidates.map((c) => c.kind)).toEqual(["email", "email"]);
    const draft = await repos.intakeDraft.get();
    expect(draft?.candidates?.map((c) => c.kind)).toEqual(["email", "email"]);
  });

  it("only accepts category and kind from the enhancer; title/duration/priority/count stay", async () => {
    const { service } = setup(async (cs) =>
      cs.map((c) => ({
        ...c,
        text: "HACKED",
        durationMin: 999,
        priority: 5,
        count: 9,
        dueAt: "2030-01-01T00:00:00Z",
        category: "self-care" as const,
        kind: "study" as const,
      })),
    );
    const result = await service.validate("Read chapter | 40 | 2 | work");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.candidates[0]).toMatchObject({
      text: "Read chapter",
      durationMin: 40,
      priority: 2,
      count: 1,
      category: "self-care",
      kind: "study",
    });
    expect(result.candidates[0]).not.toHaveProperty("dueAt");
  });

  it("ignores an invalid kind or category from the enhancer", async () => {
    const { service } = setup(async (cs) =>
      cs.map((c) => ({ ...c, kind: "meeting" as never, category: "chores" as never })),
    );
    const result = await service.validate("Read chapter | 40 | 2 | work");
    expect(result.ok && result.candidates[0]).toMatchObject({ category: "work" });
    expect(result.ok && result.candidates[0]).not.toHaveProperty("kind");
  });

  it("an error leaves the candidates unchanged", async () => {
    const plain = await setup().service.validate("Gym\nEmail prof");
    const { service } = setup(async () => {
      throw new Error("boom");
    });
    expect(await service.validate("Gym\nEmail prof")).toEqual(plain);
  });

  it("a wrong-length or non-array result leaves the candidates unchanged", async () => {
    const plain = await setup().service.validate("Gym\nEmail prof");
    for (const bad of [
      async (cs: IntakeCandidate[]) => cs.slice(0, 1),
      async (cs: IntakeCandidate[]) => [...cs, ...cs],
      async () => null as never,
      async () => [null, null] as never,
    ]) {
      expect(await setup(bad).service.validate("Gym\nEmail prof")).toEqual(plain);
    }
  });

  it("gives up after 6 s and uses the built-in result", async () => {
    vi.useFakeTimers();
    const plain = await setup().service.validate("Gym");
    const { service } = setup(() => new Promise<IntakeCandidate[]>(() => undefined));
    const pending = service.validate("Gym");
    await vi.advanceTimersByTimeAsync(INTAKE_ENHANCER_TIMEOUT_MS - 1);
    let settled = false;
    void pending.then(() => (settled = true));
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toEqual(plain);
    expect(INTAKE_ENHANCER_TIMEOUT_MS).toBe(6000);
  });

  it("is not called for a rejected submission", async () => {
    let calls = 0;
    const { service } = setup(async (cs) => {
      calls++;
      return cs;
    });
    expect((await service.validate("   ")).ok).toBe(false);
    expect(calls).toBe(0);
  });

  it("does not mutate the built-in candidates in place", async () => {
    const { service } = setup(async (cs) => {
      for (const c of cs) c.kind = "workout";
      throw new Error("after mutating");
    });
    const result = await service.validate("Gym");
    expect(result.ok && result.candidates[0]).not.toHaveProperty("kind");
  });
});

describe("kind propagation (R33.1)", () => {
  it("flows from candidate to item to block, including counted series", async () => {
    const { service, repos } = setup(async (cs) =>
      cs.map((c) => (c.text.startsWith("Apply") ? { ...c, kind: "application" as const } : { ...c, kind: "workout" as const })),
    );
    const result = await service.submit("Apply to job xyz | 60\nRun x2 | 30", WEEK);
    expect(result.ok).toBe(true);
    const items = await repos.items.get(WEEK);
    expect(items.map((i) => [i.text, i.kind])).toEqual([
      ["Apply to job xyz", "application"],
      ["Run (1 of 2)", "workout"],
      ["Run (2 of 2)", "workout"],
    ]);
    const blocks = await repos.blocks.get(WEEK);
    expect(blocks).toHaveLength(3);
    for (const b of blocks) {
      const item = items.find((i) => i.id === b.itemId)!;
      expect(b.kind).toBe(item.kind);
    }
  });

  it("items and blocks have no kind without an enhancer", async () => {
    const { service, repos } = setup();
    await service.submit("Gym", WEEK);
    expect((await repos.items.get(WEEK))[0]).not.toHaveProperty("kind");
    expect((await repos.blocks.get(WEEK))[0]).not.toHaveProperty("kind");
  });

  it("a stored draft without kind (older version) still confirms", async () => {
    const { service, repos } = setup();
    await repos.intakeDraft.save({
      text: "Gym",
      updatedAt: 1,
      candidates: [
        { text: "Gym", durationMin: 45, priority: 3, category: "fitness", lowConfidence: false, count: 1 },
      ],
    });
    const out = await service.confirm(WEEK);
    expect(out.ok).toBe(true);
  });
});
