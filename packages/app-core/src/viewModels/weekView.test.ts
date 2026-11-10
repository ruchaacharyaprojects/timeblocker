import type { CalendarEvent } from "@timeblocker/calendar-integration";
import type { Category } from "@timeblocker/scheduling-engine";
import { describe, expect, it } from "vitest";
import type { DeviceBlock } from "../models.js";
import { CALENDAR_EVENT_STYLE, CATEGORIES, GOOGLE_EVENT_COLORS, categoryHex, categoryStyle } from "./colors.js";
import { buildWeekView } from "./weekView.js";

// The DST-start week: Sun 2025-03-09 00:00 EST (05:00Z) to Sun 2025-03-16 00:00 EDT (04:00Z).
const NOW = Date.parse("2025-03-11T15:00:00Z"); // Tue 11:00 EDT

function block(id: string, start: string, end: string, category: Category = "work"): DeviceBlock {
  return {
    id,
    itemId: `item-${id}`,
    title: `Block ${id}`,
    start,
    end,
    category,
    status: "scheduled",
    weekId: "2025-03-09",
    calendarEventId: `evt${id}0000`,
    calendarSynced: true,
    promptedMeetingIds: [],
    usagePrompted: false,
    updatedAt: 0,
  };
}

function event(id: string, start: string, end: string, extra: Partial<CalendarEvent> = {}): CalendarEvent {
  return { id, summary: `Event ${id}`, start, end, withOthers: true, isBlock: false, ...extra };
}

describe("colors", () => {
  it("maps every category to its Google palette hex", () => {
    expect(categoryHex("self-care")).toBe("#7986CB");
    expect(categoryHex("fitness")).toBe("#E67C73");
    expect(categoryHex("work")).toBe("#3F51B5");
    expect(categoryHex("self-development")).toBe("#0B8043");
    expect(categoryHex("misc")).toBe("#616161");
    expect(Object.keys(GOOGLE_EVENT_COLORS)).toHaveLength(11);
  });

  it("gives categories distinct colors, none equal to the calendar style", () => {
    const hexes = CATEGORIES.map(categoryHex);
    expect(new Set(hexes).size).toBe(CATEGORIES.length);
    for (const c of CATEGORIES) expect(categoryStyle(c)).not.toEqual(CALENDAR_EVENT_STYLE);
    expect(hexes).not.toContain(CALENDAR_EVENT_STYLE.fill);
  });
});

describe("buildWeekView", () => {
  it("covers the Toronto Sunday-Saturday week, including a DST change", () => {
    const view = buildWeekView({ now: NOW, blocks: [], cache: null, syncState: {} });
    expect(view.weekId).toBe("2025-03-09");
    expect(Date.parse(view.rangeStart)).toBe(Date.parse("2025-03-09T05:00:00Z"));
    expect(Date.parse(view.rangeEnd)).toBe(Date.parse("2025-03-16T04:00:00Z"));
    expect(view.days.map((d) => d.dateKey)).toEqual([
      "2025-03-09", "2025-03-10", "2025-03-11", "2025-03-12", "2025-03-13", "2025-03-14", "2025-03-15",
    ]);
    expect(view.days.find((d) => d.isToday)?.dateKey).toBe("2025-03-11");
    expect(view.rangeLabel).toBe("Sun, Mar 9 – Sat, Mar 15");
    expect(view.banner).toBeNull();
    expect(view.lastSynced).toBeNull();
  });

  it("styles blocks by category and other events with the Calendar style", () => {
    const view = buildWeekView({
      now: NOW,
      blocks: [block("b1", "2025-03-11T18:30:00Z", "2025-03-11T19:30:00Z", "fitness")],
      cache: { syncedAt: NOW, events: [event("e1", "2025-03-12T14:00:00Z", "2025-03-12T15:00:00Z")] },
      syncState: {},
    });
    const [b] = view.blocks;
    expect(b).toMatchObject({ kind: "block", label: "Fitness", dayKey: "2025-03-11", statusLabel: "Scheduled" });
    expect(b!.style.fill).toBe("#E67C73");
    expect(b!.timeLabel).toBe("2:30 PM – 3:30 PM"); // EDT
    expect(b!.deepLink).toBe("timeblocker://block/b1");
    const [e] = view.events;
    expect(e).toMatchObject({ kind: "calendar", label: "Calendar", dayKey: "2025-03-12", style: CALENDAR_EVENT_STYLE });
    expect(view.days[2]!.items.map((i) => i.id)).toEqual(["b1"]);
    expect(view.days[3]!.items.map((i) => i.id)).toEqual(["e1"]);
  });

  it("includes exactly the items overlapping the week (half-open) and drops 🧱 events", () => {
    const view = buildWeekView({
      now: NOW,
      blocks: [
        block("before", "2025-03-08T20:00:00Z", "2025-03-09T05:00:00Z"), // ends at week start
        block("straddle", "2025-03-09T04:00:00Z", "2025-03-09T06:00:00Z"),
        block("after", "2025-03-16T04:00:00Z", "2025-03-16T05:00:00Z"), // starts at week end
      ],
      cache: {
        syncedAt: NOW,
        events: [
          event("mine", "2025-03-10T14:00:00Z", "2025-03-10T15:00:00Z", { isBlock: true }),
          event("unflagged", "2025-03-10T14:00:00Z", "2025-03-10T15:00:00Z", { summary: " 🧱 Gym", isBlock: undefined }),
          event("solo", "2025-03-10T16:00:00Z", "2025-03-10T17:00:00Z", { withOthers: false }),
        ],
      },
      syncState: {},
    });
    expect(view.blocks.map((b) => b.id)).toEqual(["straddle"]);
    expect(view.blocks[0]!.dayKey).toBe("2025-03-09"); // clamped into the week
    expect(view.events.map((e) => e.id)).toEqual(["solo"]);
  });

  it("shows bell badges only while notifications are denied", () => {
    const blocks = [block("b1", "2025-03-11T15:10:00Z", "2025-03-11T16:00:00Z")];
    const cache = { syncedAt: NOW, events: [event("m1", "2025-03-11T15:05:00Z", "2025-03-11T15:30:00Z")] };
    const denied = buildWeekView({
      now: NOW, blocks, cache, syncState: {},
      indicators: { denied: true, blockIds: ["b1"], meetingIds: ["m1"] },
    });
    expect(denied.blocks[0]!.indicator).toBe(true);
    expect(denied.events[0]!.indicator).toBe(true);
    const granted = buildWeekView({
      now: NOW, blocks, cache, syncState: {},
      indicators: { denied: false, blockIds: ["b1"], meetingIds: ["m1"] },
    });
    expect(granted.blocks[0]!.indicator).toBe(false);
    expect(granted.events[0]!.indicator).toBe(false);
  });

  it("shows the sync error banner until dismissed or a later success, and last synced in Toronto", () => {
    const error = { message: "network down", at: NOW - 1_000, dismissed: false };
    const lastSuccessAt = Date.parse("2025-03-11T13:05:00Z"); // 9:05 AM EDT
    const view = buildWeekView({ now: NOW, blocks: [], cache: null, syncState: { error, lastSuccessAt }, refreshing: true });
    expect(view.banner).toEqual({ message: "Calendar sync failed: network down", at: error.at, dismissible: true });
    expect(view.lastSynced).toEqual({ at: lastSuccessAt, label: "Last synced Tue, Mar 11, 9:05 AM" });
    expect(view.refreshing).toBe(true);

    const dismissed = buildWeekView({ now: NOW, blocks: [], cache: null, syncState: { error: { ...error, dismissed: true } } });
    expect(dismissed.banner).toBeNull();
    const recovered = buildWeekView({ now: NOW, blocks: [], cache: null, syncState: { error, lastSuccessAt: NOW } });
    expect(recovered.banner).toBeNull();
  });
});
