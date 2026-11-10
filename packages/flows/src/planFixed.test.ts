import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { weekBounds, type Item } from "@timeblocker/scheduling-engine";
import { computePlan } from "./plan.js";

const WEEK = weekBounds("2025-01-06T12:00:00-05:00");
const SUNDAY_MS = new Date(WEEK.sunday).getTime();
const SETTINGS = { planningMode: "earliest-fit" as const, holidays: [] };
const NOW = "2025-01-06T00:00:00-05:00";
const NOW_MS = new Date(NOW).getTime();
const HOUR = 3600000;

const base = (o: Partial<Item> & { id: string }): Item => ({
  text: o.id,
  durationMin: 60,
  priority: 2,
  category: "work",
  ...o,
});

describe("computePlan fixed / bounds (R28)", () => {
  it("marks a fixed item before now as 'past' and does not place it", () => {
    const r = computePlan({
      week: WEEK,
      items: [base({ id: "p", fixedStartMs: NOW_MS - HOUR })],
      busy: [],
      settings: SETTINGS,
      now: NOW,
    });
    expect(r.placed).toHaveLength(0);
    expect(r.unplaced).toHaveLength(1);
    expect(r.unplaced[0].reason).toBe("past");
    expect(r.alert?.items).toHaveLength(1);
  });

  it("places a future fixed item exactly and reports clashes", () => {
    const start = new Date("2025-01-06T19:00:00-05:00").getTime();
    const ok = computePlan({
      week: WEEK,
      items: [base({ id: "f", fixedStartMs: start })],
      busy: [],
      settings: SETTINGS,
      now: NOW,
    });
    expect(ok.placed[0].slot.start).toBe(new Date(start).toISOString());

    const clash = computePlan({
      week: WEEK,
      items: [base({ id: "f", fixedStartMs: start })],
      busy: [
        {
          start: new Date(start + 30 * 60000).toISOString(),
          end: new Date(start + 2 * HOUR).toISOString(),
        },
      ],
      settings: SETTINGS,
      now: NOW,
    });
    expect(clash.placed).toHaveLength(0);
    expect(clash.unplaced[0].reason).toBe("clash");
  });

  // Feature: timeblocker, Property 35: Placed items never violate fixed, earliest, or latest bounds
  it("Property 35: placed items never violate fixed, earliest, or latest bounds", () => {
    const itemArb = fc
      .record({
        n: fc.integer({ min: 0, max: 1000 }),
        dur: fc.integer({ min: 1, max: 8 }).map((q) => q * 15),
        priority: fc.integer({ min: 1, max: 3 }),
        kind: fc.constantFrom("plain", "fixed", "earliest", "latest", "day"),
        offset: fc.integer({ min: -12, max: 24 * 6 }), // hours from NOW
        span: fc.integer({ min: 1, max: 36 }),
      })
      .map((r, i): Item => {
        const o = NOW_MS + r.offset * HOUR;
        const it = base({
          id: `i${i}-${r.n}`,
          durationMin: r.dur,
          priority: r.priority,
        });
        if (r.kind === "fixed") it.fixedStartMs = o;
        if (r.kind === "earliest") it.earliestMs = o;
        if (r.kind === "latest") it.latestEndMs = o;
        if (r.kind === "day") {
          it.earliestMs = o;
          it.latestEndMs = o + r.span * HOUR;
        }
        return it;
      });

    fc.assert(
      fc.property(
        fc.array(itemArb, { maxLength: 12 }),
        fc.constantFrom("earliest-fit" as const, "spread" as const),
        (items, mode) => {
          const r = computePlan({
            week: WEEK,
            items,
            busy: [],
            settings: { planningMode: mode, holidays: [] },
            now: NOW,
          });
          const spans: Array<[number, number]> = [];
          for (const p of r.placed) {
            const s = new Date(p.slot.start).getTime();
            const e = new Date(p.slot.end).getTime();
            const it = p.item;
            if (it.fixedStartMs !== undefined) expect(s).toBe(it.fixedStartMs);
            if (it.earliestMs !== undefined) expect(s).toBeGreaterThanOrEqual(it.earliestMs);
            if (it.latestEndMs !== undefined) expect(e).toBeLessThanOrEqual(it.latestEndMs);
            expect(s).toBeGreaterThanOrEqual(NOW_MS);
            expect(s).toBeGreaterThanOrEqual(SUNDAY_MS);
            for (const [a, b] of spans) expect(s >= b || e <= a).toBe(true);
            spans.push([s, e]);
          }
          // Past fixed items are never placed; every item is accounted for once.
          for (const u of r.unplaced) {
            if (u.fixedStartMs !== undefined && u.fixedStartMs < NOW_MS) {
              expect(u.reason).toBe("past");
            }
          }
          expect(r.placed.length + r.unplaced.length).toBe(items.length);
        },
      ),
      { numRuns: 200 },
    );
  });
});
