import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { torontoInstant, place, weekBounds, type Item } from "@timeblocker/scheduling-engine";
import {
  buildPlacementPreferences,
  preferenceScore,
  computePlan,
  type PlacementHistoryEntry,
} from "./index.js";

const at = (y: number, m: number, d: number, h: number, min = 0) =>
  torontoInstant(y, m, d, h, min).toISOString();
const e = (
  start: string,
  status: string,
  category: PlacementHistoryEntry["category"] = "work",
): PlacementHistoryEntry => ({ category, start, status });

describe("buildPlacementPreferences (R23.1, R23.2)", () => {
  it("omits categories with fewer than 5 counted blocks", () => {
    const hist = [1, 2, 3, 4].map((d) => e(at(2025, 3, d, 9), "done"));
    expect(buildPlacementPreferences(hist)).toEqual({});
  });

  it("counts done/partial/missed/skipped and ignores other statuses", () => {
    const hist = [
      e(at(2025, 3, 1, 9), "done"),
      e(at(2025, 3, 2, 9), "partial"),
      e(at(2025, 3, 3, 9), "missed"),
      e(at(2025, 3, 4, 9), "skipped"),
      e(at(2025, 3, 5, 9), "done"),
      e(at(2025, 3, 6, 9), "scheduled"),
      e(at(2025, 3, 7, 9), "in-progress"),
      e(at(2025, 3, 8, 9), "rolled"),
      e(at(2025, 3, 9, 9), "moved"),
    ];
    const p = buildPlacementPreferences(hist).work!;
    expect(p.counted).toBe(5);
    expect(p.overall).toBeCloseTo(2.5 / 5, 10);
  });

  it("smooths buckets toward the overall rate with prior weight 3", () => {
    // 4 done in the 08-10 bucket, 4 missed in the 18-20 bucket: overall 0.5.
    const hist = [
      ...[1, 2, 3, 4].map((d) => e(at(2025, 3, d, 9), "done")),
      ...[1, 2, 3, 4].map((d) => e(at(2025, 3, d, 19), "missed")),
    ];
    const p = buildPlacementPreferences(hist).work!;
    expect(p.buckets).toHaveLength(12);
    expect(p.buckets[4]).toBeCloseTo((4 + 3 * 0.5) / (4 + 3), 10);
    expect(p.buckets[9]).toBeCloseTo((0 + 3 * 0.5) / (4 + 3), 10);
    expect(p.buckets[0]).toBeCloseTo(0.5, 10); // empty bucket = overall
  });

  it("weighs partial at 0.5", () => {
    const hist = Array.from({ length: 5 }, (_, i) => e(at(2025, 3, i + 1, 13), "partial"));
    const p = buildPlacementPreferences(hist).work!;
    expect(p.overall).toBe(0.5);
    expect(p.buckets[6]).toBeCloseTo(0.5, 10);
  });

  it("buckets by Toronto hour across DST changes", () => {
    // 2025-03-09 (spring forward) and 2025-11-02 (fall back): 09:00 local either side.
    const hist = [
      e(at(2025, 3, 8, 9), "done"),
      e(at(2025, 3, 9, 9), "done"),
      e(at(2025, 3, 10, 9), "done"),
      e(at(2025, 11, 1, 9), "done"),
      e(at(2025, 11, 2, 9), "done"),
      e(at(2025, 11, 3, 9), "missed"),
    ];
    const p = buildPlacementPreferences(hist).work!;
    expect(p.counted).toBe(6);
    expect(p.buckets[4]).toBeCloseTo(p.overall, 10); // all in one bucket
    for (const i of [0, 1, 2, 3, 5, 11]) expect(p.buckets[i]).toBeCloseTo(p.overall, 10);
    // 23:30 on the DST-change night lands in the last bucket.
    const late = buildPlacementPreferences(
      Array.from({ length: 5 }, (_, i) => e(at(2025, 3, 9, 23, i), "done")),
    ).work!;
    expect(late.buckets[11]).toBe(1);
    expect(late.buckets[4]).toBe(1);
  });

  it("ignores unparsable dates", () => {
    const hist = Array.from({ length: 5 }, () => e("nope", "done"));
    expect(buildPlacementPreferences(hist)).toEqual({});
  });

  it("preferenceScore uses the Toronto start hour bucket; undefined for absent category", () => {
    const hist = [
      ...[1, 2, 3, 4].map((d) => e(at(2025, 3, d, 9), "done")),
      ...[1, 2, 3, 4].map((d) => e(at(2025, 3, d, 19), "missed")),
    ];
    const prefs = buildPlacementPreferences(hist);
    const morning = preferenceScore(prefs, "work", Date.parse(at(2025, 7, 7, 8, 30)))!;
    const evening = preferenceScore(prefs, "work", Date.parse(at(2025, 7, 7, 19, 59)))!;
    expect(morning).toBeGreaterThan(evening);
    expect(preferenceScore(prefs, "fitness", Date.parse(at(2025, 7, 7, 8)))).toBeUndefined();
  });
});

describe("properties", () => {
  const statusArb = fc.constantFrom("done", "partial", "missed", "skipped", "scheduled", "moved");
  const entryArb = fc.record({
    category: fc.constantFrom("work", "fitness", "misc" as const),
    start: fc
      .integer({ min: Date.parse("2024-01-01T00:00:00Z"), max: Date.parse("2026-01-01T00:00:00Z") })
      .map((ms) => new Date(ms).toISOString()),
    status: statusArb,
  });

  // Feature: timeblocker, Property 32: Smoothed preference rates stay within 0..1
  it("Property 32: Smoothed preference rates stay within 0..1", () => {
    fc.assert(
      fc.property(fc.array(entryArb, { maxLength: 80 }), (hist) => {
        const prefs = buildPlacementPreferences(hist as PlacementHistoryEntry[]);
        for (const p of Object.values(prefs)) {
          expect(p.counted).toBeGreaterThanOrEqual(5);
          expect(p.overall).toBeGreaterThanOrEqual(0);
          expect(p.overall).toBeLessThanOrEqual(1);
          expect(p.buckets).toHaveLength(12);
          for (const b of p.buckets) {
            expect(b).toBeGreaterThanOrEqual(0);
            expect(b).toBeLessThanOrEqual(1);
          }
        }
      }),
      { numRuns: 100 },
    );
  });

  // Feature: timeblocker, Property 33: Preferences never make a single fitting item unplaceable
  it("Property 33: Preferences never make a single fitting item unplaceable", () => {
    const base = Date.parse(at(2025, 1, 13, 0));
    const windowsArb = fc
      .array(
        fc.record({
          offset: fc.integer({ min: 0, max: 6 * 24 * 12 }),
          len: fc.integer({ min: 3, max: 60 }),
        }),
        { maxLength: 8 },
      )
      .map((ws) =>
        ws
          .map((w) => ({
            start: new Date(base + w.offset * 5 * 60000).toISOString(),
            end: new Date(base + (w.offset + w.len) * 5 * 60000).toISOString(),
          })),
      );
    fc.assert(
      fc.property(
        windowsArb,
        fc.integer({ min: 3, max: 48 }),
        fc.constantFrom("work", "fitness", "misc" as const),
        fc.constantFrom("earliest-fit", "spread" as const),
        fc.array(fc.double({ min: 0, max: 1, noNaN: true }), { minLength: 12, maxLength: 12 }),
        (wins, dur, category, mode, buckets) => {
          const it: Item = { id: "x", text: "x", priority: 1, durationMin: dur * 5, category };
          const prefs = { [category]: { counted: 9, overall: 0.5, buckets } };
          const old = place([it], wins, mode);
          const scored = place([it], wins, mode, {
            score: (i, ms) => preferenceScore(prefs, i.category, ms),
          });
          if (old.placed.length === 1) expect(scored.placed).toHaveLength(1);
        },
      ),
      { numRuns: 200 },
    );
  });
});

describe("computePlan with preferences", () => {
  const week = weekBounds(at(2025, 7, 9, 12));
  const settings = { planningMode: "earliest-fit" as const, holidays: [] };
  const items: Item[] = [{ id: "a", text: "a", priority: 1, durationMin: 60, category: "work" }];
  const now = at(2025, 7, 6, 0);

  it("matches the unpreferenced plan when preferences are absent or empty", () => {
    const base = computePlan({ week, items, busy: [], settings, now });
    expect(computePlan({ week, items, busy: [], settings, now, preferences: {} })).toEqual(base);
  });

  it("places in the preferred bucket", () => {
    const buckets = new Array<number>(12).fill(0.2);
    buckets[9] = 0.9; // 18:00-20:00
    const r = computePlan({
      week, items, busy: [], settings, now,
      preferences: { work: { counted: 10, overall: 0.4, buckets } },
    });
    const start = new Date(r.placed[0]!.slot.start);
    const hour = Number(
      new Intl.DateTimeFormat("en-CA", { timeZone: "America/Toronto", hour: "2-digit", hour12: false }).format(start),
    );
    expect(hour).toBeGreaterThanOrEqual(18);
    expect(hour).toBeLessThan(20);
  });
});
