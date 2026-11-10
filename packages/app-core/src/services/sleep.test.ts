import { describe, expect, it } from "vitest";
import { healthReadWindow, nightWindow } from "@timeblocker/usage-metrics";
import { Repositories } from "../repositories.js";
import { FakeClock, FakeSleepSource, FakeUsageSource, MemoryKeyValueStore } from "../testkit.js";
import { SleepService } from "./sleep.js";

const NOW = "2025-01-15T17:00:00Z"; // noon Toronto; last ended nights: 01-14, 01-13, 01-12

function setup(opts: { now?: string; permission?: "granted" | "denied" } = {}) {
  const repos = new Repositories(new MemoryKeyValueStore());
  const usage = new FakeUsageSource(
    [{ packageName: "com.x", foregroundTimeMs: 10 * 60_000 }],
    opts.permission ?? "granted",
  );
  const clock = new FakeClock(opts.now ?? NOW);
  const sleep = new SleepService({ repos, usage, clock });
  return { repos, usage, clock, sleep };
}

describe("SleepService.recordRecentNights", () => {
  it("scores the last 3 ended nights with one read each", async () => {
    const { sleep, usage, repos } = setup();
    const r = await sleep.recordRecentNights();
    expect(r).toEqual({ recorded: ["2025-01-14", "2025-01-13", "2025-01-12"], skipped: undefined });
    expect(usage.reads).toEqual([
      nightWindow("2025-01-14"),
      nightWindow("2025-01-13"),
      nightWindow("2025-01-12"),
    ]);
    const stored = await repos.sleepScores.get();
    expect(stored["2025-01-14"]).toEqual({
      dateKey: "2025-01-14",
      usageMin: 10,
      score: 85,
      scoredAt: Date.parse(NOW),
      source: "usage",
    });
  });

  it("is idempotent: stored nights are not read again", async () => {
    const { sleep, usage } = setup();
    await sleep.recordRecentNights();
    usage.reads.length = 0;
    const r = await sleep.recordRecentNights();
    expect(usage.reads).toHaveLength(0);
    expect(r).toEqual({ recorded: [], skipped: "none" });
  });

  it("scores only new nights on a later day", async () => {
    const { sleep, usage, clock } = setup();
    await sleep.recordRecentNights();
    usage.reads.length = 0;
    clock.set("2025-01-16T17:00:00Z");
    const r = await sleep.recordRecentNights();
    expect(r.recorded).toEqual(["2025-01-15"]);
    expect(usage.reads).toEqual([nightWindow("2025-01-15")]);
  });

  it("does not score a night that has not ended (before 06:30)", async () => {
    const { sleep } = setup({ now: "2025-01-15T11:00:00Z" }); // 06:00 Toronto
    const r = await sleep.recordRecentNights();
    expect(r.recorded).toEqual(["2025-01-13", "2025-01-12", "2025-01-11"]);
  });

  it("records nothing when permission is denied", async () => {
    const { sleep, usage, repos } = setup({ permission: "denied" });
    const r = await sleep.recordRecentNights();
    expect(r).toEqual({ recorded: [], skipped: "permission-denied" });
    expect(usage.reads).toHaveLength(0);
    expect(await repos.sleepScores.get()).toEqual({});
  });

  it("a failed night writes nothing, does not stop the others, and is retried", async () => {
    const { sleep, usage, repos } = setup();
    const bad = nightWindow("2025-01-13");
    usage.setRecords((w) => {
      if (w.startMs === bad.startMs) throw new Error("read failed");
      return [];
    });
    const r = await sleep.recordRecentNights();
    expect(r.recorded).toEqual(["2025-01-14", "2025-01-12"]);
    expect(Object.keys(await repos.sleepScores.get()).sort()).toEqual(["2025-01-12", "2025-01-14"]);

    usage.setRecords([{ packageName: "com.y", foregroundTimeMs: 60_000 }]);
    usage.reads.length = 0;
    const retry = await sleep.recordRecentNights();
    expect(retry.recorded).toEqual(["2025-01-13"]);
    expect(usage.reads).toEqual([bad]);
    expect((await repos.sleepScores.get())["2025-01-13"]?.usageMin).toBe(1);
  });

  it("never throws, even when the permission check or the store fails", async () => {
    const { repos, clock } = setup();
    const throwing = {
      permission: async () => {
        throw new Error("boom");
      },
      readUsage: async () => [],
    };
    const sleep = new SleepService({ repos, usage: throwing, clock });
    await expect(sleep.recordRecentNights()).resolves.toEqual({ recorded: [], skipped: undefined });
  });

  it("excludes the TimeBlocker package and system UI from usage", async () => {
    const { sleep, usage, repos } = setup();
    usage.setRecords([
      { packageName: "com.timeblocker.app", foregroundTimeMs: 30 * 60_000 },
      { packageName: "com.android.systemui", foregroundTimeMs: 30 * 60_000 },
    ]);
    await sleep.recordRecentNights();
    const stored = await repos.sleepScores.get();
    expect(stored["2025-01-14"]).toMatchObject({ usageMin: 0, score: 100 });
  });

  it("stores only date, minutes, score and time (no per-app data)", async () => {
    const { sleep, repos } = setup();
    await sleep.recordRecentNights();
    const stored = await repos.sleepScores.get();
    expect(Object.keys(stored["2025-01-14"]!).sort()).toEqual([
      "dateKey",
      "score",
      "scoredAt",
      "source",
      "usageMin",
    ]);
  });

  it("prunes scores older than 26 weeks and keeps recent ones", async () => {
    const { sleep, repos } = setup();
    const old = { dateKey: "2024-01-01", usageMin: 1, score: 99, scoredAt: 1, source: "usage" as const };
    const keep = { dateKey: "2024-12-01", usageMin: 2, score: 97, scoredAt: 1, source: "usage" as const };
    await repos.sleepScores.save({ "2024-01-01": old, "2024-12-01": keep });
    await sleep.recordRecentNights();
    const stored = await repos.sleepScores.get();
    expect(stored["2024-01-01"]).toBeUndefined();
    expect(stored["2024-12-01"]).toEqual(keep);
    expect(Object.keys(stored)).toHaveLength(4);
  });

  it("prunes even when nothing new is recorded", async () => {
    const { sleep, repos } = setup();
    await sleep.recordRecentNights();
    await repos.sleepScores.save({
      ...(await repos.sleepScores.get()),
      "2023-05-05": { dateKey: "2023-05-05", usageMin: 0, score: 100, scoredAt: 1, source: "usage" as const },
    });
    await sleep.recordRecentNights();
    expect((await repos.sleepScores.get())["2023-05-05"]).toBeUndefined();
  });

  it("scores the DST nights with the right windows", async () => {
    const { sleep, usage } = setup({ now: "2025-03-09T15:00:00Z" });
    await sleep.recordRecentNights();
    expect(usage.reads[0]).toEqual(nightWindow("2025-03-08"));
    expect(usage.reads[0]!.endMs - usage.reads[0]!.startMs).toBe(7.5 * 3_600_000);
  });
});

describe("SleepService.scoresForWeek", () => {
  const score = (dateKey: string, n: number) => ({ dateKey, usageMin: 0, score: n, scoredAt: 1, source: "usage" as const });

  it("returns nights Sunday..Saturday, including a Saturday night, oldest first", async () => {
    const { sleep, repos } = setup();
    await repos.sleepScores.save({
      "2025-01-11": score("2025-01-11", 1), // previous Saturday
      "2025-01-12": score("2025-01-12", 2), // Sunday
      "2025-01-15": score("2025-01-15", 3),
      "2025-01-18": score("2025-01-18", 4), // Saturday night
      "2025-01-19": score("2025-01-19", 5), // next Sunday
    });
    const week = await sleep.scoresForWeek("2025-01-12");
    expect(week.map((s) => s.score)).toEqual([2, 3, 4]);
  });

  it("is empty when nothing is stored", async () => {
    const { sleep } = setup();
    expect(await sleep.scoresForWeek("2025-01-12")).toEqual([]);
  });
});

describe("SleepService with a SleepSource (R25)", () => {
  const HOUR = 3_600_000;
  /** 23:00 EST the night of `key` (winter) for 8 h, with `asleepMin` asleep. */
  const winterSession = (key: string, asleepMin = 420) => {
    const startMs = Date.parse(`${key}T00:00:00Z`) + 28 * HOUR; // 04:00Z next day
    return { startMs, endMs: startMs + 8 * HOUR, asleepMin };
  };
  const bySession = (w: { startMs: number; endMs: number }) =>
    ["2025-01-14", "2025-01-13", "2025-01-12"]
      .map((k) => winterSession(k))
      .filter((s) => s.startMs >= w.startMs && s.startMs < w.endMs);

  function setupHealth(
    opts: {
      health?: FakeSleepSource;
      usagePermission?: "granted" | "denied";
      now?: string;
      records?: { packageName: string; foregroundTimeMs: number }[];
    } = {},
  ) {
    const repos = new Repositories(new MemoryKeyValueStore());
    const usage = new FakeUsageSource(
      opts.records ?? [{ packageName: "com.x", foregroundTimeMs: 10 * 60_000 }],
      opts.usagePermission ?? "granted",
    );
    const clock = new FakeClock(opts.now ?? NOW);
    const sleepSource = opts.health ?? new FakeSleepSource(bySession);
    const sleep = new SleepService({ repos, usage, clock, sleepSource });
    return { repos, usage, clock, sleep, sleepSource };
  }

  it("scores from the session plus phone use inside it", async () => {
    const { sleep, usage, repos, sleepSource } = setupHealth();
    const r = await sleep.recordRecentNights();
    expect(r).toEqual({ recorded: ["2025-01-14", "2025-01-13", "2025-01-12"], skipped: undefined });
    expect((sleepSource as FakeSleepSource).reads).toEqual([
      healthReadWindow("2025-01-14"),
      healthReadWindow("2025-01-13"),
      healthReadWindow("2025-01-12"),
    ]);
    const s = winterSession("2025-01-14");
    expect(usage.reads[0]).toEqual({ startMs: s.startMs, endMs: s.endMs });
    expect(usage.reads).toHaveLength(3); // no extra fixed-window read
    // 420 min asleep -> 88 (87.5 rounds up), minus round(1.5 * 10) = 15
    expect((await repos.sleepScores.get())["2025-01-14"]).toEqual({
      dateKey: "2025-01-14",
      usageMin: 10,
      asleepMin: 420,
      score: 73,
      scoredAt: Date.parse(NOW),
      source: "health+usage",
    });
  });

  it("falls back to the fixed-window usage score when a night has no qualifying session", async () => {
    const health = new FakeSleepSource((w) => bySession(w).filter((s) => s.startMs !== winterSession("2025-01-13").startMs));
    const { sleep, usage, repos } = setupHealth({ health });
    await sleep.recordRecentNights();
    const stored = await repos.sleepScores.get();
    expect(stored["2025-01-14"]!.source).toBe("health+usage");
    expect(stored["2025-01-13"]).toEqual({
      dateKey: "2025-01-13",
      usageMin: 10,
      score: 85,
      scoredAt: Date.parse(NOW),
      source: "usage",
    });
    expect(usage.reads).toContainEqual(nightWindow("2025-01-13"));
    expect(stored["2025-01-12"]!.source).toBe("health+usage");
  });

  it("ignores sessions shorter than 3 hours", async () => {
    const health = new FakeSleepSource((w) =>
      bySession(w).map((s) => ({ ...s, endMs: s.startMs + 2 * HOUR })),
    );
    const { sleep, repos } = setupHealth({ health });
    await sleep.recordRecentNights();
    expect(Object.values(await repos.sleepScores.get()).every((s) => s.source === "usage")).toBe(true);
  });

  it("falls back to usage when the health read throws, and never throws", async () => {
    const health = new FakeSleepSource(bySession);
    health.failReads = true;
    const { sleep, repos } = setupHealth({ health });
    const r = await sleep.recordRecentNights();
    expect(r.recorded).toHaveLength(3);
    const stored = Object.values(await repos.sleepScores.get());
    expect(stored.every((s) => s.source === "usage" && s.asleepMin === undefined)).toBe(true);
  });

  it("falls back when the permission or availability check throws", async () => {
    const health = new FakeSleepSource(bySession);
    health.permission = async () => {
      throw new Error("boom");
    };
    const { sleep, repos } = setupHealth({ health });
    await expect(sleep.recordRecentNights()).resolves.toMatchObject({ recorded: expect.any(Array) });
    expect(Object.values(await repos.sleepScores.get()).every((s) => s.source === "usage")).toBe(true);
  });

  it("uses the usage-only path when health permission is denied or Health Connect is missing", async () => {
    for (const health of [
      new FakeSleepSource(bySession, "denied"),
      new FakeSleepSource(bySession, "granted", "needs-install"),
      new FakeSleepSource(bySession, "granted", "unsupported"),
    ]) {
      const { sleep, repos, usage } = setupHealth({ health });
      await sleep.recordRecentNights();
      expect(health.reads).toHaveLength(0);
      expect(usage.reads).toEqual([nightWindow("2025-01-14"), nightWindow("2025-01-13"), nightWindow("2025-01-12")]);
      expect(Object.values(await repos.sleepScores.get()).every((s) => s.source === "usage")).toBe(true);
    }
  });

  it("scores from sleep duration alone (phone 0) when usage access is denied", async () => {
    const { sleep, usage, repos } = setupHealth({ usagePermission: "denied" });
    const r = await sleep.recordRecentNights();
    expect(r.recorded).toHaveLength(3);
    expect((await repos.sleepScores.get())["2025-01-14"]).toMatchObject({
      usageMin: 0,
      asleepMin: 420,
      score: 88,
      source: "health+usage",
    });
    // The fake source records a read even when denied, but the service must not call it.
    expect(usage.reads).toHaveLength(0);
  });

  it("skips a night with no session when usage is denied, and retries it later", async () => {
    const health = new FakeSleepSource([]);
    const { sleep, repos } = setupHealth({ health, usagePermission: "denied" });
    const r = await sleep.recordRecentNights();
    expect(r).toEqual({ recorded: [], skipped: undefined });
    expect(await repos.sleepScores.get()).toEqual({});
    health.setSessions(bySession);
    expect((await sleep.recordRecentNights()).recorded).toHaveLength(3);
  });

  it("is permission-denied only when both usage and health are unavailable", async () => {
    const { sleep } = setupHealth({ usagePermission: "denied", health: new FakeSleepSource(bySession, "denied") });
    expect(await sleep.recordRecentNights()).toEqual({ recorded: [], skipped: "permission-denied" });
  });

  it("falls back to the fixed-window score when the usage read inside a found session fails", async () => {
    const { sleep, usage, repos } = setupHealth();
    const s = winterSession("2025-01-14");
    usage.setRecords((w) => {
      if (w.startMs === s.startMs) throw new Error("usage read failed");
      return [{ packageName: "com.x", foregroundTimeMs: 60_000 }];
    });
    const r = await sleep.recordRecentNights();
    expect(r.recorded).toEqual(["2025-01-14", "2025-01-13", "2025-01-12"]);
    expect((await repos.sleepScores.get())["2025-01-14"]).toMatchObject({ source: "usage", usageMin: 1 });
  });

  it("does not rescore stored nights", async () => {
    const { sleep, sleepSource } = setupHealth();
    await sleep.recordRecentNights();
    (sleepSource as FakeSleepSource).reads.length = 0;
    expect(await sleep.recordRecentNights()).toEqual({ recorded: [], skipped: "none" });
    expect((sleepSource as FakeSleepSource).reads).toHaveLength(0);
  });

  it("picks the longest session and excludes TimeBlocker usage from phone minutes", async () => {
    const base = winterSession("2025-01-14");
    const health = new FakeSleepSource((w) =>
      w.startMs === healthReadWindow("2025-01-14").startMs
        ? [
            { startMs: base.startMs, endMs: base.startMs + 4 * HOUR, asleepMin: 200 },
            { startMs: base.startMs + 5 * HOUR, endMs: base.startMs + 13 * HOUR, asleepMin: 450 },
          ]
        : [],
    );
    const { sleep, repos, usage } = setupHealth({
      health,
      records: [
        { packageName: "com.timeblocker.app", foregroundTimeMs: 30 * 60_000 },
        { packageName: "com.y", foregroundTimeMs: 2 * 60_000 },
      ],
    });
    await sleep.recordRecentNights();
    const stored = (await repos.sleepScores.get())["2025-01-14"]!;
    expect(stored).toMatchObject({ asleepMin: 450, usageMin: 2, score: 94 - 3, source: "health+usage" });
    expect(usage.reads[0]).toEqual({ startMs: base.startMs + 5 * HOUR, endMs: base.startMs + 13 * HOUR });
  });

  it("handles the DST nights: reads the 18:00-12:00 window and finds a session after the jump", async () => {
    // 2025-03-09 15:00Z = 11:00 EDT; last ended nights 03-08, 03-07, 03-06.
    const health = new FakeSleepSource((w) => {
      // Bedtime 23:00 EST on 03-08 = 04:00Z 03-09; wake 08:00 EDT = 12:00Z (7 h real time).
      const start = Date.parse("2025-03-09T04:00:00Z");
      return start >= w.startMs && start < w.endMs ? [{ startMs: start, endMs: start + 7 * HOUR, asleepMin: 400 }] : [];
    });
    const { sleep, repos } = setupHealth({ health, now: "2025-03-09T15:00:00Z" });
    await sleep.recordRecentNights();
    expect(health.reads[0]).toEqual(healthReadWindow("2025-03-08"));
    expect(health.reads[0]!.endMs - health.reads[0]!.startMs).toBe(17 * HOUR);
    expect((await repos.sleepScores.get())["2025-03-08"]).toMatchObject({ asleepMin: 400, source: "health+usage" });
  });
});

describe("SleepScore storage compatibility", () => {
  it("reads entries stored before R25 as usage-only and keeps new fields", async () => {
    const kv = new MemoryKeyValueStore();
    kv.data.set(
      "sleepScores",
      JSON.stringify({
        schemaVersion: 1,
        data: {
          "2025-01-01": { dateKey: "2025-01-01", usageMin: 4, score: 94, scoredAt: 7 },
          "2025-01-02": {
            dateKey: "2025-01-02",
            usageMin: 1,
            asleepMin: 400,
            score: 80,
            scoredAt: 8,
            source: "health+usage",
            demo: true,
          },
        },
      }),
    );
    const repos = new Repositories(kv);
    const stored = await repos.sleepScores.get();
    expect(stored["2025-01-01"]).toEqual({ dateKey: "2025-01-01", usageMin: 4, score: 94, scoredAt: 7, source: "usage" });
    expect(stored["2025-01-02"]).toEqual({
      dateKey: "2025-01-02",
      usageMin: 1,
      asleepMin: 400,
      score: 80,
      scoredAt: 8,
      source: "health+usage",
      demo: true,
    });
  });

  it("rejects a bad source value", async () => {
    const kv = new MemoryKeyValueStore();
    kv.data.set(
      "sleepScores",
      JSON.stringify({
        schemaVersion: 1,
        data: { "2025-01-01": { dateKey: "2025-01-01", usageMin: 4, score: 94, scoredAt: 7, source: "bogus" } },
      }),
    );
    expect(await new Repositories(kv).sleepScores.get()).toEqual({});
  });
});
