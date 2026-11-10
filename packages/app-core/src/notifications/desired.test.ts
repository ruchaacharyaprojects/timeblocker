/**
 * Unit tests for the pure desired-notification set
 * (R5.1, R5.2, R9.4, R13.1, R13.2, R13.3, R13.11).
 */
import type { CalendarEvent } from "@timeblocker/calendar-integration";
import { REMINDER_ACTIONS } from "@timeblocker/reminders";
import { describe, expect, it } from "vitest";
import type { DeviceBlock, DeviceBlockStatus } from "../models.js";
import {
  REMINDER_LEAD_MS,
  blockReminderId,
  desiredNotifications,
  meetingReminderId,
  nextNudgeAt,
  type DesiredNotification,
} from "./desired.js";

const MIN = 60_000;
/** Wednesday 2025-06-11 09:00 America/Toronto (EDT). */
const NOW = Date.parse("2025-06-11T13:00:00Z");
const iso = (ms: number) => new Date(ms).toISOString();

function block(id: string, startMs: number, status: DeviceBlockStatus = "scheduled"): DeviceBlock {
  return {
    id,
    itemId: `item-${id}`,
    title: `Block ${id}`,
    start: iso(startMs),
    end: iso(startMs + 30 * MIN),
    category: "work",
    status,
    weekId: "2025-06-08",
    calendarEventId: `tb${id}`,
    calendarSynced: true,
    promptedMeetingIds: [],
    usagePrompted: false,
    updatedAt: NOW,
  };
}

function event(id: string, startMs: number, extra: Partial<CalendarEvent> = {}): CalendarEvent {
  return {
    id,
    summary: `Meeting ${id}`,
    start: iso(startMs),
    end: iso(startMs + 30 * MIN),
    withOthers: true,
    isBlock: false,
    ...extra,
  };
}

const reminders = (set: DesiredNotification[]) => set.filter((n) => n.kind !== "weekly-nudge");
const byId = (set: DesiredNotification[], id: string) => set.find((n) => n.payload.id === id);

describe("desiredNotifications: block reminders", () => {
  it("fires 15 minutes before a block that starts later, with exactly the two actions", () => {
    const start = NOW + 60 * MIN;
    const set = desiredNotifications({ blocks: [block("b1", start)], events: [], now: NOW, exact: true });
    const n = byId(set, blockReminderId("b1", start))!;
    expect(n.payload.id).toBe(`rem:block:b1@${start}`);
    expect(n.fireAtMs).toBe(start - REMINDER_LEAD_MS);
    expect(n.startMs).toBe(start);
    expect(n.exact).toBe(true);
    expect(n.payload.kind).toBe("block-reminder");
    expect(n.payload.channel).toBe("reminders");
    expect(n.payload.actions.map((a) => a.label)).toEqual(["I'll be there", "Move to later this week"]);
    expect(n.payload.body).toBe("Starts at 10:00 AM");
    expect(n.payload.actions).toEqual(REMINDER_ACTIONS.map((a) => ({ id: a.id, label: a.label })));
    expect(n.payload.deepLink).toBe("timeblocker://block/b1");
  });

  it("fires at exactly 15 minutes out when the block starts exactly 15 minutes from now", () => {
    const start = NOW + 15 * MIN;
    const [n] = reminders(desiredNotifications({ blocks: [block("b1", start)], events: [], now: NOW, exact: true }));
    expect(n!.fireAtMs).toBe(NOW);
  });

  it("fires now when the block starts within 15 minutes (R13.11)", () => {
    const start = NOW + 5 * MIN;
    const [n] = reminders(desiredNotifications({ blocks: [block("b1", start)], events: [], now: NOW, exact: false }));
    expect(n!.fireAtMs).toBe(NOW);
    expect(n!.exact).toBe(false);
  });

  it("schedules nothing for blocks that started, start now, or aren't scheduled", () => {
    const blocks = [
      block("past", NOW - 10 * MIN),
      block("now", NOW),
      block("done", NOW + 60 * MIN, "done"),
      block("skipped", NOW + 60 * MIN, "skipped"),
      block("inprog", NOW + 60 * MIN, "in-progress"),
    ];
    expect(reminders(desiredNotifications({ blocks, events: [], now: NOW, exact: true }))).toEqual([]);
  });

  it("a changed start yields a different id, and duplicate blocks yield one reminder", () => {
    const a = NOW + 60 * MIN;
    const b = NOW + 90 * MIN;
    expect(blockReminderId("b1", a)).not.toBe(blockReminderId("b1", b));
    const set = desiredNotifications({ blocks: [block("b1", a), block("b1", a)], events: [], now: NOW, exact: true });
    expect(reminders(set)).toHaveLength(1);
  });
});

describe("desiredNotifications: meeting reminders", () => {
  it("one reminder per meeting with others, no actions", () => {
    const start = NOW + 120 * MIN;
    const set = desiredNotifications({ blocks: [], events: [event("e1", start)], now: NOW, exact: true });
    const n = byId(set, meetingReminderId("e1", start))!;
    expect(n.payload.id).toBe(`rem:meeting:e1@${start}`);
    expect(n.fireAtMs).toBe(start - REMINDER_LEAD_MS);
    expect(n.payload.kind).toBe("meeting-reminder");
    expect(n.payload.actions).toEqual([]);
  });

  it("fires now for a meeting within 15 minutes; nothing for past, solo, or 🧱 events", () => {
    const events = [
      event("soon", NOW + 1 * MIN),
      event("past", NOW - 1 * MIN),
      event("solo", NOW + 60 * MIN, { withOthers: false }),
      event("block", NOW + 60 * MIN, { isBlock: true }),
      event("soon", NOW + 1 * MIN),
    ];
    const set = reminders(desiredNotifications({ blocks: [], events, now: NOW, exact: true }));
    expect(set.map((n) => n.payload.id)).toEqual([meetingReminderId("soon", NOW + MIN)]);
    expect(set[0]!.fireAtMs).toBe(NOW);
  });
});

describe("weekly nudges (America/Toronto)", () => {
  it("Saturday 18:00 review and Sunday 08:00 planning, next occurrences", () => {
    const set = desiredNotifications({ blocks: [], events: [], now: NOW, exact: true });
    const nudges = set.filter((n) => n.kind === "weekly-nudge");
    expect(nudges.map((n) => [n.payload.id, n.payload.channel, n.payload.weekId])).toEqual([
      [`nudge:review@${Date.parse("2025-06-14T22:00:00Z")}`, "nudges", "2025-06-08"],
      [`nudge:planning@${Date.parse("2025-06-15T12:00:00Z")}`, "nudges", "2025-06-15"],
    ]);
    for (const n of nudges) expect(n.fireAtMs).toBe(n.startMs);
  });

  it("rolls to next week once the nudge time is reached", () => {
    const satReview = Date.parse("2025-06-14T22:00:00Z");
    expect(nextNudgeAt("review", satReview).atMs).toBe(Date.parse("2025-06-21T22:00:00Z"));
    expect(nextNudgeAt("review", satReview - 1).atMs).toBe(satReview);
    const sunPlan = Date.parse("2025-06-15T12:00:00Z");
    expect(nextNudgeAt("planning", sunPlan)).toEqual({
      atMs: Date.parse("2025-06-22T12:00:00Z"),
      weekId: "2025-06-22",
    });
  });

  it("follows Toronto DST (EDT Saturday, EST Sunday)", () => {
    const fri = Date.parse("2025-10-31T16:00:00Z");
    expect(nextNudgeAt("review", fri)).toEqual({ atMs: Date.parse("2025-11-01T22:00:00Z"), weekId: "2025-10-26" });
    expect(nextNudgeAt("planning", fri)).toEqual({ atMs: Date.parse("2025-11-02T13:00:00Z"), weekId: "2025-11-02" });
  });
});

describe("desiredNotifications: determinism", () => {
  it("orders by fireAtMs then id and is stable across calls", () => {
    const input = {
      blocks: [block("b2", NOW + 90 * MIN), block("b1", NOW + 30 * MIN)],
      events: [event("e1", NOW + 60 * MIN)],
      now: NOW,
      exact: true,
    };
    const a = desiredNotifications(input);
    expect(a).toEqual(desiredNotifications(input));
    const fires = a.map((n) => n.fireAtMs);
    expect(fires).toEqual([...fires].sort((x, y) => x - y));
    expect(reminders(a).map((n) => n.sourceId)).toEqual(["b1", "e1", "b2"]);
  });
});

describe("desiredNotifications: forecast line (R17.3)", () => {
  const start = NOW + 60 * MIN;
  const forecast = (verdict: "likely" | "unlikely" | "unknown", line: string) => ({ verdict, reason: "r", line });

  it("appends the forecast line on a new line of the block reminder body", () => {
    const forecasts = new Map([["b1", forecast("likely", "Likely to happen: You finished 4 of 5 similar blocks")]]);
    const set = desiredNotifications({ blocks: [block("b1", start)], events: [], now: NOW, exact: true, forecasts });
    expect(byId(set, blockReminderId("b1", start))!.payload.body).toBe(
      "Starts at 10:00 AM\nLikely to happen: You finished 4 of 5 similar blocks",
    );
  });

  it("adds nothing for an empty line, a missing forecast, or a meeting reminder", () => {
    const forecasts = new Map([
      ["b1", forecast("unknown", "")],
      ["m1", forecast("unlikely", "May not happen: x")],
    ]);
    const set = desiredNotifications({
      blocks: [block("b1", start), block("b2", start)],
      events: [event("m1", start)],
      now: NOW,
      exact: true,
      forecasts,
    });
    expect(byId(set, blockReminderId("b1", start))!.payload.body).toBe("Starts at 10:00 AM");
    expect(byId(set, blockReminderId("b2", start))!.payload.body).toBe("Starts at 10:00 AM");
    expect(byId(set, meetingReminderId("m1", start))!.payload.body).toBe("Starts at 10:00 AM");
  });
});
