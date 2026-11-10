import { describe, expect, it } from "vitest";
import type { Week } from "@timeblocker/scheduling-engine";
import type { CalendarEvent } from "@timeblocker/calendar-integration";
import type {
  NotificationPort,
  ReminderNotification,
} from "@timeblocker/reminders";
import {
  runReminders,
  toReminderBlock,
  toReminderMeeting,
  weekIdOf,
  type BlocksReader,
  type CalendarReadPort,
  type PersistedBlockRow,
} from "../lambda/scheduler/reminders.js";

// A Monday inside the week; weekBounds resolves it to Sun 2025-01-05.
const NOW = "2025-01-06T09:00:00-05:00";
const WEEK_ID = "2025-01-05";

function afterNow(minutes: number): string {
  return new Date(new Date(NOW).getTime() + minutes * 60_000).toISOString();
}

// --- In-memory fakes for the injected ports --------------------------------

class FakeBlocks implements BlocksReader {
  seenWeekId?: string;
  constructor(private readonly rows: PersistedBlockRow[]) {}
  async readWeekBlocks(weekId: string) {
    this.seenWeekId = weekId;
    return this.rows;
  }
}

class FakeCalendar implements CalendarReadPort {
  seenWeek?: Week;
  constructor(private readonly events: CalendarEvent[]) {}
  async readWeek(week: Week) {
    this.seenWeek = week;
    return this.events;
  }
}

class RecordingNotifier implements NotificationPort {
  delivered: ReminderNotification[] = [];
  async deliver(notification: ReminderNotification) {
    this.delivered.push(notification);
  }
}

describe("runReminders (scheduler reminders branch, R5)", () => {
  it("selects and delivers blocks and meetings-with-others ~15 minutes out", async () => {
    const blocks = new FakeBlocks([
      {
        id: "blk-1",
        itemId: "i1",
        title: "Deep work",
        start: afterNow(16),
        end: afterNow(76),
      },
    ]);
    const calendar = new FakeCalendar([
      {
        id: "m1",
        summary: "Standup",
        start: afterNow(20),
        end: afterNow(50),
        withOthers: true,
      },
      {
        id: "solo",
        summary: "Focus (self)",
        start: afterNow(20),
        end: afterNow(50),
        withOthers: false,
      },
    ]);
    const notifier = new RecordingNotifier();

    const result = await runReminders(
      { now: NOW },
      { blocks, calendar, notifier },
    );

    // Resolves and reads the correct Sunday-Saturday week.
    expect(blocks.seenWeekId).toBe(WEEK_ID);
    expect(calendar.seenWeek && weekIdOf(calendar.seenWeek)).toBe(WEEK_ID);

    // The solo meeting is excluded; block + meeting-with-others are delivered.
    expect(result.selected.map((n) => n.id)).toEqual(["block:blk-1", "meeting:m1"]);
    expect(result.delivered).toEqual(["block:blk-1", "meeting:m1"]);
    expect(notifier.delivered.map((n) => n.id)).toEqual([
      "block:blk-1",
      "meeting:m1",
    ]);
  });

  it("delivers the three actionable buttons on each reminder (R5.2)", async () => {
    const blocks = new FakeBlocks([
      { id: "blk-1", itemId: "i1", title: "B", start: afterNow(16), end: afterNow(46) },
    ]);
    const calendar = new FakeCalendar([]);
    const notifier = new RecordingNotifier();

    await runReminders({ now: NOW }, { blocks, calendar, notifier });

    expect(notifier.delivered[0].actions.map((a) => a.id)).toEqual([
      "im-in",
      "skip",
      "move-it",
    ]);
    expect(notifier.delivered[0].actions.map((a) => a.label)).toEqual([
      "I'm in",
      "Skip",
      "Move it",
    ]);
  });

  it("delivers nothing when nothing starts in the window", async () => {
    const blocks = new FakeBlocks([
      { id: "blk-far", itemId: "i1", title: "Later", start: afterNow(120), end: afterNow(180) },
    ]);
    const calendar = new FakeCalendar([]);
    const notifier = new RecordingNotifier();

    const result = await runReminders({ now: NOW }, { blocks, calendar, notifier });

    expect(result.selected).toEqual([]);
    expect(notifier.delivered).toEqual([]);
  });
});

describe("row/event mapping", () => {
  it("prefers title, falls back to text then a default for a block", () => {
    expect(
      toReminderBlock({ id: "b", itemId: "i", title: "T", start: "s", end: "e" }).title,
    ).toBe("T");
    expect(
      toReminderBlock({ id: "b", itemId: "i", text: "X", start: "s", end: "e" }).title,
    ).toBe("X");
    expect(
      toReminderBlock({ id: "b", itemId: "i", start: "s", end: "e" }).title,
    ).toBe("Block");
  });

  it("carries withOthers through from the calendar event", () => {
    const event: CalendarEvent = {
      id: "m",
      summary: "S",
      start: "s",
      end: "e",
      withOthers: true,
    };
    expect(toReminderMeeting(event)).toMatchObject({
      id: "m",
      summary: "S",
      withOthers: true,
    });
  });
});
