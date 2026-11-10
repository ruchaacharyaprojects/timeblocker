import { describe, expect, it } from "vitest";
import { weekBounds, type Week } from "@timeblocker/scheduling-engine";
import type {
  CalendarEvent,
  SoloBlock,
} from "@timeblocker/calendar-integration";
import {
  findConflicts,
  overlaps,
  runMeetingConflictAnswer,
  runMeetingConflictDetection,
  weekIdOf,
  type CalendarReadPort,
  type DetectionDeps,
  type PromptRaiser,
  type WeekBlocksReader,
} from "../lambda/calendar-sync/detect.js";
import type { NativeMissPrompt } from "../lambda/reschedule/prompt.js";
import type {
  BlocksReader,
  BlocksWriter,
  CalendarPort,
  PersistedBlock,
  RescheduleDeps,
  RescheduleSettings,
  SettingsReader,
} from "../lambda/reschedule/reschedule.js";

// A Wednesday block inside the week; weekBounds resolves it to Sun 2025-01-12.
const WEEK_ID = "2025-01-12";
// 2025-01-15 is a Wednesday (remote, no commute). 19:00-19:30 Toronto.
const BLOCK_START = "2025-01-15T19:00:00-05:00";
const BLOCK_END = "2025-01-15T19:30:00-05:00";

function makeBlock(overrides: Partial<PersistedBlock> = {}): PersistedBlock {
  return {
    id: "b1",
    itemId: "item-1",
    start: BLOCK_START,
    end: BLOCK_END,
    category: "misc",
    calendarEventId: "cal-123",
    status: "scheduled",
    weekId: WEEK_ID,
    title: "Deep work",
    ...overrides,
  };
}

/** A meeting with other people that overlaps the block's slot. */
function overlappingMeeting(
  overrides: Partial<CalendarEvent> = {},
): CalendarEvent {
  return {
    id: "m1",
    summary: "Surprise sync",
    start: "2025-01-15T19:15:00-05:00",
    end: "2025-01-15T20:00:00-05:00",
    withOthers: true,
    ...overrides,
  };
}

// --- Pure overlap detection ------------------------------------------------

describe("overlaps (half-open [start, end))", () => {
  it("is true when spans partially overlap", () => {
    expect(
      overlaps(
        { start: BLOCK_START, end: BLOCK_END },
        {
          start: "2025-01-15T19:15:00-05:00",
          end: "2025-01-15T20:00:00-05:00",
        },
      ),
    ).toBe(true);
  });

  it("is true when one span fully contains the other", () => {
    expect(
      overlaps(
        { start: BLOCK_START, end: BLOCK_END },
        {
          start: "2025-01-15T18:00:00-05:00",
          end: "2025-01-15T21:00:00-05:00",
        },
      ),
    ).toBe(true);
  });

  it("is false when spans only touch at a boundary", () => {
    // Meeting starts exactly when the block ends: no overlap (half-open).
    expect(
      overlaps(
        { start: BLOCK_START, end: BLOCK_END },
        {
          start: BLOCK_END,
          end: "2025-01-15T20:00:00-05:00",
        },
      ),
    ).toBe(false);
    // Meeting ends exactly when the block starts.
    expect(
      overlaps(
        { start: BLOCK_START, end: BLOCK_END },
        {
          start: "2025-01-15T18:00:00-05:00",
          end: BLOCK_START,
        },
      ),
    ).toBe(false);
  });

  it("is false when spans are disjoint", () => {
    expect(
      overlaps(
        { start: BLOCK_START, end: BLOCK_END },
        {
          start: "2025-01-15T21:00:00-05:00",
          end: "2025-01-15T22:00:00-05:00",
        },
      ),
    ).toBe(false);
  });
});

describe("findConflicts (R6.1)", () => {
  it("pairs a scheduled block with an overlapping meeting-with-others", () => {
    const block = makeBlock();
    const meeting = overlappingMeeting();
    const conflicts = findConflicts([block], [meeting]);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].block.id).toBe("b1");
    expect(conflicts[0].meetings.map((m) => m.id)).toEqual(["m1"]);
  });

  it("ignores a non-overlapping meeting", () => {
    const block = makeBlock();
    const meeting = overlappingMeeting({
      start: "2025-01-15T21:00:00-05:00",
      end: "2025-01-15T22:00:00-05:00",
    });
    expect(findConflicts([block], [meeting])).toEqual([]);
  });

  it("ignores a solo event even when it overlaps", () => {
    const block = makeBlock();
    // Overlaps in time but has no other attendees -> not a meeting.
    const solo = overlappingMeeting({ id: "solo", withOthers: false });
    expect(findConflicts([block], [solo])).toEqual([]);
  });

  it("ignores blocks that are not still scheduled", () => {
    const moved = makeBlock({ status: "moved" });
    const meeting = overlappingMeeting();
    expect(findConflicts([moved], [meeting])).toEqual([]);
  });

  it("collects multiple overlapping meetings for one block", () => {
    const block = makeBlock();
    const m1 = overlappingMeeting({ id: "m1" });
    const m2 = overlappingMeeting({
      id: "m2",
      start: "2025-01-15T19:00:00-05:00",
      end: "2025-01-15T19:10:00-05:00",
    });
    const conflicts = findConflicts([block], [m1, m2]);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].meetings.map((m) => m.id).sort()).toEqual(["m1", "m2"]);
  });
});

// --- Orchestration fakes ---------------------------------------------------

class FakeWeekBlocks implements WeekBlocksReader {
  seenWeekId?: string;
  constructor(private readonly blocks: PersistedBlock[]) {}
  async readWeekBlocks(weekId: string) {
    this.seenWeekId = weekId;
    return this.blocks;
  }
}

class FakeCalendarRead implements CalendarReadPort {
  seenWeek?: Week;
  constructor(private readonly events: CalendarEvent[]) {}
  async readWeek(week: Week) {
    this.seenWeek = week;
    return this.events;
  }
}

class FakePromptRaiser implements PromptRaiser {
  raised: NativeMissPrompt[] = [];
  async presentPrompt(prompt: NativeMissPrompt) {
    this.raised.push(prompt);
  }
}

function makeDetectionDeps(opts: {
  blocks?: PersistedBlock[];
  events?: CalendarEvent[];
}): {
  deps: DetectionDeps;
  blocks: FakeWeekBlocks;
  calendar: FakeCalendarRead;
  prompt: FakePromptRaiser;
} {
  const blocks = new FakeWeekBlocks(opts.blocks ?? []);
  const calendar = new FakeCalendarRead(opts.events ?? []);
  const prompt = new FakePromptRaiser();
  return { deps: { blocks, calendar, prompt }, blocks, calendar, prompt };
}

describe("runMeetingConflictDetection (R6.1)", () => {
  it("resolves the Sunday-Saturday week and queries that week's blocks", async () => {
    const made = makeDetectionDeps({
      blocks: [makeBlock()],
      events: [overlappingMeeting()],
    });
    await runMeetingConflictDetection({ weekOf: BLOCK_START }, made.deps);
    expect(made.calendar.seenWeek).toEqual(weekBounds(BLOCK_START));
    expect(made.blocks.seenWeekId).toBe(weekIdOf(weekBounds(BLOCK_START)));
    expect(made.blocks.seenWeekId).toBe(WEEK_ID);
  });

  it("raises a meeting-overlap prompt for a block an added meeting overlaps", async () => {
    const made = makeDetectionDeps({
      blocks: [makeBlock()],
      events: [overlappingMeeting()],
    });
    const result = await runMeetingConflictDetection(
      { weekOf: BLOCK_START },
      made.deps,
    );

    expect(result.conflicts).toHaveLength(1);
    expect(result.raised).toHaveLength(1);
    expect(made.prompt.raised).toHaveLength(1);

    const prompt = made.prompt.raised[0];
    expect(prompt.title).toMatch(/will you miss/i);
    expect(prompt.trigger).toBe("meeting-overlap");
    expect(prompt.blockId).toBe("b1");
    expect(prompt.weekId).toBe(WEEK_ID);
    expect(prompt.body).toBe("Deep work");
    expect(prompt.actions.map((a) => a.id)).toEqual(["yes", "no"]);
  });

  it("raises nothing for a non-overlapping meeting", async () => {
    const made = makeDetectionDeps({
      blocks: [makeBlock()],
      events: [
        overlappingMeeting({
          start: "2025-01-15T21:00:00-05:00",
          end: "2025-01-15T22:00:00-05:00",
        }),
      ],
    });
    const result = await runMeetingConflictDetection(
      { weekOf: BLOCK_START },
      made.deps,
    );
    expect(result.conflicts).toEqual([]);
    expect(made.prompt.raised).toEqual([]);
  });

  it("raises nothing for an overlapping solo event (no other attendees)", async () => {
    const made = makeDetectionDeps({
      blocks: [makeBlock()],
      events: [overlappingMeeting({ withOthers: false })],
    });
    const result = await runMeetingConflictDetection(
      { weekOf: BLOCK_START },
      made.deps,
    );
    expect(result.conflicts).toEqual([]);
    expect(made.prompt.raised).toEqual([]);
  });

  it("raises one prompt per conflicted block", async () => {
    const blockA = makeBlock({ id: "a", title: "A" });
    const blockB = makeBlock({
      id: "b",
      title: "B",
      start: "2025-01-16T10:00:00-05:00",
      end: "2025-01-16T11:00:00-05:00",
    });
    const meetingA = overlappingMeeting({ id: "ma" });
    const meetingB = overlappingMeeting({
      id: "mb",
      start: "2025-01-16T10:30:00-05:00",
      end: "2025-01-16T11:30:00-05:00",
    });
    const made = makeDetectionDeps({
      blocks: [blockA, blockB],
      events: [meetingA, meetingB],
    });
    const result = await runMeetingConflictDetection(
      { weekOf: BLOCK_START },
      made.deps,
    );
    expect(result.raised.map((r) => r.prompt.blockId).sort()).toEqual([
      "a",
      "b",
    ]);
  });
});

// --- Answer path (routes into the shared reschedule flow) ------------------

class FakeBlocks implements BlocksReader, BlocksWriter {
  saved: PersistedBlock[] = [];
  constructor(private store: Map<string, PersistedBlock>) {}
  async readBlock(weekId: string, blockId: string) {
    return this.store.get(`${weekId}#${blockId}`) ?? null;
  }
  async saveBlock(block: PersistedBlock) {
    this.saved.push(block);
    this.store.set(`${block.weekId}#${block.id}`, block);
  }
}

class FakeSettings implements SettingsReader {
  constructor(private readonly settings: RescheduleSettings) {}
  async readSettings() {
    return this.settings;
  }
}

class FakeCalendar implements CalendarPort {
  written: SoloBlock[] = [];
  constructor(private readonly events: CalendarEvent[] = []) {}
  async readWeek() {
    return this.events;
  }
  async writeBlock(block: SoloBlock) {
    this.written.push(block);
    return block.calendarEventId ?? "cal-new";
  }
}

function makeRescheduleDeps(opts: {
  block?: PersistedBlock;
  events?: CalendarEvent[];
}): { deps: RescheduleDeps; blocks: FakeBlocks; calendar: FakeCalendar } {
  const block = opts.block ?? makeBlock();
  const store = new Map<string, PersistedBlock>([
    [`${block.weekId}#${block.id}`, block],
  ]);
  const blocks = new FakeBlocks(store);
  const calendar = new FakeCalendar(opts.events ?? []);
  const settings = new FakeSettings({ holidays: [] });
  return {
    deps: { blocks, blocksWriter: blocks, settings, calendar },
    blocks,
    calendar,
  };
}

describe("runMeetingConflictAnswer (R6.2)", () => {
  it("routes a Yes answer into the reschedule flow and moves the block", async () => {
    const made = makeRescheduleDeps({ events: [overlappingMeeting()] });
    const outcome = await runMeetingConflictAnswer(
      { blockId: "b1", weekId: WEEK_ID, answer: "yes" },
      made.deps,
    );
    expect(outcome.kind).toBe("moved");
    if (outcome.kind !== "moved") return;
    // The move updated the calendar event in place and offers Undo.
    expect(made.calendar.written).toHaveLength(1);
    expect(made.calendar.written[0].calendarEventId).toBe("cal-123");
    expect(outcome.undo.previous.start).toBe(BLOCK_START);
    expect(made.blocks.saved[0].status).toBe("moved");
  });

  it("leaves the block in place on a No answer", async () => {
    const made = makeRescheduleDeps({ events: [overlappingMeeting()] });
    const outcome = await runMeetingConflictAnswer(
      { blockId: "b1", weekId: WEEK_ID, answer: "no" },
      made.deps,
    );
    expect(outcome.kind).toBe("declined");
    expect(made.calendar.written).toEqual([]);
    expect(made.blocks.saved).toEqual([]);
  });
});
