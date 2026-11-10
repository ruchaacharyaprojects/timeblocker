import { buildPlacementPreferences } from "@timeblocker/flows";
import { torontoDateKey, torontoMinutesOfDay } from "@timeblocker/scheduling-engine";
import { healthSleepScore, nightWindow, selectNightSession, sleepUsageMin } from "@timeblocker/usage-metrics";
import { describe, expect, it } from "vitest";
import { weekIdAt } from "../notifications/service.js";
import { isCalendarEventId } from "../ports.js";
import { shiftWeekId } from "../services/history.js";
import {
  DEMO_DISTRACTION_APPS,
  demoSleepScores,
  demoSleepSessions,
  demoUsageRecords,
  generateDemoBlocks,
  mulberry32,
} from "./demoData.js";

const NOW = Date.parse("2025-06-18T16:00:00Z"); // Wed noon Toronto
const NOWS = [NOW, Date.parse("2025-01-15T17:00:00Z"), Date.parse("2025-11-05T14:00:00Z"), Date.parse("2025-03-12T14:00:00Z")];
const ms = (iso: string) => Date.parse(iso);
const hourOf = (iso: string) => Math.floor(torontoMinutesOfDay(new Date(iso)) / 60);

describe("mulberry32", () => {
  it("is deterministic and in [0, 1)", () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    for (let i = 0; i < 100; i++) {
      const v = a();
      expect(v).toBe(b());
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });
});

describe("generateDemoBlocks", () => {
  it("is deterministic", () => {
    expect(generateDemoBlocks(NOW)).toEqual(generateDemoBlocks(NOW));
  });

  it("covers the 8 weeks before the current week and never the current week", () => {
    for (const now of NOWS) {
      const current = weekIdAt(now);
      const blocks = generateDemoBlocks(now);
      const weeks = [...new Set(blocks.map((b) => b.weekId))];
      expect(weeks).toEqual(Array.from({ length: 8 }, (_, i) => shiftWeekId(current, 8 - i)));
      for (const b of blocks) {
        expect(b.weekId < current).toBe(true);
        expect(weekIdAt(ms(b.start))).toBe(b.weekId);
        expect(ms(b.end)).toBeLessThan(ms(`${current}T05:00:00Z`));
      }
    }
  });

  it("honours the weeks argument", () => {
    expect(new Set(generateDemoBlocks(NOW, 3).map((b) => b.weekId)).size).toBe(3);
    expect(generateDemoBlocks(NOW, 0)).toEqual([]);
  });

  it("makes 12-16 blocks per week", () => {
    for (const now of NOWS) {
      const counts = new Map<string, number>();
      for (const b of generateDemoBlocks(now)) counts.set(b.weekId, (counts.get(b.weekId) ?? 0) + 1);
      for (const n of counts.values()) {
        expect(n).toBeGreaterThanOrEqual(12);
        expect(n).toBeLessThanOrEqual(16);
      }
    }
  });

  it("has unique demo ids, valid event ids, and sync fields set", () => {
    const blocks = generateDemoBlocks(NOW);
    expect(new Set(blocks.map((b) => b.id)).size).toBe(blocks.length);
    expect(new Set(blocks.map((b) => b.calendarEventId)).size).toBe(blocks.length);
    for (const b of blocks) {
      expect(b.id).toMatch(new RegExp(`^demo-${b.weekId}-\\d+$`));
      expect(b.itemId.startsWith("demo-item-")).toBe(true);
      expect(b.calendarEventId).toHaveLength(26);
      expect(isCalendarEventId(b.calendarEventId)).toBe(true);
      expect(b.calendarSynced).toBe(true);
      expect(b.promptedMeetingIds).toEqual([]);
      expect(b.usagePrompted).toBe(false);
      expect(b.updatedAt).toBe(NOW);
      expect(b.status).not.toBe("scheduled");
      expect(b.title).toBeTruthy();
    }
  });

  it("never overlaps, stays in 07:00-21:30 Toronto, with one fitness block per day", () => {
    for (const now of NOWS) {
      const blocks = generateDemoBlocks(now);
      const sorted = [...blocks].sort((a, b) => ms(a.start) - ms(b.start));
      for (let i = 1; i < sorted.length; i++) {
        expect(ms(sorted[i]!.start)).toBeGreaterThanOrEqual(ms(sorted[i - 1]!.end));
      }
      const fitnessDays = new Set<string>();
      for (const b of blocks) {
        const start = torontoMinutesOfDay(new Date(b.start));
        const end = torontoMinutesOfDay(new Date(b.end));
        expect(start).toBeGreaterThanOrEqual(7 * 60);
        expect(end).toBeLessThanOrEqual(21 * 60 + 30);
        expect(torontoDateKey(new Date(b.start))).toBe(torontoDateKey(new Date(b.end)));
        if (b.category === "fitness") {
          const day = torontoDateKey(new Date(b.start));
          expect(fitnessDays.has(day)).toBe(false);
          fitnessDays.add(day);
        }
      }
    }
  });

  it("uses realistic durations and titles per category", () => {
    const range: Record<string, [number, number]> = {
      work: [60, 120],
      "self-development": [45, 90],
      fitness: [45, 45],
      "self-care": [20, 30],
      misc: [30, 45],
    };
    const titles = new Set<string>();
    const cats = new Set<string>();
    for (const b of generateDemoBlocks(NOW)) {
      const min = (ms(b.end) - ms(b.start)) / 60_000;
      const [lo, hi] = range[b.category]!;
      expect(min).toBeGreaterThanOrEqual(lo);
      expect(min).toBeLessThanOrEqual(hi);
      titles.add(b.title);
      cats.add(b.category);
    }
    expect([...cats].sort()).toEqual(["fitness", "misc", "self-care", "self-development", "work"]);
    expect(titles.has("Project report") || titles.has("Email the client")).toBe(true);
    expect(titles.has("Gym") || titles.has("Run")).toBe(true);
  });

  it("includes some skipped and missed blocks", () => {
    const blocks = generateDemoBlocks(NOW);
    expect(blocks.some((b) => b.status === "skipped")).toBe(true);
    expect(blocks.some((b) => b.status === "missed")).toBe(true);
  });

  it("completion follows time of day: work mornings done, evenings missed, fitness evenings done", () => {
    const rate = (pred: (b: ReturnType<typeof generateDemoBlocks>[number]) => boolean, now: number) => {
      const set = generateDemoBlocks(now).filter(pred);
      return { n: set.length, rate: set.filter((b) => b.status === "done").length / Math.max(1, set.length) };
    };
    for (const now of NOWS) {
      const am = rate((b) => b.category === "work" && hourOf(b.start) >= 8 && hourOf(b.start) < 12, now);
      const eve = rate((b) => b.category === "work" && hourOf(b.start) >= 17 && hourOf(b.start) < 21, now);
      const fit = rate((b) => b.category === "fitness" && hourOf(b.start) >= 17 && hourOf(b.start) < 19, now);
      expect(am.n).toBeGreaterThanOrEqual(30);
      expect(eve.n).toBeGreaterThanOrEqual(5);
      expect(am.rate).toBeGreaterThan(0.7);
      expect(am.rate - eve.rate).toBeGreaterThan(0.3);
      expect(fit.rate).toBeGreaterThan(0.6);
    }
  });

  it("teaches the planner: work prefers the morning bucket, fitness the early evening", () => {
    const history = generateDemoBlocks(NOW).map((b) => ({ category: b.category, start: b.start, status: b.status }));
    const prefs = buildPlacementPreferences(history);
    const work = prefs.work!;
    expect(work).toBeDefined();
    const morning = Math.max(work.buckets[4]!, work.buckets[5]!); // 08-12
    const evening = work.buckets[9]!; // 18-20, where evening work blocks cluster
    expect(morning).toBeGreaterThan(0.7);
    expect(evening).toBeLessThan(0.55);
    expect(morning - evening).toBeGreaterThan(0.25);
    const best = work.buckets.indexOf(Math.max(...work.buckets));
    expect([4, 5]).toContain(best);
    const fitness = prefs.fitness!;
    expect(fitness).toBeDefined();
    expect(Math.max(fitness.buckets[8]!, fitness.buckets[9]!)).toBeGreaterThan(fitness.overall - 0.001);
    const dev = prefs["self-development"]!;
    expect(dev.buckets[9]!).toBeGreaterThan(dev.buckets[6]!); // 18-20 beats 12-14
  });
});

describe("demoUsageRecords", () => {
  const day = { startMs: ms("2025-06-18T13:00:00Z"), endMs: ms("2025-06-18T15:00:00Z") }; // 09-11 Toronto

  it("is deterministic", () => {
    expect(demoUsageRecords(day)).toEqual(demoUsageRecords(day));
    expect(demoUsageRecords(nightWindow("2025-06-17"))).toEqual(demoUsageRecords(nightWindow("2025-06-17")));
  });

  it("returns distraction and other apps in the daytime, capped by the window", () => {
    const records = demoUsageRecords(day);
    const pkgs = records.map((r) => r.packageName);
    for (const p of DEMO_DISTRACTION_APPS) expect(pkgs).toContain(p);
    expect(pkgs).toEqual(expect.arrayContaining(["com.whatsapp", "com.android.chrome", "com.google.android.apps.maps"]));
    const total = records.reduce((s, r) => s + r.foregroundTimeMs, 0);
    expect(total).toBeLessThanOrEqual(day.endMs - day.startMs);
    for (const r of records) {
      expect(r.foregroundTimeMs).toBeGreaterThan(0);
      expect(r.launchCount).toBeGreaterThanOrEqual(1);
    }
  });

  it("caps a tiny window by its length and scales with longer windows", () => {
    const tiny = { startMs: day.startMs, endMs: day.startMs + 60_000 };
    expect(demoUsageRecords(tiny).reduce((s, r) => s + r.foregroundTimeMs, 0)).toBeLessThanOrEqual(60_000);
    const long = { startMs: day.startMs, endMs: day.startMs + 8 * 3_600_000 };
    const sum = (w: typeof day) => demoUsageRecords(w).reduce((s, r) => s + r.foregroundTimeMs, 0);
    expect(sum(long)).toBeGreaterThan(sum(day));
    expect(demoUsageRecords({ startMs: 5, endMs: 5 })).toEqual([]);
  });

  it("gives small night totals on most nights and 25-70 min on some", () => {
    let small = 0;
    let heavy = 0;
    for (let i = 0; i < 60; i++) {
      const key = new Date(Date.UTC(2025, 0, 1 + i)).toISOString().slice(0, 10);
      const min = sleepUsageMin(demoUsageRecords(nightWindow(key)));
      if (min <= 10) small += 1;
      else {
        heavy += 1;
        expect(min).toBeGreaterThanOrEqual(25);
        expect(min).toBeLessThanOrEqual(70);
      }
    }
    expect(small).toBeGreaterThan(heavy);
    expect(heavy).toBeGreaterThanOrEqual(3);
  });

  it("gives a night the same total for the fixed window and a session inside it", () => {
    for (const key of ["2025-06-10", "2025-06-11", "2025-06-12", "2025-06-13"]) {
      const w = nightWindow(key);
      const session = { startMs: w.startMs + 30 * 60_000, endMs: w.endMs + 60 * 60_000 };
      const fixed = sleepUsageMin(demoUsageRecords(w));
      const inSession = sleepUsageMin(demoUsageRecords(session));
      expect(inSession).toBe(fixed);
    }
  });
});

describe("demoSleepSessions", () => {
  it("is deterministic, oldest first, one per fully ended night", () => {
    const a = demoSleepSessions(NOW);
    expect(a).toEqual(demoSleepSessions(NOW));
    expect(a).toHaveLength(14);
    for (let i = 1; i < a.length; i++) expect(a[i]!.startMs).toBeGreaterThan(a[i - 1]!.endMs);
    for (const s of a) expect(s.endMs).toBeLessThanOrEqual(NOW);
  });

  it("uses bedtimes 22:15-00:30, 5h45-8h30 in bed and 10-45 min awake", () => {
    for (const now of NOWS) {
      for (const s of demoSleepSessions(now, 30)) {
        const bed = torontoMinutesOfDay(new Date(s.startMs));
        const shifted = bed < 12 * 60 ? bed + 1440 : bed;
        expect(shifted).toBeGreaterThanOrEqual(22 * 60 + 15);
        expect(shifted).toBeLessThanOrEqual(24 * 60 + 30);
        const dur = (s.endMs - s.startMs) / 60_000;
        expect(dur).toBeGreaterThanOrEqual(345);
        expect(dur).toBeLessThanOrEqual(510);
        const awake = dur - s.asleepMin;
        expect(awake).toBeGreaterThanOrEqual(10);
        expect(awake).toBeLessThanOrEqual(45);
      }
    }
  });

  it("every session is selected as its night's session", () => {
    const keys = demoSleepScores(NOW).map((s) => s.dateKey);
    const sessions = demoSleepSessions(NOW);
    keys.forEach((k, i) => expect(selectNightSession(k, sessions)).toEqual(sessions[i]));
  });

  it("leaves out a night whose session has not ended yet", () => {
    // 07:00 Toronto: the night ended at 06:30 but a late session may still run.
    const early = Date.parse("2025-06-18T11:00:00Z");
    for (const s of demoSleepSessions(early)) expect(s.endMs).toBeLessThanOrEqual(early);
  });
});

describe("demoSleepScores", () => {
  it("is deterministic and flagged demo, health+usage", () => {
    const a = demoSleepScores(NOW);
    expect(a).toEqual(demoSleepScores(NOW));
    expect(a).toHaveLength(14);
    for (const s of a) {
      expect(s.demo).toBe(true);
      expect(s.source).toBe("health+usage");
      expect(s.scoredAt).toBe(NOW);
    }
    expect(new Set(a.map((s) => s.dateKey)).size).toBe(14);
  });

  it("matches the live pipeline: healthSleepScore over demoUsageRecords per session window", () => {
    const sessions = demoSleepSessions(NOW);
    demoSleepScores(NOW).forEach((s, i) => {
      const sess = sessions[i]!;
      const phone = sleepUsageMin(demoUsageRecords({ startMs: sess.startMs, endMs: sess.endMs }));
      expect(s.usageMin).toBe(phone);
      expect(s.asleepMin).toBe(sess.asleepMin);
      expect(s.score).toBe(healthSleepScore({ asleepMin: sess.asleepMin, phoneMin: phone }));
    });
  });

  it("varies in score", () => {
    const scores = demoSleepScores(NOW, 30).map((s) => s.score);
    expect(Math.max(...scores) - Math.min(...scores)).toBeGreaterThan(15);
    for (const s of scores) {
      expect(s).toBeGreaterThanOrEqual(0);
      expect(s).toBeLessThanOrEqual(100);
    }
  });
});
