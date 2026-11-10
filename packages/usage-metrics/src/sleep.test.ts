import { describe, expect, it } from "vitest";
import {
  SLEEP_EXCLUDED_PACKAGES,
  nightWindow,
  nightsEndedBefore,
  sleepScore,
  sleepUsageMin,
} from "./index.js";

const HOUR = 3_600_000;

describe("nightWindow", () => {
  it("is 22:00 to 06:30 Toronto in winter (EST, UTC-5)", () => {
    const w = nightWindow("2025-01-15");
    expect(new Date(w.startMs).toISOString()).toBe("2025-01-16T03:00:00.000Z");
    expect(new Date(w.endMs).toISOString()).toBe("2025-01-16T11:30:00.000Z");
  });

  it("is 22:00 to 06:30 Toronto in summer (EDT, UTC-4)", () => {
    const w = nightWindow("2025-07-15");
    expect(new Date(w.startMs).toISOString()).toBe("2025-07-16T02:00:00.000Z");
    expect(new Date(w.endMs).toISOString()).toBe("2025-07-16T10:30:00.000Z");
  });

  it("spring forward night (2025-03-08) is 1 hour shorter", () => {
    const w = nightWindow("2025-03-08");
    expect(new Date(w.startMs).toISOString()).toBe("2025-03-09T03:00:00.000Z");
    expect(new Date(w.endMs).toISOString()).toBe("2025-03-09T10:30:00.000Z");
    expect(w.endMs - w.startMs).toBe(7.5 * HOUR);
  });

  it("fall back night (2025-11-01) is 1 hour longer", () => {
    const w = nightWindow("2025-11-01");
    expect(new Date(w.startMs).toISOString()).toBe("2025-11-02T02:00:00.000Z");
    expect(new Date(w.endMs).toISOString()).toBe("2025-11-02T11:30:00.000Z");
    expect(w.endMs - w.startMs).toBe(9.5 * HOUR);
  });

  it("crosses month and year boundaries", () => {
    const w = nightWindow("2025-12-31");
    expect(new Date(w.endMs).toISOString()).toBe("2026-01-01T11:30:00.000Z");
  });

  it("rejects malformed keys", () => {
    expect(() => nightWindow("2025-1-5")).toThrow(RangeError);
  });
});

describe("sleepScore", () => {
  it("scores known values", () => {
    expect(sleepScore(0)).toBe(100);
    expect(sleepScore(10)).toBe(85);
    expect(sleepScore(20)).toBe(70);
    expect(sleepScore(66)).toBe(1);
    expect(sleepScore(67)).toBe(0);
    expect(sleepScore(500)).toBe(0);
  });

  it("handles NaN, negative and infinite input", () => {
    expect(sleepScore(Number.NaN)).toBe(100);
    expect(sleepScore(-5)).toBe(100);
    expect(sleepScore(Number.POSITIVE_INFINITY)).toBe(0);
  });

  // Feature: timeblocker, Property 29: Sleep score is bounded and non-increasing in phone use
  it("is within 0..100 and non-increasing in usage", () => {
    let seed = 12345;
    const rnd = () => {
      seed = (seed * 1664525 + 1013904223) % 4294967296;
      return seed / 4294967296;
    };
    const samples: number[] = [];
    for (let i = 0; i < 2000; i++) samples.push(rnd() * 300);
    samples.push(0, 0.5, 66.4, 66.7, 1000);
    samples.sort((a, b) => a - b);
    let prev = 101;
    for (const u of samples) {
      const s = sleepScore(u);
      expect(Number.isInteger(s)).toBe(true);
      expect(s).toBeGreaterThanOrEqual(0);
      expect(s).toBeLessThanOrEqual(100);
      expect(s).toBeLessThanOrEqual(prev);
      prev = s;
    }
  });
});

describe("sleepUsageMin", () => {
  it("sums non-excluded apps and rounds to minutes", () => {
    expect(
      sleepUsageMin([
        { packageName: "com.instagram.android", foregroundTimeMs: 90_000 },
        { packageName: "com.youtube", foregroundTimeMs: 60_000 },
      ]),
    ).toBe(3); // 150s = 2.5 min -> 3
  });

  it("excludes TimeBlocker and system UI", () => {
    expect(SLEEP_EXCLUDED_PACKAGES).toEqual(["com.timeblocker.app", "com.android.systemui"]);
    expect(
      sleepUsageMin([
        { packageName: "com.timeblocker.app", foregroundTimeMs: 10 * 60_000 },
        { packageName: "com.android.systemui", foregroundTimeMs: 10 * 60_000 },
        { packageName: "com.x", foregroundTimeMs: 2 * 60_000 },
      ]),
    ).toBe(2);
  });

  it("is 0 for no records and ignores bad durations", () => {
    expect(sleepUsageMin([])).toBe(0);
    expect(
      sleepUsageMin([
        { packageName: "a", foregroundTimeMs: Number.NaN },
        { packageName: "b", foregroundTimeMs: -5 },
      ]),
    ).toBe(0);
  });
});

describe("nightsEndedBefore", () => {
  it("excludes a night that has not ended yet (before 06:30)", () => {
    // 2025-01-15 06:29 Toronto = 11:29Z
    const now = Date.parse("2025-01-15T11:29:00Z");
    expect(nightsEndedBefore(now, 3)).toEqual(["2025-01-13", "2025-01-12", "2025-01-11"]);
  });

  it("includes last night exactly at 06:30 (end <= now)", () => {
    const now = Date.parse("2025-01-15T11:30:00Z");
    expect(nightsEndedBefore(now, 3)).toEqual(["2025-01-14", "2025-01-13", "2025-01-12"]);
  });

  it("uses Toronto date, not UTC date (evening in Toronto)", () => {
    // 2025-01-15 21:00 Toronto = 2025-01-16T02:00Z
    const now = Date.parse("2025-01-16T02:00:00Z");
    expect(nightsEndedBefore(now, 1)).toEqual(["2025-01-14"]);
  });

  it("handles the spring-forward night (2025-03-08 ends 06:30 EDT)", () => {
    const before = Date.parse("2025-03-09T10:29:00Z");
    const at = Date.parse("2025-03-09T10:30:00Z");
    expect(nightsEndedBefore(before, 1)).toEqual(["2025-03-07"]);
    expect(nightsEndedBefore(at, 2)).toEqual(["2025-03-08", "2025-03-07"]);
  });

  it("handles the fall-back night (2025-11-01 ends 06:30 EST)", () => {
    const before = Date.parse("2025-11-02T11:29:00Z");
    const at = Date.parse("2025-11-02T11:30:00Z");
    expect(nightsEndedBefore(before, 1)).toEqual(["2025-10-31"]);
    expect(nightsEndedBefore(at, 1)).toEqual(["2025-11-01"]);
  });

  it("returns [] for count 0 and crosses year ends", () => {
    expect(nightsEndedBefore(Date.now(), 0)).toEqual([]);
    const now = Date.parse("2026-01-01T20:00:00Z");
    expect(nightsEndedBefore(now, 2)).toEqual(["2025-12-31", "2025-12-30"]);
  });
});
