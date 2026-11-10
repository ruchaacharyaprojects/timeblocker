import type { CalendarEvent } from "@timeblocker/calendar-integration";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { DeviceBlock } from "../models.js";
import { buildWeekGrid } from "./weekGrid.js";
import { buildWeekView } from "./weekView.js";

// Week of Sun 2025-03-02 .. Sat 2025-03-08 (EST, UTC-5). Wed Mar 5 12:00 EST = 17:00Z.
const NOW = Date.parse("2025-03-05T17:00:00Z");

function block(id: string, start: string, end: string): DeviceBlock {
  return {
    id,
    itemId: `item-${id}`,
    title: `Block ${id}`,
    start,
    end,
    category: "work",
    status: "scheduled",
    weekId: "2025-03-02",
    calendarEventId: `evt${id}0000`,
    calendarSynced: true,
    promptedMeetingIds: [],
    usagePrompted: false,
    updatedAt: 0,
  };
}

function event(id: string, start: string, end: string): CalendarEvent {
  return { id, summary: `Event ${id}`, start, end, withOthers: true, isBlock: false };
}

function grid(blocks: DeviceBlock[], events: CalendarEvent[] = [], now = NOW) {
  const view = buildWeekView({
    now,
    blocks,
    cache: events.length ? { syncedAt: now, events } : null,
    syncState: {},
  });
  return buildWeekGrid(view, now);
}

// Wed Mar 5 local HH:MM (EST) -> ISO.
const wed = (hh: number, mm = 0) =>
  new Date(Date.UTC(2025, 2, 5, hh + 5, mm)).toISOString();

const day = (g: ReturnType<typeof grid>, key: string) => g.days.find((d) => d.dateKey === key)!;

describe("buildWeekGrid", () => {
  it("has seven days with headers", () => {
    const g = grid([]);
    expect(g.hourCount).toBe(24);
    expect(g.weekId).toBe("2025-03-02");
    expect(g.days.map((d) => d.weekday)).toEqual(["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]);
    expect(g.days.map((d) => d.dayOfMonth)).toEqual([2, 3, 4, 5, 6, 7, 8]);
    expect(g.days.filter((d) => d.isToday).map((d) => d.dateKey)).toEqual(["2025-03-05"]);
  });

  it("places a single block by minutes from local midnight", () => {
    const [it] = day(grid([block("a", wed(9, 30), wed(10, 45))]), "2025-03-05").items;
    expect(it).toMatchObject({ id: "a", kind: "block", topMin: 570, heightMin: 75, lane: 0, laneCount: 1 });
    expect(it!.category).toBe("work");
    expect(it!.deepLink).toBe("timeblocker://block/a");
  });

  it("pads short items to 15 minutes and keeps them inside the day", () => {
    const g = grid([block("a", wed(9), wed(9, 5)), block("z", wed(23, 55), wed(23, 59))]);
    const items = day(g, "2025-03-05").items;
    expect(items[0]).toMatchObject({ id: "a", topMin: 540, heightMin: 15 });
    const z = items[1]!;
    expect(z.heightMin).toBe(15);
    expect(z.topMin + z.heightMin).toBe(1440);
  });

  it("puts two overlapping items in two lanes", () => {
    const items = day(grid([block("a", wed(9), wed(10)), block("b", wed(9, 30), wed(10, 30))]), "2025-03-05").items;
    expect(items.map((i) => [i.id, i.lane, i.laneCount])).toEqual([
      ["a", 0, 2],
      ["b", 1, 2],
    ]);
  });

  it("treats a chain A-B, B-C as one cluster of two lanes", () => {
    const items = day(
      grid([block("a", wed(9), wed(10)), block("b", wed(9, 30), wed(11)), block("c", wed(10, 30), wed(12))]),
      "2025-03-05",
    ).items;
    expect(items.map((i) => [i.id, i.lane, i.laneCount])).toEqual([
      ["a", 0, 2],
      ["b", 1, 2],
      ["c", 0, 2],
    ]);
  });

  it("does not treat touching items as overlapping, and clusters are independent", () => {
    const items = day(
      grid([block("a", wed(9), wed(10)), block("b", wed(10), wed(11)), block("c", wed(13), wed(14)), block("d", wed(13), wed(14))]),
      "2025-03-05",
    ).items;
    expect(items.map((i) => [i.id, i.lane, i.laneCount])).toEqual([
      ["a", 0, 1],
      ["b", 0, 1],
      ["c", 0, 2],
      ["d", 1, 2],
    ]);
  });

  it("counts the padded height when deciding overlap", () => {
    // a is 5 min (padded to 9:00-9:15); b starts at 9:10 so they overlap on screen.
    const items = day(grid([block("a", wed(9), wed(9, 5)), block("b", wed(9, 10), wed(10))]), "2025-03-05").items;
    expect(items.map((i) => i.laneCount)).toEqual([2, 2]);
  });

  it("orders by start, then longer first, then id", () => {
    const items = day(
      grid([block("b", wed(9), wed(10)), block("a", wed(9), wed(10)), block("c", wed(9), wed(11)), block("e", wed(8), wed(8, 30))]),
      "2025-03-05",
    ).items;
    expect(items.map((i) => i.id)).toEqual(["e", "c", "a", "b"]);
  });

  it("clips a midnight-spanning item and continues it on the next day", () => {
    const g = grid([block("a", wed(22), new Date(Date.UTC(2025, 2, 6, 7, 30)).toISOString())]); // ends Thu 02:30 EST
    expect(day(g, "2025-03-05").items[0]).toMatchObject({ id: "a", topMin: 1320, heightMin: 120 });
    expect(day(g, "2025-03-06").items[0]).toMatchObject({ id: "a#cont", topMin: 0, heightMin: 150 });
  });

  it("shows a multi-day event as full-height middle segments", () => {
    const g = grid([], [event("e", "2025-03-04T15:00:00Z", "2025-03-07T15:00:00Z")]);
    expect(day(g, "2025-03-04").items[0]).toMatchObject({ id: "e", kind: "calendar", topMin: 600, heightMin: 840 });
    expect(day(g, "2025-03-05").items[0]).toMatchObject({ id: "e#cont", topMin: 0, heightMin: 1440 });
    expect(day(g, "2025-03-07").items[0]).toMatchObject({ id: "e#cont", topMin: 0, heightMin: 600 });
    expect(day(g, "2025-03-08").items).toHaveLength(0);
  });

  it("handles the spring-forward Sunday (2025-03-09)", () => {
    const now = Date.parse("2025-03-11T15:00:00Z");
    // 01:00 EST = 06:00Z; 03:30 EDT = 07:30Z; 23:00 EDT = 03:00Z Mon.
    const g = grid(
      [block("a", "2025-03-09T06:00:00Z", "2025-03-09T07:30:00Z"), block("b", "2025-03-10T02:00:00Z", "2025-03-10T05:30:00Z")],
      [],
      now,
    );
    const items = day(g, "2025-03-09").items;
    expect(items.map((i) => i.id)).toEqual(["a", "b"]);
    expect(items[0]).toMatchObject({ topMin: 60, heightMin: 150 }); // 01:00 -> 03:30 wall clock
    for (const i of items) {
      expect(i.topMin).toBeGreaterThanOrEqual(0);
      expect(i.topMin + i.heightMin).toBeLessThanOrEqual(1440);
    }
    expect(items[1]!.topMin).toBe(22 * 60 + 0); // 22:00 EDT
    expect(day(g, "2025-03-10").items[0]).toMatchObject({ id: "b#cont", topMin: 0, heightMin: 90 });
  });

  it("handles the fall-back Sunday (2025-11-02) without breaking clamps or order", () => {
    const now = Date.parse("2025-11-05T17:00:00Z");
    // 01:30 EDT = 05:30Z; 01:30 EST = 06:30Z (repeated hour); 02:30 EST = 07:30Z.
    const g = grid(
      [block("a", "2025-11-02T05:30:00Z", "2025-11-02T06:30:00Z"), block("b", "2025-11-02T06:30:00Z", "2025-11-02T07:30:00Z")],
      [],
      now,
    );
    const items = day(g, "2025-11-02").items;
    expect(items.map((i) => i.id).sort()).toEqual(["a", "b"]);
    for (const i of items) {
      expect(i.topMin).toBeGreaterThanOrEqual(0);
      expect(i.heightMin).toBeGreaterThanOrEqual(15);
      expect(i.topMin + i.heightMin).toBeLessThanOrEqual(1440);
    }
    expect(grid([], [], Date.parse("2025-11-05T17:00:00Z")).days[0]!.dateKey).toBe("2025-11-02");
    // Day column after the 25-hour Sunday ends at 1440 wall minutes.
    const long = grid([], [event("e", "2025-11-02T10:00:00Z", "2025-11-03T10:00:00Z")], now);
    expect(day(long, "2025-11-02").items[0]!.topMin + day(long, "2025-11-02").items[0]!.heightMin).toBe(1440);
    expect(day(long, "2025-11-03").items[0]!.id).toBe("e#cont");
  });

  it("shows the now line only when today is in the week", () => {
    const g = grid([], [], Date.parse("2025-03-05T17:45:00Z")); // 12:45 EST
    expect(g.nowLine).toEqual({ dayKey: "2025-03-05", topMin: 765 });
    const view = buildWeekView({ now: NOW, blocks: [], cache: null, syncState: {} });
    const other = buildWeekGrid(view, Date.parse("2025-03-20T17:00:00Z"));
    expect(other.nowLine).toBeUndefined();
    expect(other.days.some((d) => d.isToday)).toBe(false);
    expect(other.initialScrollMin).toBe(420);
  });

  it("computes initialScrollMin", () => {
    const at = (iso: string) => grid([], [], Date.parse(iso)).initialScrollMin;
    expect(at("2025-03-05T10:00:00Z")).toBe(420); // 05:00 local, before 7:00
    expect(at("2025-03-05T12:00:00Z")).toBe(360); // 07:00 local -> 06:00
    expect(at("2025-03-05T20:30:00Z")).toBe(840); // 15:30 local -> 14:00
    expect(at("2025-03-06T04:00:00Z")).toBe(1320); // 23:00 local -> 22:00
  });

  it("builds screen-reader labels in time order", () => {
    const g = grid([block("a", wed(14), wed(15, 30))], [event("e", wed(9), wed(10))]);
    const items = day(g, "2025-03-05").items;
    expect(items.map((i) => i.id)).toEqual(["e", "a"]);
    expect(items[0]!.a11yLabel).toBe("Event e, Wed Mar 5, 9:00 AM to 10:00 AM, Calendar event");
    expect(items[1]!.a11yLabel).toBe("Block a, Wed Mar 5, 2:00 PM to 3:30 PM, Work, Scheduled");
    expect(items[1]!.timeLabel).toBe("2:00 PM – 3:30 PM");
  });

  // Feature: timeblocker, Property 25: Week grid lanes never overlap
  it("never overlaps items in a lane and stays within 0..1440", () => {
    fc.assert(
      fc.property(
        fc.array(fc.tuple(fc.integer({ min: 0, max: 1439 }), fc.integer({ min: 1, max: 600 })), { maxLength: 15 }),
        (spans) => {
          const base = Date.UTC(2025, 2, 5, 5, 0);
          const blocks = spans.map(([s, len], i) =>
            block(`b${i}`, new Date(base + s * 60_000).toISOString(), new Date(base + (s + len) * 60_000).toISOString()),
          );
          const g = grid(blocks);
          for (const d of g.days) {
            const times = d.items.map((i) => i.topMin);
            expect(times).toEqual([...times].sort((a, b) => a - b));
            for (const a of d.items) {
              expect(a.topMin).toBeGreaterThanOrEqual(0);
              expect(a.heightMin).toBeGreaterThanOrEqual(15);
              expect(a.topMin + a.heightMin).toBeLessThanOrEqual(1440);
              expect(a.lane).toBeLessThan(a.laneCount);
              for (const b of d.items) {
                if (a === b || a.lane !== b.lane) continue;
                expect(a.topMin + a.heightMin <= b.topMin || b.topMin + b.heightMin <= a.topMin).toBe(true);
              }
            }
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});
