import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  freeWindows,
  weekBounds,
  type BusyEvent,
  type Item,
  type PlanningMode,
} from "@timeblocker/scheduling-engine";
import { computePlan, type PlanningSettings } from "./plan.js";

const week = weekBounds("2025-01-06T12:00:00-05:00");
const NOW = "2025-01-05T00:00:00-05:00";
const DAY_MS = 24 * 3600 * 1000;
const sundayMs = new Date(week.sunday).getTime();

const settings = (planningMode: PlanningMode): PlanningSettings => ({ planningMode, holidays: [] });
const dayKey = (iso: string) => new Date(iso).toLocaleDateString("en-CA", { timeZone: "America/Toronto" });
const mk = (id: string, group?: string, durationMin = 30): Item => ({
  id,
  text: id,
  durationMin,
  priority: 2,
  category: "misc",
  ...(group === undefined ? {} : { group }),
});
const blockDays = (days: number[]): BusyEvent[] =>
  days.map((d) => ({
    start: new Date(sundayMs + d * DAY_MS).toISOString(),
    end: new Date(sundayMs + (d + 1) * DAY_MS).toISOString(),
  }));
const daysOf = (placed: { slot: { start: string } }[]) => placed.map((p) => dayKey(p.slot.start));

describe("computePlan with series groups (R20.5)", () => {
  for (const mode of ["earliest-fit", "spread"] as const) {
    it(`spreads a 3-item series over 3 days (${mode})`, () => {
      const items = [mk("g1", "s"), mk("g2", "s"), mk("g3", "s")];
      const r = computePlan({ week, items, busy: [], settings: settings(mode), now: NOW });
      expect(r.unplaced).toHaveLength(0);
      expect(new Set(daysOf(r.placed)).size).toBe(3);
      // group survives into the placed result
      expect(r.placed.every((p) => p.item.group === "s")).toBe(true);
    });

    it(`falls back to one day when only one day has room (${mode})`, () => {
      const items = [mk("g1", "s"), mk("g2", "s"), mk("g3", "s")];
      const busy = blockDays([0, 1, 2, 3, 4, 5]);
      const r = computePlan({ week, items, busy, settings: settings(mode), now: NOW });
      expect(r.unplaced).toHaveLength(0);
      expect(new Set(daysOf(r.placed)).size).toBe(1);
    });

    it(`ungrouped plans are identical with group undefined (${mode})`, () => {
      const items = [mk("a"), mk("b"), mk("c", undefined, 90)];
      const base = computePlan({ week, items, busy: [], settings: settings(mode), now: NOW });
      const same = computePlan({
        week,
        items: items.map((i) => ({ ...i, group: undefined })),
        busy: [],
        settings: settings(mode),
        now: NOW,
      });
      expect(same.placed.map((p) => p.slot)).toEqual(base.placed.map((p) => p.slot));
    });
  }

  it("mixed groups: each series spreads, ungrouped items still pack", () => {
    const items = [mk("a1", "A"), mk("a2", "A"), mk("b1", "B"), mk("b2", "B"), mk("x1"), mk("x2")];
    const r = computePlan({ week, items, busy: [], settings: settings("earliest-fit"), now: NOW });
    expect(r.unplaced).toHaveLength(0);
    for (const g of ["A", "B"]) {
      const d = daysOf(r.placed.filter((p) => p.item.group === g));
      expect(new Set(d).size).toBe(d.length);
    }
  });

  // Feature: timeblocker, Property 28: A series uses distinct days whenever enough days have room
  it("a series uses distinct days whenever enough days have room", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 2, max: 5 }),
        fc.uniqueArray(fc.integer({ min: 0, max: 6 }), { maxLength: 6 }),
        fc.constantFrom<PlanningMode>("earliest-fit", "spread"),
        fc.constantFrom(15, 30, 45, 60),
        (n, blocked, mode, dur) => {
          const busy = blockDays(blocked);
          const roomy = new Set(
            freeWindows(week, busy, { holidays: [] }, NOW)
              .filter((w) => new Date(w.end).getTime() - new Date(w.start).getTime() >= dur * 60000)
              .map((w) => dayKey(w.start)),
          );
          fc.pre(roomy.size >= n);
          const items = Array.from({ length: n }, (_, i) => mk(`s${i}`, "series", dur));
          const r = computePlan({ week, items, busy, settings: settings(mode), now: NOW });
          expect(r.unplaced).toHaveLength(0);
          expect(new Set(daysOf(r.placed)).size).toBe(n);
        },
      ),
      { numRuns: 150 },
    );
  });
});
