/** Unit and property tests for `forecastBlock` (R17.3). */
import type { CalendarEvent } from "@timeblocker/calendar-integration";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { DeviceBlockStatus } from "../models.js";
import { forecastBlock, type ForecastHistoryEntry } from "./forecast.js";

const MIN = 60_000;
const T0 = Date.parse("2025-06-11T15:00:00Z");
const iso = (ms: number) => new Date(ms).toISOString();
const block = { category: "work", start: iso(T0), end: iso(T0 + 60 * MIN) };
const hist = (status: DeviceBlockStatus, n = 1, category = "work"): ForecastHistoryEntry[] =>
  Array.from({ length: n }, () => ({ category, status }));
const meeting = (startMs: number, endMs: number, extra: Partial<CalendarEvent> = {}): CalendarEvent => ({
  id: "m",
  summary: "Standup",
  start: iso(startMs),
  end: iso(endMs),
  withOthers: true,
  isBlock: false,
  ...extra,
});

describe("forecastBlock", () => {
  it("is likely at or above half completion with 3+ samples", () => {
    const f = forecastBlock({ block, history: [...hist("done", 3), ...hist("missed", 2)], events: [] });
    expect(f).toEqual({
      verdict: "likely",
      reason: "You finished 3 of 5 similar blocks",
      line: "Likely to happen: You finished 3 of 5 similar blocks",
    });
  });

  it("counts partial as finished and ignores other statuses and categories", () => {
    const history = [
      ...hist("partial", 2),
      ...hist("done"),
      ...hist("scheduled", 5),
      ...hist("in-progress", 5),
      ...hist("rolled", 5),
      ...hist("missed", 5, "fitness"),
    ];
    expect(forecastBlock({ block, history, events: [] }).reason).toBe("You finished 3 of 3 similar blocks");
  });

  it("is unlikely below half completion", () => {
    const f = forecastBlock({ block, history: [...hist("done"), ...hist("missed"), ...hist("skipped", 2)], events: [] });
    expect(f.verdict).toBe("unlikely");
    expect(f.line).toBe("May not happen: You finished 1 of 4 similar blocks");
  });

  it("is unknown with fewer than 3 counted samples and no negative signal", () => {
    expect(forecastBlock({ block, history: [...hist("done", 2), ...hist("scheduled", 4)], events: [] })).toEqual({
      verdict: "unknown",
      reason: "",
      line: "",
    });
  });

  it("flags an overlapping meeting even without history, using a half-open range", () => {
    const f = forecastBlock({ block, history: [], events: [meeting(T0 + 30 * MIN, T0 + 90 * MIN)] });
    expect(f.line).toBe("May not happen: Overlaps Standup");
    expect(forecastBlock({ block, history: [], events: [meeting(T0 + 60 * MIN, T0 + 90 * MIN)] }).verdict).toBe("unknown");
    expect(forecastBlock({ block, history: [], events: [meeting(T0 - 30 * MIN, T0)] }).verdict).toBe("unknown");
  });

  it("names an untitled meeting generically and ignores solo events and blocks", () => {
    expect(forecastBlock({ block, history: [], events: [meeting(T0, T0 + MIN, { summary: "" })] }).reason).toBe(
      "Overlaps a meeting",
    );
    const ignored = [meeting(T0, T0 + MIN, { withOthers: false }), meeting(T0, T0 + MIN, { isBlock: true })];
    expect(forecastBlock({ block, history: [], events: ignored }).verdict).toBe("unknown");
  });

  it("flags recent distraction", () => {
    const f = forecastBlock({ block, history: hist("done", 5), events: [], recentDistraction: true });
    expect(f.line).toBe("May not happen: You've been on your distraction apps");
  });

  it("prefers meeting, then distraction, then low completion", () => {
    const low = hist("missed", 4);
    const ev = [meeting(T0, T0 + MIN)];
    expect(forecastBlock({ block, history: low, events: ev, recentDistraction: true }).reason).toBe("Overlaps Standup");
    expect(forecastBlock({ block, history: low, events: [], recentDistraction: true }).reason).toBe(
      "You've been on your distraction apps",
    );
    expect(forecastBlock({ block, history: low, events: [] }).reason).toBe("You finished 0 of 4 similar blocks");
  });

  it("uses plain copy: no emoji, no exclamation marks", () => {
    const f = forecastBlock({ block, history: hist("done", 4), events: [] });
    expect(f.line).not.toMatch(/[!\p{Extended_Pictographic}]/u);
  });
});

const STATUSES: DeviceBlockStatus[] = ["scheduled", "in-progress", "done", "partial", "skipped", "missed", "rolled"];
const CATEGORIES = ["work", "fitness", "personal"];

describe("forecastBlock properties", () => {
  // Feature: timeblocker, Property 26: Forecast verdict follows the R17.3 rules
  it("Property 26: Forecast verdict follows the R17.3 rules", () => {
    const entry = fc.record({ category: fc.constantFrom(...CATEGORIES), status: fc.constantFrom(...STATUSES) });
    const ev = fc.record({
      offset: fc.integer({ min: -120, max: 120 }),
      length: fc.integer({ min: 1, max: 120 }),
      withOthers: fc.boolean(),
      isBlock: fc.boolean(),
      summary: fc.constantFrom("", "Standup", "1:1"),
    });
    fc.assert(
      fc.property(
        fc.array(entry, { maxLength: 30 }),
        fc.array(ev, { maxLength: 4 }),
        fc.boolean(),
        (history, evs, recentDistraction) => {
          const events: CalendarEvent[] = evs.map((e, i) => ({
            id: `e${i}`,
            summary: e.summary,
            start: iso(T0 + e.offset * MIN),
            end: iso(T0 + (e.offset + e.length) * MIN),
            withOthers: e.withOthers,
            isBlock: e.isBlock,
          }));
          const f = forecastBlock({ block, history, events, recentDistraction });

          const same = history.filter((h) => h.category === "work");
          const finished = same.filter((h) => h.status === "done" || h.status === "partial").length;
          const counted = same.filter((h) => ["done", "partial", "missed", "skipped"].includes(h.status)).length;
          // The earliest-starting qualifying overlap names the reason.
          const overlap = events
            .filter((e) => e.withOthers && !e.isBlock && Date.parse(e.start) < T0 + 60 * MIN && T0 < Date.parse(e.end))
            .sort((a, b) => Date.parse(a.start) - Date.parse(b.start))[0];

          if (overlap) {
            expect(f.verdict).toBe("unlikely");
            expect(f.reason).toBe(`Overlaps ${overlap.summary || "a meeting"}`);
          } else if (recentDistraction) {
            expect(f.verdict).toBe("unlikely");
            expect(f.reason).toBe("You've been on your distraction apps");
          } else if (counted < 3) {
            expect(f.verdict).toBe("unknown");
          } else {
            expect(f.verdict).toBe(finished / counted < 0.5 ? "unlikely" : "likely");
            expect(f.reason).toBe(`You finished ${finished} of ${counted} similar blocks`);
          }
          expect(f.line).toBe(
            f.verdict === "likely"
              ? `Likely to happen: ${f.reason}`
              : f.verdict === "unlikely"
                ? `May not happen: ${f.reason}`
                : "",
          );
        },
      ),
      { numRuns: 200 },
    );
  });
});
