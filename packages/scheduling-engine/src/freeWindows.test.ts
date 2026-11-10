import { describe, it, expect } from "vitest";
import { weekBounds, freeWindows } from "./engine.js";
import type { Constraints } from "./types.js";
import { tor, busy, windowsOverlap, windowsCover } from "./testkit.js";

// Reference week: Sunday 2025-01-12 .. Saturday 2025-01-18 (winter / EST).
// Day map: 12 Sun, 13 Mon, 14 Tue, 15 Wed, 16 Thu, 17 Fri, 18 Sat.
const WEEK = weekBounds(tor(2025, 1, 15, 12, 0));
const NO_HOLIDAYS: Constraints = { holidays: [] };

function free(busyEvents = [] as ReturnType<typeof busy>[], c = NO_HOLIDAYS) {
  return freeWindows(WEEK, busyEvents, c);
}

describe("R3.1 work window (Mon-Fri 08:30-16:30)", () => {
  it("never offers free time inside the weekday work window", () => {
    const windows = free();
    // Monday 13th, inside 08:30-16:30.
    expect(windowsOverlap(windows, tor(2025, 1, 13, 10, 0), tor(2025, 1, 13, 11, 0))).toBe(false);
    // Wednesday 15th.
    expect(windowsOverlap(windows, tor(2025, 1, 15, 13, 0), tor(2025, 1, 15, 14, 0))).toBe(false);
  });

  it("offers time before work starts on a remote day (Mon)", () => {
    const windows = free();
    // Monday is remote (no commute): 07:10-08:30 is free.
    expect(windowsCover(windows, tor(2025, 1, 13, 7, 10), tor(2025, 1, 13, 8, 30))).toBe(true);
  });
});

describe("R3.2 Canadian statutory holiday is a day off (no work window)", () => {
  it("frees the work window on a holiday", () => {
    const holidayWeek = weekBounds(tor(2025, 1, 15, 12, 0));
    const windows = freeWindows(holidayWeek, [], { holidays: ["2025-01-13"] });
    // Monday 13th now a holiday: 08:30-16:30 becomes schedulable (weekday
    // window 06:50-22:00 minus dinner/wind-down only).
    expect(windowsCover(windows, tor(2025, 1, 13, 10, 0), tor(2025, 1, 13, 11, 0))).toBe(true);
  });

  it("holidays are overridable via constraints (not hardcoded)", () => {
    // Without declaring it a holiday, the same Monday keeps its work window.
    const windows = free();
    expect(windowsOverlap(windows, tor(2025, 1, 13, 10, 0), tor(2025, 1, 13, 11, 0))).toBe(false);
  });
});

describe("R3.3 commute reserved on Tue/Thu/Fri only", () => {
  it("blocks commute 08:00-08:30 and 16:30-17:00 on Tuesday", () => {
    const windows = free();
    expect(windowsOverlap(windows, tor(2025, 1, 14, 8, 0), tor(2025, 1, 14, 8, 30))).toBe(false);
    expect(windowsOverlap(windows, tor(2025, 1, 14, 16, 30), tor(2025, 1, 14, 17, 0))).toBe(false);
  });

  it("blocks commute on Thursday and Friday", () => {
    const windows = free();
    expect(windowsOverlap(windows, tor(2025, 1, 16, 16, 30), tor(2025, 1, 16, 17, 0))).toBe(false);
    expect(windowsOverlap(windows, tor(2025, 1, 17, 8, 0), tor(2025, 1, 17, 8, 30))).toBe(false);
  });

  it("leaves Mon/Wed free right after work (remote, no commute)", () => {
    const windows = free();
    // Monday 16:30-17:00 is free (remote).
    expect(windowsCover(windows, tor(2025, 1, 13, 16, 30), tor(2025, 1, 13, 17, 0))).toBe(true);
    // Wednesday 16:30-17:00 is free (remote).
    expect(windowsCover(windows, tor(2025, 1, 15, 16, 30), tor(2025, 1, 15, 17, 0))).toBe(true);
  });
});

describe("R3.4 sleep protected 22:00-06:30 daily", () => {
  it("never offers time during the overnight sleep window", () => {
    const windows = free();
    // Late Wednesday night.
    expect(windowsOverlap(windows, tor(2025, 1, 15, 22, 30), tor(2025, 1, 15, 23, 30))).toBe(false);
    // Early Thursday morning before wake.
    expect(windowsOverlap(windows, tor(2025, 1, 16, 5, 0), tor(2025, 1, 16, 6, 0))).toBe(false);
  });
});

describe("R3.5 wake-up protected 06:30-06:50; weekday blocks start >= 06:50", () => {
  it("offers no free time before 06:50 on a weekday", () => {
    const windows = free();
    expect(windowsOverlap(windows, tor(2025, 1, 15, 6, 30), tor(2025, 1, 15, 6, 50))).toBe(false);
    expect(windowsOverlap(windows, tor(2025, 1, 15, 6, 0), tor(2025, 1, 15, 6, 50))).toBe(false);
  });
});

describe("R3.6 dinner protected 18:00-19:00 daily", () => {
  it("never offers time during dinner on a weekday", () => {
    const windows = free();
    expect(windowsOverlap(windows, tor(2025, 1, 15, 18, 0), tor(2025, 1, 15, 19, 0))).toBe(false);
  });

  it("never offers time during dinner on a weekend", () => {
    const windows = free();
    expect(windowsOverlap(windows, tor(2025, 1, 12, 18, 0), tor(2025, 1, 12, 19, 0))).toBe(false);
  });
});

describe("R3.7 scheduling windows (weekday 06:50-22:00, weekend 10:00-21:00)", () => {
  it("does not offer weekday time before 06:50 or after 22:00", () => {
    const windows = free();
    expect(windowsOverlap(windows, tor(2025, 1, 15, 22, 0), tor(2025, 1, 15, 22, 30))).toBe(false);
  });

  it("does not offer weekend time before 10:00 or after 21:00", () => {
    const windows = free();
    // Saturday 09:00-10:00 is outside the weekend window.
    expect(windowsOverlap(windows, tor(2025, 1, 18, 9, 0), tor(2025, 1, 18, 10, 0))).toBe(false);
    // Saturday 21:00-21:30 is outside the weekend window.
    expect(windowsOverlap(windows, tor(2025, 1, 18, 21, 0), tor(2025, 1, 18, 21, 30))).toBe(false);
  });

  it("offers weekend time inside 10:00-21:00 (minus dinner)", () => {
    const windows = free();
    // Sunday 10:00-18:00 should be free (morning walk is before 10:00).
    expect(windowsCover(windows, tor(2025, 1, 12, 10, 0), tor(2025, 1, 12, 18, 0))).toBe(true);
  });
});

describe("R3.8 gaps shorter than 15 minutes are unusable", () => {
  it("drops a sub-15-minute gap left between two busy events", () => {
    // Wednesday: fill the morning free block (07:10-08:30) except a 10-min gap.
    const events = [
      busy(2025, 1, 15, 7, 10, 8, 20), // leaves 08:20-08:30 = 10 min
    ];
    const windows = freeWindows(WEEK, events, NO_HOLIDAYS);
    expect(windowsOverlap(windows, tor(2025, 1, 15, 8, 20), tor(2025, 1, 15, 8, 30))).toBe(false);
  });

  it("keeps a gap of exactly 15 minutes", () => {
    const events = [
      busy(2025, 1, 15, 7, 10, 8, 15), // leaves 08:15-08:30 = 15 min
    ];
    const windows = freeWindows(WEEK, events, NO_HOLIDAYS);
    expect(windowsCover(windows, tor(2025, 1, 15, 8, 15), tor(2025, 1, 15, 8, 30))).toBe(true);
  });
});

describe("R3.10 morning routine (~20-min walk around 06:50)", () => {
  it("reserves 06:50-07:10 on a weekday", () => {
    const windows = free();
    expect(windowsOverlap(windows, tor(2025, 1, 15, 6, 50), tor(2025, 1, 15, 7, 10))).toBe(false);
  });
});

describe("R3.11 wind-down >= 30 min screen-free before bed", () => {
  it("reserves 21:30-22:00 on a weekday", () => {
    const windows = free();
    expect(windowsOverlap(windows, tor(2025, 1, 15, 21, 30), tor(2025, 1, 15, 22, 0))).toBe(false);
  });

  it("offers time right up to the wind-down start", () => {
    const windows = free();
    // Wednesday 19:00-21:30 (after dinner, before wind-down) is free.
    expect(windowsCover(windows, tor(2025, 1, 15, 19, 0), tor(2025, 1, 15, 21, 30))).toBe(true);
  });
});

describe("real calendar events are subtracted", () => {
  it("removes a real meeting from free time", () => {
    const events = [busy(2025, 1, 15, 19, 30, 20, 30, { withOthers: true })];
    const windows = freeWindows(WEEK, events, NO_HOLIDAYS);
    expect(windowsOverlap(windows, tor(2025, 1, 15, 19, 30), tor(2025, 1, 15, 20, 30))).toBe(false);
    // Time around it remains free.
    expect(windowsOverlap(windows, tor(2025, 1, 15, 19, 0), tor(2025, 1, 15, 19, 30))).toBe(true);
  });
});

describe("now cutoff", () => {
  it("drops free time before `now`", () => {
    // now = Wednesday 20:00; earlier Wednesday evening time is gone.
    const windows = freeWindows(WEEK, [], NO_HOLIDAYS, tor(2025, 1, 15, 20, 0));
    expect(windowsOverlap(windows, tor(2025, 1, 15, 19, 0), tor(2025, 1, 15, 19, 30))).toBe(false);
    // Later in the week still available.
    expect(windowsOverlap(windows, tor(2025, 1, 16, 19, 0), tor(2025, 1, 16, 19, 30))).toBe(true);
  });
});
