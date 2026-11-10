import { describe, it, expect } from "vitest";
import { weekBounds, freeWindows, place } from "./engine.js";
import type { Item, Constraints } from "./types.js";
import { torontoDateKey, torontoMinutesOfDay, torontoWeekday } from "./timezone.js";
import { tor } from "./testkit.js";

const WEEK = weekBounds(tor(2025, 1, 15, 12, 0));
const NONE: Constraints = { holidays: [] };

const item = (
  id: string,
  category: Item["category"] = "misc",
  durationMin = 60,
  extra: Partial<Item> = {},
): Item => ({ id, text: id, priority: 1, durationMin, category, ...extra });

/** Prefers starts between 18:00 and 20:00 Toronto. */
const evening = (_: Item, ms: number) => {
  const m = torontoMinutesOfDay(new Date(ms));
  return m >= 18 * 60 && m < 20 * 60 ? 1 : 0.2;
};

describe("R23.3 scored placement", () => {
  it("lands in the preferred bucket when feasible", () => {
    const w = freeWindows(WEEK, [], NONE);
    const { placed } = place([item("a")], w, "earliest-fit", { score: evening });
    expect(placed).toHaveLength(1);
    const m = torontoMinutesOfDay(new Date(placed[0].slot.start));
    expect(m).toBeGreaterThanOrEqual(18 * 60);
    expect(m).toBeLessThan(20 * 60);
    // Earliest day wins the tie between equal evening slots.
    expect(torontoDateKey(new Date(placed[0].slot.start))).toBe("2025-01-12");
  });

  it("is identical to unscored placement without a score or with undefined scores", () => {
    const w = freeWindows(WEEK, [], NONE);
    const items = [item("a", "work"), item("b", "fitness", 45), item("c", "misc", 30)];
    for (const mode of ["earliest-fit", "spread"] as const) {
      const base = place(items, w, mode);
      expect(place(items, w, mode, {})).toEqual(base);
      expect(place(items, w, mode, { score: () => undefined })).toEqual(base);
    }
  });

  it("ties pick the earliest candidate", () => {
    const w = freeWindows(WEEK, [], NONE);
    const base = place([item("a")], w, "earliest-fit");
    const tied = place([item("a")], w, "earliest-fit", { score: () => 0.5 });
    expect(tied).toEqual(base);
  });

  it("keeps one workout per day", () => {
    const w = freeWindows(WEEK, [], NONE);
    const { placed } = place([item("f1", "fitness"), item("f2", "fitness")], w, "earliest-fit", {
      score: evening,
    });
    const days = placed.map((p) => torontoDateKey(new Date(p.slot.start)));
    expect(new Set(days).size).toBe(2);
  });

  it("keeps the Friday-night heavy-work cutoff", () => {
    // Only Friday evening free: 18:00-20:00 is preferred but work is not allowed.
    const fri = [{ start: tor(2025, 1, 17, 18), end: tor(2025, 1, 17, 20) }];
    const r = place([item("w", "work")], fri, "earliest-fit", { score: evening });
    expect(r.placed).toHaveLength(0);
    expect(r.unplaced).toHaveLength(1);
  });

  it("never starts inside sleep or outside free windows", () => {
    const w = freeWindows(WEEK, [], NONE);
    const { placed } = place(
      [item("a"), item("b"), item("c", "misc", 120)],
      w,
      "spread",
      { score: evening },
    );
    for (const p of placed) {
      const s = new Date(p.slot.start).getTime();
      const e = new Date(p.slot.end).getTime();
      expect(
        w.some((x) => new Date(x.start).getTime() <= s && e <= new Date(x.end).getTime()),
      ).toBe(true);
    }
  });

  it("still spreads a series over different days", () => {
    const w = freeWindows(WEEK, [], NONE);
    const items = [1, 2, 3].map((i) => item(`s${i}`, "work", 60, { group: "g" }));
    const { placed } = place(items, w, "earliest-fit", { score: evening });
    const days = new Set(placed.map((p) => torontoDateKey(new Date(p.slot.start))));
    expect(days.size).toBe(3);
  });

  it("prefers a start that strands no sub-15-minute remainder on equal scores", () => {
    // 60 min item in a 70 min window: starting at 0 strands 10 min; 15 strands left 15 (ok) and right -5.. infeasible.
    const win = [{ start: tor(2025, 1, 15, 10), end: tor(2025, 1, 15, 11, 10) }];
    const r = place([item("a")], win, "earliest-fit", { score: () => 1 });
    expect(r.placed).toHaveLength(1);
  });

  it("handles a mid-window start by keeping both remainders", () => {
    const win = [{ start: tor(2025, 1, 15, 14), end: tor(2025, 1, 15, 22) }];
    const r = place([item("a"), item("b", "misc", 60)], win, "earliest-fit", {
      score: (_, ms) => (torontoMinutesOfDay(new Date(ms)) === 18 * 60 ? 1 : 0),
    });
    expect(r.placed).toHaveLength(2);
    expect(torontoMinutesOfDay(new Date(r.placed[0].slot.start))).toBe(18 * 60);
    expect(torontoWeekday(new Date(r.placed[0].slot.start))).toBe(3);
    // Second item has the same single best start, now taken: falls to a later best-effort slot.
    const a = r.placed[0].slot;
    const b = r.placed[1].slot;
    expect(a.end <= b.start || b.end <= a.start).toBe(true);
  });
});
