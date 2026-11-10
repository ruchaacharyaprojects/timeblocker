import { describe, it, expect } from "vitest";
import { weekBounds, freeWindows, place } from "./engine.js";
import type { Item, Constraints, FreeWindow } from "./types.js";
import { torontoDateKey, torontoWeekday, torontoMinutesOfDay } from "./timezone.js";
import { tor } from "./testkit.js";

const WEEK = weekBounds(tor(2025, 1, 15, 12, 0));
const NO_HOLIDAYS: Constraints = { holidays: [] };

function item(
  id: string,
  priority: number,
  durationMin: number,
  category: Item["category"] = "misc",
): Item {
  return { id, text: id, priority, durationMin, category };
}

describe("R2.1 priority-first placement", () => {
  it("places the highest-priority item into the earliest slot", () => {
    const windows = freeWindows(WEEK, [], NO_HOLIDAYS);
    const items = [item("low", 3, 60), item("high", 1, 60), item("mid", 2, 60)];
    const { placed } = place(items, windows, "earliest-fit");
    // Sort placed by start to find the earliest.
    const byStart = [...placed].sort(
      (a, b) => new Date(a.slot.start).getTime() - new Date(b.slot.start).getTime(),
    );
    expect(byStart[0].item.id).toBe("high");
  });
});

describe("R2.2 earliest-fit mode", () => {
  it("packs items into the earliest available windows", () => {
    const windows = freeWindows(WEEK, [], NO_HOLIDAYS);
    const items = [item("a", 1, 60), item("b", 1, 60)];
    const { placed, unplaced } = place(items, windows, "earliest-fit");
    expect(unplaced).toHaveLength(0);
    expect(placed).toHaveLength(2);
    // The first free window is Sunday 10:00. Both should land on Sunday
    // (earliest fit packs one day before moving on).
    const firstDay = torontoDateKey(new Date(placed[0].slot.start));
    const secondDay = torontoDateKey(new Date(placed[1].slot.start));
    expect(firstDay).toBe(secondDay);
    expect(firstDay).toBe("2025-01-12");
  });
});

describe("R2.2 spread mode", () => {
  it("distributes items across distinct days before reusing a day", () => {
    const windows = freeWindows(WEEK, [], NO_HOLIDAYS);
    const items = [item("a", 1, 60), item("b", 1, 60), item("c", 1, 60)];
    const { placed } = place(items, windows, "spread");
    const days = new Set(placed.map((p) => torontoDateKey(new Date(p.slot.start))));
    expect(days.size).toBe(3);
  });
});

describe("R3.9 at most one workout per day", () => {
  it("places two workouts on different days", () => {
    const windows = freeWindows(WEEK, [], NO_HOLIDAYS);
    const items = [item("w1", 1, 60, "fitness"), item("w2", 1, 60, "fitness")];
    const { placed, unplaced } = place(items, windows, "earliest-fit");
    expect(unplaced).toHaveLength(0);
    const days = placed.map((p) => torontoDateKey(new Date(p.slot.start)));
    expect(new Set(days).size).toBe(2);
  });

  it("allows multiple non-fitness items on the same day", () => {
    const windows = freeWindows(WEEK, [], NO_HOLIDAYS);
    const items = [item("a", 1, 60, "misc"), item("b", 1, 60, "misc")];
    const { placed } = place(items, windows, "earliest-fit");
    const days = placed.map((p) => torontoDateKey(new Date(p.slot.start)));
    expect(new Set(days).size).toBe(1);
  });
});

describe("R3.12 Friday night: no heavy work", () => {
  it("does not place a work block on Friday night (>= 17:00)", () => {
    // Restrict free windows to Friday evening only, forcing the engine to
    // choose Friday night or nothing.
    const fridayEvening: FreeWindow[] = [
      { start: tor(2025, 1, 17, 19, 0), end: tor(2025, 1, 17, 21, 0) },
    ];
    const items = [item("deepwork", 1, 60, "work")];
    const { placed, unplaced } = place(items, fridayEvening, "earliest-fit");
    expect(placed).toHaveLength(0);
    expect(unplaced.map((i) => i.id)).toContain("deepwork");
  });

  it("allows a self-care block on Friday night", () => {
    const fridayEvening: FreeWindow[] = [
      { start: tor(2025, 1, 17, 19, 0), end: tor(2025, 1, 17, 21, 0) },
    ];
    const items = [item("bath", 1, 60, "self-care")];
    const { placed, unplaced } = place(items, fridayEvening, "earliest-fit");
    expect(unplaced).toHaveLength(0);
    expect(placed).toHaveLength(1);
    expect(torontoWeekday(new Date(placed[0].slot.start))).toBe(5);
    expect(torontoMinutesOfDay(new Date(placed[0].slot.start))).toBeGreaterThanOrEqual(17 * 60);
  });

  it("allows work earlier on Friday (before 17:00)", () => {
    const fridayMorning: FreeWindow[] = [
      { start: tor(2025, 1, 17, 7, 10), end: tor(2025, 1, 17, 8, 0) },
    ];
    const items = [item("deepwork", 1, 45, "work")];
    const { placed, unplaced } = place(items, fridayMorning, "earliest-fit");
    expect(unplaced).toHaveLength(0);
    expect(placed).toHaveLength(1);
  });
});

describe("R2.3 nothing-fits: unplaced, never forced", () => {
  it("returns an item as unplaced when it fits nowhere", () => {
    // A single tiny window; the item is far too long.
    const tiny: FreeWindow[] = [
      { start: tor(2025, 1, 15, 19, 0), end: tor(2025, 1, 15, 19, 30) },
    ];
    const items = [item("big", 1, 180, "misc")];
    const { placed, unplaced } = place(items, tiny, "earliest-fit");
    expect(placed).toHaveLength(0);
    expect(unplaced.map((i) => i.id)).toEqual(["big"]);
  });

  it("places what fits and reports the rest as unplaced", () => {
    const windows: FreeWindow[] = [
      { start: tor(2025, 1, 15, 19, 0), end: tor(2025, 1, 15, 20, 0) },
    ];
    const items = [item("fits", 1, 60, "misc"), item("nope", 2, 60, "misc")];
    const { placed, unplaced } = place(items, windows, "earliest-fit");
    expect(placed.map((p) => p.item.id)).toEqual(["fits"]);
    expect(unplaced.map((i) => i.id)).toEqual(["nope"]);
  });

  it("is pure: does not mutate the input items or windows", () => {
    const windows: FreeWindow[] = [
      { start: tor(2025, 1, 15, 19, 0), end: tor(2025, 1, 15, 20, 0) },
    ];
    const items = [item("a", 1, 60, "misc")];
    const windowsCopy = JSON.parse(JSON.stringify(windows));
    const itemsCopy = JSON.parse(JSON.stringify(items));
    place(items, windows, "earliest-fit");
    expect(windows).toEqual(windowsCopy);
    expect(items).toEqual(itemsCopy);
  });
});

describe("R20.5 group: series prefers different days (soft)", () => {
  const g = (id: string, group?: string, category: Item["category"] = "misc"): Item => ({
    ...item(id, 1, 60, category),
    ...(group === undefined ? {} : { group }),
  });
  const dayOf = (p: { slot: { start: string } }) => torontoDateKey(new Date(p.slot.start));

  for (const mode of ["earliest-fit", "spread"] as const) {
    it(`puts three same-group items on 3 different days (${mode})`, () => {
      const windows = freeWindows(WEEK, [], NO_HOLIDAYS);
      const { placed, unplaced } = place([g("a", "s"), g("b", "s"), g("c", "s")], windows, mode);
      expect(unplaced).toHaveLength(0);
      expect(new Set(placed.map(dayOf)).size).toBe(3);
    });

    it(`falls back to the same day when only one day has room (${mode})`, () => {
      const all = freeWindows(WEEK, [], NO_HOLIDAYS);
      const monday = torontoDateKey(new Date(all[1]!.start));
      const windows = all.filter((w) => torontoDateKey(new Date(w.start)) === monday);
      const { placed, unplaced } = place([g("a", "s"), g("b", "s"), g("c", "s")], windows, mode);
      expect(unplaced).toHaveLength(0);
      expect(new Set(placed.map(dayOf))).toEqual(new Set([monday]));
    });

    it(`ungrouped output is identical with or without the group field absent (${mode})`, () => {
      const windows = freeWindows(WEEK, [], NO_HOLIDAYS);
      const items = [item("a", 1, 60), item("b", 2, 45), item("c", 1, 30, "fitness"), item("d", 3, 90)];
      const base = place(items, windows, mode);
      const withUndefined = place(
        items.map((i) => ({ ...i, group: undefined })),
        windows,
        mode,
      );
      expect(withUndefined.placed.map((p) => p.slot)).toEqual(base.placed.map((p) => p.slot));
      expect(withUndefined.unplaced.length).toBe(base.unplaced.length);
    });
  }

  it("keeps different groups independent (they may share a day)", () => {
    const windows = freeWindows(WEEK, [], NO_HOLIDAYS);
    const { placed } = place(
      [g("a1", "A"), g("a2", "A"), g("b1", "B"), g("b2", "B")],
      windows,
      "earliest-fit",
    );
    const byGroup = (grp: string) =>
      placed.filter((p) => p.item.group === grp).map(dayOf);
    expect(new Set(byGroup("A")).size).toBe(2);
    expect(new Set(byGroup("B")).size).toBe(2);
  });

  it("does not break one workout per day for grouped fitness items", () => {
    const windows = freeWindows(WEEK, [], NO_HOLIDAYS);
    const { placed } = place(
      [g("w1", "s", "fitness"), g("w2", "s", "fitness"), g("w3", "s", "fitness")],
      windows,
      "earliest-fit",
    );
    expect(new Set(placed.map(dayOf)).size).toBe(placed.length);
  });
});
