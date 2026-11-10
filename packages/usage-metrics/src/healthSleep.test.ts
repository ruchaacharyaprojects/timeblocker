import { describe, expect, it } from "vitest";
import { healthReadWindow, healthSleepScore, selectNightSession } from "./index.js";

const HOUR = 3_600_000;
const iso = (s: string) => Date.parse(s);
const sess = (start: string, end: string, asleepMin: number) => ({
  startMs: iso(start),
  endMs: iso(end),
  asleepMin,
});

describe("healthSleepScore", () => {
  it("is 100 for 8 h asleep and no phone use", () => {
    expect(healthSleepScore({ asleepMin: 480, phoneMin: 0 })).toBe(100);
  });
  it("caps asleep time at 8 h", () => {
    expect(healthSleepScore({ asleepMin: 700, phoneMin: 0 })).toBe(100);
  });
  it("scales with asleep time", () => {
    expect(healthSleepScore({ asleepMin: 360, phoneMin: 0 })).toBe(75);
    expect(healthSleepScore({ asleepMin: 240, phoneMin: 0 })).toBe(50);
  });
  it("subtracts 1.5 points per phone minute (rounded)", () => {
    expect(healthSleepScore({ asleepMin: 480, phoneMin: 10 })).toBe(85);
    expect(healthSleepScore({ asleepMin: 480, phoneMin: 3 })).toBe(100 - 5); // round(4.5)=5
  });
  it("clamps to 0..100 and tolerates bad input", () => {
    expect(healthSleepScore({ asleepMin: 100, phoneMin: 500 })).toBe(0);
    expect(healthSleepScore({ asleepMin: NaN, phoneMin: NaN })).toBe(0);
    expect(healthSleepScore({ asleepMin: 480, phoneMin: -5 })).toBe(100);
  });
});

describe("selectNightSession", () => {
  const KEY = "2025-01-14"; // EST: 18:00 = 23:00Z, next 04:00 = 09:00Z
  it("picks the longest asleep session in range", () => {
    const a = sess("2025-01-15T03:30:00Z", "2025-01-15T09:30:00Z", 330); // 22:30 -> 04:30 local
    const b = sess("2025-01-15T05:00:00Z", "2025-01-15T13:00:00Z", 450);
    expect(selectNightSession(KEY, [a, b])).toBe(b);
  });
  it("rejects sessions under 3 hours", () => {
    expect(selectNightSession(KEY, [sess("2025-01-15T03:00:00Z", "2025-01-15T05:59:00Z", 170)])).toBeUndefined();
    const ok = sess("2025-01-15T03:00:00Z", "2025-01-15T06:00:00Z", 170);
    expect(selectNightSession(KEY, [ok])).toBe(ok);
  });
  it("applies the 18:00 and 04:00 start bounds (inclusive)", () => {
    const before = sess("2025-01-14T22:59:00Z", "2025-01-15T08:00:00Z", 500); // 17:59
    const atStart = sess("2025-01-14T23:00:00Z", "2025-01-15T08:00:00Z", 400); // 18:00
    expect(selectNightSession(KEY, [before])).toBeUndefined();
    expect(selectNightSession(KEY, [atStart])).toBe(atStart);
    const late = sess("2025-01-15T09:01:00Z", "2025-01-15T17:00:00Z", 450); // 04:01
    const atEnd = sess("2025-01-15T09:00:00Z", "2025-01-15T17:00:00Z", 450); // 04:00
    expect(selectNightSession(KEY, [late])).toBeUndefined();
    expect(selectNightSession(KEY, [atEnd])).toBe(atEnd);
  });
  it("returns undefined for no sessions", () => {
    expect(selectNightSession(KEY, [])).toBeUndefined();
  });
  it("is DST-safe on the spring-forward night (EDT after 02:00)", () => {
    // Night of 2025-03-08: 18:00 EST = 23:00Z; next day 04:00 EDT = 08:00Z.
    const k = "2025-03-08";
    const inRange = sess("2025-03-09T08:00:00Z", "2025-03-09T14:00:00Z", 340);
    const out = sess("2025-03-09T08:01:00Z", "2025-03-09T14:00:00Z", 340);
    expect(selectNightSession(k, [inRange])).toBe(inRange);
    expect(selectNightSession(k, [out])).toBeUndefined();
  });
  it("is DST-safe on the fall-back night (EST after 02:00)", () => {
    // Night of 2025-11-01: 18:00 EDT = 22:00Z; next day 04:00 EST = 09:00Z.
    const k = "2025-11-01";
    const inRange = sess("2025-11-02T09:00:00Z", "2025-11-02T15:00:00Z", 340);
    const out = sess("2025-11-02T09:01:00Z", "2025-11-02T15:00:00Z", 340);
    expect(selectNightSession(k, [inRange])).toBe(inRange);
    expect(selectNightSession(k, [out])).toBeUndefined();
  });
  it("throws RangeError on a bad key", () => {
    expect(() => selectNightSession("nope", [])).toThrow(RangeError);
  });
});

describe("healthReadWindow", () => {
  it("covers 18:00 the date to 12:00 the next date (Toronto)", () => {
    const w = healthReadWindow("2025-01-14");
    expect(new Date(w.startMs).toISOString()).toBe("2025-01-14T23:00:00.000Z");
    expect(new Date(w.endMs).toISOString()).toBe("2025-01-15T17:00:00.000Z");
  });
  it("is 18 h on a normal night and 17 h across spring-forward", () => {
    const n = healthReadWindow("2025-01-14");
    expect((n.endMs - n.startMs) / HOUR).toBe(18);
    const d = healthReadWindow("2025-03-08");
    expect((d.endMs - d.startMs) / HOUR).toBe(17);
  });
});
