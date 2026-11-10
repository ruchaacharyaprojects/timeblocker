import { describe, it, expect } from "vitest";
import { weekBounds, freeWindows, place } from "./engine.js";
import type { Item, Constraints, FreeWindow } from "./types.js";
import { torontoDateKey } from "./timezone.js";
import { tor, busy } from "./testkit.js";

// Week of Sun 2025-01-12 .. Sat 2025-01-18 (see free windows below).
//   Sun/Sat: 10-18, 19-21     Mon/Wed: 07:10-08:30, 16:30-18, 19-21:30
//   Tue/Thu/Fri: 07:10-08, 17-18, 19-21:30
const WEEK = weekBounds(tor(2025, 1, 15, 12, 0));
const NONE: Constraints = { holidays: [] };
const ms = (iso: string): number => new Date(iso).getTime();

function item(id: string, extra: Partial<Item> = {}): Item {
  return { id, text: id, priority: 3, durationMin: 60, category: "misc", ...extra };
}
const wins = (): FreeWindow[] => freeWindows(WEEK, [], NONE);

describe("R28.2 fixed-start items", () => {
  it("places a fixed item at exactly its start", () => {
    const start = ms(tor(2025, 1, 14, 17, 0));
    const { placed, unplaced } = place(
      [item("dentist", { fixedStartMs: start, durationMin: 45 })],
      wins(),
      "earliest-fit",
    );
    expect(unplaced).toEqual([]);
    expect(placed[0]!.slot).toEqual({
      start: tor(2025, 1, 14, 17, 0),
      end: tor(2025, 1, 14, 17, 45),
    });
  });

  it("is placed before higher-priority flexible items, which work around it", () => {
    const start = ms(tor(2025, 1, 12, 10, 0));
    const { placed } = place(
      [item("flex", { priority: 1 }), item("fixed", { priority: 5, fixedStartMs: start })],
      wins(),
      "earliest-fit",
    );
    const fixed = placed.find((p) => p.item.id === "fixed")!;
    const flex = placed.find((p) => p.item.id === "flex")!;
    expect(fixed.slot.start).toBe(tor(2025, 1, 12, 10, 0));
    expect(flex.slot.start).toBe(tor(2025, 1, 12, 11, 0));
  });

  it("clashes with a busy event: unplaced 'clash', no partial overlap", () => {
    const w = freeWindows(WEEK, [busy(2025, 1, 12, 10, 30, 11, 30)], NONE);
    const start = ms(tor(2025, 1, 12, 10, 0));
    const { placed, unplaced } = place([item("f", { fixedStartMs: start })], w, "earliest-fit");
    expect(placed).toEqual([]);
    expect(unplaced).toHaveLength(1);
    expect(unplaced[0]!.reason).toBe("clash");
    expect(unplaced[0]!.id).toBe("f");
  });

  it("clashes with another fixed item (first by start wins)", () => {
    const a = item("a", { fixedStartMs: ms(tor(2025, 1, 12, 10, 0)) });
    const b = item("b", { fixedStartMs: ms(tor(2025, 1, 12, 10, 30)) });
    const { placed, unplaced } = place([b, a], wins(), "earliest-fit");
    expect(placed.map((p) => p.item.id)).toEqual(["a"]);
    expect(unplaced.map((u) => [u.id, u.reason])).toEqual([["b", "clash"]]);
  });

  it("clashes when the slot is in protected time (sleep) or straddles a window edge", () => {
    const sleep = item("sleep", { fixedStartMs: ms(tor(2025, 1, 13, 3, 0)) });
    const edge = item("edge", { fixedStartMs: ms(tor(2025, 1, 13, 17, 30)) }); // window ends 18:00
    const { placed, unplaced } = place([sleep, edge], wins(), "earliest-fit");
    expect(placed).toEqual([]);
    expect(unplaced.map((u) => u.reason)).toEqual(["clash", "clash"]);
  });

  it("applies the one-workout-per-day rule", () => {
    const a = item("w1", { category: "fitness", fixedStartMs: ms(tor(2025, 1, 12, 10, 0)) });
    const b = item("w2", { category: "fitness", fixedStartMs: ms(tor(2025, 1, 12, 14, 0)) });
    const { placed, unplaced } = place([a, b], wins(), "earliest-fit");
    expect(placed.map((p) => p.item.id)).toEqual(["w1"]);
    expect(unplaced[0]).toMatchObject({ id: "w2", reason: "clash" });
  });

  it("applies the Friday-night heavy-work rule", () => {
    const fri = ms(tor(2025, 1, 17, 19, 0));
    const work = item("work", { category: "work", fixedStartMs: fri });
    const care = item("care", { category: "self-care", fixedStartMs: fri });
    const { placed, unplaced } = place([work, care], wins(), "earliest-fit");
    expect(placed.map((p) => p.item.id)).toEqual(["care"]);
    expect(unplaced[0]).toMatchObject({ id: "work", reason: "clash" });
  });
});

describe("R28.5 deadline items", () => {
  it("sorts ahead of higher-priority non-deadline items, earliest deadline first", () => {
    const w: FreeWindow[] = [{ start: tor(2025, 1, 12, 10, 0), end: tor(2025, 1, 12, 13, 0) }];
    const late = item("late", { priority: 2, latestEndMs: ms(tor(2025, 1, 16, 17, 0)) });
    const soon = item("soon", { priority: 4, latestEndMs: ms(tor(2025, 1, 14, 17, 0)) });
    const top = item("top", { priority: 1 });
    const { placed } = place([top, late, soon], w, "earliest-fit");
    expect(placed.map((p) => p.item.id)).toEqual(["soon", "late", "top"]);
    expect(placed[0]!.slot.start).toBe(tor(2025, 1, 12, 10, 0));
  });

  it("only uses time that ends by the deadline", () => {
    const due = ms(tor(2025, 1, 13, 8, 0)); // Monday 08:00
    const w = freeWindows(WEEK, [busy(2025, 1, 12, 9, 0, 22, 0)], NONE); // Sunday taken
    const { placed } = place([item("r", { latestEndMs: due, durationMin: 30 })], w, "earliest-fit");
    expect(placed[0]!.slot).toEqual({ start: tor(2025, 1, 13, 7, 10), end: tor(2025, 1, 13, 7, 40) });
    const tight = place([item("t", { latestEndMs: ms(tor(2025, 1, 13, 7, 30)), durationMin: 30 })], w, "earliest-fit");
    expect(tight.unplaced[0]!.reason).toBe("no-time-before-deadline");
  });

  it("earliest-fit applies even in spread mode", () => {
    const due = ms(tor(2025, 1, 18, 17, 0));
    const { placed } = place(
      [item("a", { latestEndMs: due }), item("b", { latestEndMs: due })],
      wins(),
      "spread",
    );
    expect(placed.map((p) => p.slot.start)).toEqual([tor(2025, 1, 12, 10, 0), tor(2025, 1, 12, 11, 0)]);
  });

  it("is unplaced with 'no-time-before-deadline' when nothing ends by the deadline", () => {
    const due = ms(tor(2025, 1, 12, 9, 0)); // before the first free window
    const { placed, unplaced } = place([item("r", { latestEndMs: due })], wins(), "earliest-fit");
    expect(placed).toEqual([]);
    expect(unplaced[0]).toMatchObject({ id: "r", reason: "no-time-before-deadline" });
  });

  it("clips a window that straddles the deadline", () => {
    const due = ms(tor(2025, 1, 12, 10, 30));
    const ok = place([item("a", { latestEndMs: due, durationMin: 30 })], wins(), "earliest-fit");
    expect(ok.placed[0]!.slot.end).toBe(tor(2025, 1, 12, 10, 30));
    const no = place([item("b", { latestEndMs: due, durationMin: 45 })], wins(), "earliest-fit");
    expect(no.unplaced[0]!.reason).toBe("no-time-before-deadline");
  });
});

describe("R28.3 earliest / latest clipping (single-day items)", () => {
  const dayStart = ms(tor(2025, 1, 14, 0, 0));
  const dayEnd = ms(tor(2025, 1, 15, 0, 0));

  it("places an on-day item only on that day", () => {
    const { placed } = place(
      [item("d", { earliestMs: dayStart, latestEndMs: dayEnd })],
      wins(),
      "earliest-fit",
    );
    expect(torontoDateKey(new Date(placed[0]!.slot.start))).toBe("2025-01-14");
    expect(placed[0]!.slot.start).toBe(tor(2025, 1, 14, 17, 0)); // 60 min does not fit 07:10-08:00
  });

  it("earliestMs clips into the middle of a window", () => {
    const { placed } = place(
      [item("e", { earliestMs: ms(tor(2025, 1, 12, 12, 20)) })],
      wins(),
      "earliest-fit",
    );
    expect(placed[0]!.slot.start).toBe(tor(2025, 1, 12, 12, 20));
  });

  it("scored placement respects the bounds", () => {
    const { placed } = place(
      [item("s", { earliestMs: dayStart, latestEndMs: dayEnd })],
      wins(),
      "earliest-fit",
      { score: (_i, startMs) => (startMs >= ms(tor(2025, 1, 14, 19, 0)) ? 1 : 0.1) },
    );
    expect(placed[0]!.slot.start).toBe(tor(2025, 1, 14, 19, 0));
    const none = place(
      [item("n", { earliestMs: ms(tor(2025, 1, 14, 22, 0)), latestEndMs: dayEnd })],
      wins(),
      "earliest-fit",
      { score: () => 1 },
    );
    expect(none.unplaced[0]).toMatchObject({ id: "n", reason: "no-time-before-deadline" });
  });

  it("an earliest-only item that fits nowhere gets reason 'no-fit'", () => {
    const { unplaced } = place(
      [item("x", { earliestMs: ms(tor(2025, 1, 19, 0, 0)) })],
      wins(),
      "earliest-fit",
    );
    expect(unplaced[0]).toMatchObject({ id: "x", reason: "no-fit" });
  });
});

describe("regression: unchanged without the new fields", () => {
  it("returns plain unplaced items untouched (no reason key)", () => {
    const tiny: FreeWindow[] = [{ start: tor(2025, 1, 12, 10, 0), end: tor(2025, 1, 12, 10, 30) }];
    const big = item("big", { durationMin: 120 });
    const { placed, unplaced } = place([big], tiny, "earliest-fit");
    expect(placed).toEqual([]);
    expect(unplaced).toEqual([big]);
    expect("reason" in unplaced[0]!).toBe(false);
  });

  it("priority order, spread and group behaviour are as before", () => {
    const items = [
      item("a", { priority: 2, group: "g" }),
      item("b", { priority: 1, group: "g" }),
      item("c", { priority: 3 }),
    ];
    const r = place(items, wins(), "earliest-fit");
    expect(r.placed.map((p) => p.item.id)).toEqual(["b", "a", "c"]);
    const days = new Set(
      r.placed.filter((p) => p.item.group === "g").map((p) => torontoDateKey(new Date(p.slot.start))),
    );
    expect(days.size).toBe(2); // group prefers different days
  });
});

// Feature: timeblocker, Property 35: Placed items never violate fixed, earliest, or latest bounds
describe("Property 35: placed items never violate fixed, earliest, or latest bounds", () => {
  // Deterministic PRNG so the property is reproducible without a new dependency.
  function rng(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  const CATS: Item["category"][] = ["fitness", "self-care", "work", "self-development", "misc"];

  it("holds across 300 random scenarios (both modes, scored and unscored)", () => {
    const sunday = ms(WEEK.sunday);
    const free = wins();
    for (let seed = 1; seed <= 300; seed++) {
      const r = rng(seed);
      const n = 1 + Math.floor(r() * 8);
      const items: Item[] = [];
      for (let i = 0; i < n; i++) {
        const it: Item = {
          id: `i${i}`,
          text: `i${i}`,
          durationMin: 15 + Math.floor(r() * 12) * 15,
          priority: 1 + Math.floor(r() * 5),
          category: CATS[Math.floor(r() * CATS.length)]!,
        };
        const kind = r();
        const at = sunday + Math.floor(r() * 7 * 24 * 4) * 15 * 60000;
        if (kind < 0.25) it.fixedStartMs = at;
        else if (kind < 0.5) it.latestEndMs = at;
        else if (kind < 0.7) it.earliestMs = at;
        else if (kind < 0.85) {
          it.earliestMs = at;
          it.latestEndMs = at + Math.floor(r() * 48) * 15 * 60000;
        }
        items.push(it);
      }
      const mode = r() < 0.5 ? "earliest-fit" : "spread";
      const opts = r() < 0.5 ? { score: (_i: Item, s: number) => (s / 60000) % 7 } : undefined;
      const res = place(items, free, mode, opts);

      expect(res.placed.length + res.unplaced.length).toBe(items.length);
      const spans: Array<[number, number]> = [];
      for (const p of res.placed) {
        const s = ms(p.slot.start);
        const e = ms(p.slot.end);
        const it = p.item;
        expect(e - s).toBe(it.durationMin * 60000);
        if (it.fixedStartMs !== undefined) expect(s).toBe(it.fixedStartMs);
        if (it.earliestMs !== undefined) expect(s).toBeGreaterThanOrEqual(it.earliestMs);
        if (it.latestEndMs !== undefined) expect(e).toBeLessThanOrEqual(it.latestEndMs);
        // Inside one original free window and never overlapping another placement.
        expect(free.some((w) => ms(w.start) <= s && e <= ms(w.end))).toBe(true);
        for (const [os, oe] of spans) expect(s < oe && os < e).toBe(false);
        spans.push([s, e]);
      }
      for (const u of res.unplaced) {
        if (u.fixedStartMs !== undefined) expect(u.reason).toBe("clash");
        else if (u.latestEndMs !== undefined) expect(u.reason).toBe("no-time-before-deadline");
      }
    }
  });
});
