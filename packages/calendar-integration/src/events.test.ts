import { describe, it, expect } from "vitest";
import type { Category } from "./types.js";
import {
  BLOCK_PREFIX,
  CATEGORY_COLOR_ID,
  SUPPRESSED_REMINDERS,
  buildEventRequest,
  colorIdForCategory,
  hasOtherAttendees,
  parseCalendarEvent,
  toBusyEvents,
  withBlockPrefix,
  type RawGoogleEvent,
} from "./events.js";

const ALL_CATEGORIES: Category[] = [
  "fitness",
  "self-care",
  "work",
  "self-development",
  "misc",
];

function block(category: Category = "work") {
  return {
    title: "Deep work",
    start: "2025-01-15T14:00:00.000Z",
    end: "2025-01-15T15:00:00.000Z",
    category,
  };
}

describe("R4.1 solo events carry the 🧱 prefix", () => {
  it("prefixes a plain title with 🧱", () => {
    expect(withBlockPrefix("Deep work")).toBe(`${BLOCK_PREFIX} Deep work`);
  });

  it("does not double-prefix an already-prefixed title", () => {
    const once = withBlockPrefix("Gym");
    expect(withBlockPrefix(once)).toBe(once);
  });

  it("the built request summary always starts with the prefix", () => {
    const req = buildEventRequest(block());
    expect(req.summary.startsWith(BLOCK_PREFIX)).toBe(true);
  });
});

describe("R4.1 distinct color per category", () => {
  it("maps every category to a color id", () => {
    for (const c of ALL_CATEGORIES) {
      expect(colorIdForCategory(c)).toBe(CATEGORY_COLOR_ID[c]);
      expect(colorIdForCategory(c)).toMatch(/^\d+$/);
    }
  });

  it("assigns a distinct color to each category", () => {
    const ids = ALL_CATEGORIES.map(colorIdForCategory);
    expect(new Set(ids).size).toBe(ALL_CATEGORIES.length);
  });

  it("the built request uses the category's color", () => {
    for (const c of ALL_CATEGORIES) {
      expect(buildEventRequest(block(c)).colorId).toBe(CATEGORY_COLOR_ID[c]);
    }
  });
});

describe("R4.2 reminders are suppressed", () => {
  it("disables Google defaults and adds no reminders", () => {
    expect(SUPPRESSED_REMINDERS.useDefault).toBe(false);
    expect(SUPPRESSED_REMINDERS.overrides).toHaveLength(0);
  });

  it("every written event uses suppressed reminders with no email reminder", () => {
    const req = buildEventRequest(block());
    expect(req.reminders.useDefault).toBe(false);
    expect(req.reminders.overrides).toHaveLength(0);
    expect(req.reminders.overrides.some((o) => o.method === "email")).toBe(false);
  });
});

describe("parsing read-back events", () => {
  it("parses a timed event with other attendees as a meeting", () => {
    const raw: RawGoogleEvent = {
      id: "e1",
      summary: "Standup",
      start: { dateTime: "2025-01-15T13:00:00Z" },
      end: { dateTime: "2025-01-15T13:30:00Z" },
      attendees: [{ self: true }, { email: "a@b.com" }],
    };
    const parsed = parseCalendarEvent(raw);
    expect(parsed?.withOthers).toBe(true);
    expect(parsed?.id).toBe("e1");
  });

  it("treats a self-only event as not a meeting", () => {
    const raw: RawGoogleEvent = {
      id: "e2",
      start: { dateTime: "2025-01-15T13:00:00Z" },
      end: { dateTime: "2025-01-15T13:30:00Z" },
      attendees: [{ self: true }],
    };
    expect(hasOtherAttendees(raw)).toBe(false);
    expect(parseCalendarEvent(raw)?.withOthers).toBe(false);
  });

  it("sets isBlock from the 🧱 prefix, ignoring leading spaces", () => {
    const at = (summary?: string): RawGoogleEvent => ({
      id: "e",
      summary,
      start: { dateTime: "2025-01-15T13:00:00Z" },
      end: { dateTime: "2025-01-15T13:30:00Z" },
    });
    expect(parseCalendarEvent(at("🧱 Leg day"))?.isBlock).toBe(true);
    expect(parseCalendarEvent(at("   🧱 Leg day"))?.isBlock).toBe(true);
    expect(parseCalendarEvent(at("🧱"))?.isBlock).toBe(true);
    expect(parseCalendarEvent(at("Leg day 🧱"))?.isBlock).toBe(false);
    expect(parseCalendarEvent(at("Standup"))?.isBlock).toBe(false);
    expect(parseCalendarEvent(at(undefined))?.isBlock).toBe(false);
  });

  it("drops events missing id or times", () => {
    expect(parseCalendarEvent({ summary: "no id" })).toBeUndefined();
    expect(parseCalendarEvent({ id: "x", start: { dateTime: "2025-01-15T13:00:00Z" } })).toBeUndefined();
  });

  it("maps parsed events into engine BusyEvents preserving meeting flag", () => {
    const events = [
      {
        id: "e1",
        summary: "m",
        start: "2025-01-15T13:00:00.000Z",
        end: "2025-01-15T13:30:00.000Z",
        withOthers: true,
      },
    ];
    const busy = toBusyEvents(events);
    expect(busy[0]).toEqual({
      id: "e1",
      start: "2025-01-15T13:00:00.000Z",
      end: "2025-01-15T13:30:00.000Z",
      withOthers: true,
    });
  });
});

describe("property: every category write satisfies R4.1 and R4.2", () => {
  it("prefix + distinct-looking color + no reminders for random categories", () => {
    for (let i = 0; i < 200; i++) {
      const c = ALL_CATEGORIES[i % ALL_CATEGORIES.length];
      const req = buildEventRequest(block(c));
      expect(req.summary.startsWith(BLOCK_PREFIX)).toBe(true);
      expect(req.colorId).toBe(CATEGORY_COLOR_ID[c]);
      expect(req.reminders.useDefault).toBe(false);
      expect(req.reminders.overrides).toHaveLength(0);
    }
  });
});
