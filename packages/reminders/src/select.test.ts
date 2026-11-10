import { describe, expect, it } from "vitest";
import {
  DEFAULT_LEAD_MINUTES,
  DEFAULT_TICK_MINUTES,
  reminderWindow,
  selectReminders,
  type ReminderSources,
} from "./select.js";
import { LEGACY_REMINDER_ACTIONS } from "./types.js";

const NOW = new Date("2025-01-06T09:00:00.000-05:00"); // Mon 09:00 America/Toronto

/** Build an instant `minutes` after NOW. */
function afterNow(minutes: number): string {
  return new Date(NOW.getTime() + minutes * 60_000).toISOString();
}

function sources(partial: Partial<ReminderSources> = {}): ReminderSources {
  return { blocks: [], meetings: [], ...partial };
}

describe("reminderWindow", () => {
  it("defaults to a [now+15, now+30) window", () => {
    const { from, to } = reminderWindow(NOW);
    expect(from).toBe(NOW.getTime() + DEFAULT_LEAD_MINUTES * 60_000);
    expect(to).toBe(
      NOW.getTime() + (DEFAULT_LEAD_MINUTES + DEFAULT_TICK_MINUTES) * 60_000,
    );
  });

  it("honors custom lead and tick minutes", () => {
    const { from, to } = reminderWindow(NOW, { leadMinutes: 10, tickMinutes: 5 });
    expect(from).toBe(NOW.getTime() + 10 * 60_000);
    expect(to).toBe(NOW.getTime() + 15 * 60_000);
  });
});

describe("selectReminders — blocks (R5.1)", () => {
  it("fires for a block starting ~15 minutes out", () => {
    const result = selectReminders(
      sources({
        blocks: [
          { id: "b1", title: "Deep work", start: afterNow(15), end: afterNow(75) },
        ],
      }),
      NOW,
    );
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      id: "block:b1",
      kind: "block",
      sourceId: "b1",
      title: "Deep work",
      startsAt: afterNow(15),
    });
  });

  it("does not fire for a block starting too soon (before the window)", () => {
    const result = selectReminders(
      sources({
        blocks: [{ id: "b1", title: "Soon", start: afterNow(5), end: afterNow(35) }],
      }),
      NOW,
    );
    expect(result).toHaveLength(0);
  });

  it("does not fire for a block starting beyond this tick's window", () => {
    // 30 minutes out belongs to the NEXT tick (half-open upper bound).
    const result = selectReminders(
      sources({
        blocks: [{ id: "b1", title: "Later", start: afterNow(30), end: afterNow(90) }],
      }),
      NOW,
    );
    expect(result).toHaveLength(0);
  });

  it("includes the lower bound and excludes the upper bound (half-open)", () => {
    const result = selectReminders(
      sources({
        blocks: [
          { id: "lo", title: "At 15", start: afterNow(15), end: afterNow(45) },
          { id: "hi", title: "At 29", start: afterNow(29), end: afterNow(59) },
          { id: "out", title: "At 30", start: afterNow(30), end: afterNow(60) },
        ],
      }),
      NOW,
    );
    expect(result.map((r) => r.sourceId)).toEqual(["lo", "hi"]);
  });
});

describe("selectReminders — meetings with others (R5.1)", () => {
  it("fires for a meeting with other people starting ~15 minutes out", () => {
    const result = selectReminders(
      sources({
        meetings: [
          {
            id: "m1",
            summary: "Standup",
            start: afterNow(20),
            end: afterNow(50),
            withOthers: true,
          },
        ],
      }),
      NOW,
    );
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      id: "meeting:m1",
      kind: "meeting",
      sourceId: "m1",
      title: "Standup",
    });
  });

  it("ignores meetings without other people", () => {
    const result = selectReminders(
      sources({
        meetings: [
          {
            id: "solo",
            summary: "Focus (self)",
            start: afterNow(20),
            end: afterNow(50),
            withOthers: false,
          },
        ],
      }),
      NOW,
    );
    expect(result).toHaveLength(0);
  });
});

describe("selectReminders — actions and ordering (R5.2)", () => {
  it("attaches exactly the three actions I'm in / Skip / Move it, in order", () => {
    const result = selectReminders(
      sources({
        blocks: [{ id: "b1", title: "B", start: afterNow(16), end: afterNow(46) }],
      }),
      NOW,
    );
    expect(result[0].actions).toBe(LEGACY_REMINDER_ACTIONS);
    expect(result[0].actions.map((a) => a.id)).toEqual([
      "im-in",
      "skip",
      "move-it",
    ]);
    expect(result[0].actions.map((a) => a.label)).toEqual([
      "I'm in",
      "Skip",
      "Move it",
    ]);
  });

  it("orders notifications by start instant, block before meeting on ties", () => {
    const tie = afterNow(20);
    const result = selectReminders(
      sources({
        blocks: [
          { id: "b-late", title: "Late block", start: afterNow(25), end: afterNow(55) },
          { id: "b-tie", title: "Tie block", start: tie, end: afterNow(50) },
        ],
        meetings: [
          {
            id: "m-tie",
            summary: "Tie meeting",
            start: tie,
            end: afterNow(50),
            withOthers: true,
          },
        ],
      }),
      NOW,
    );
    expect(result.map((r) => r.id)).toEqual([
      "block:b-tie",
      "meeting:m-tie",
      "block:b-late",
    ]);
  });

  it("writes a human-readable lead body", () => {
    const result = selectReminders(
      sources({
        blocks: [{ id: "b1", title: "B", start: afterNow(15), end: afterNow(45) }],
      }),
      NOW,
    );
    expect(result[0].body).toBe("Starts in 15 minutes");
  });
});

describe("selectReminders — robustness", () => {
  it("ignores events with unparseable start instants", () => {
    const result = selectReminders(
      sources({
        blocks: [{ id: "bad", title: "Bad", start: "not-a-date", end: "nope" }],
      }),
      NOW,
    );
    expect(result).toHaveLength(0);
  });

  it("returns an empty list when nothing is due", () => {
    expect(selectReminders(sources(), NOW)).toEqual([]);
  });
});
