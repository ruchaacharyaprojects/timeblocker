import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { weekBounds, type Week } from "@timeblocker/scheduling-engine";
import type {
  CalendarEvent,
  SoloBlock,
} from "@timeblocker/calendar-integration";
import {
  applyUndo,
  computeReschedule,
  runReschedule,
  type BlocksReader,
  type BlocksWriter,
  type CalendarPort,
  type PersistedBlock,
  type RescheduleDeps,
  type RescheduleSettings,
  type SettingsReader,
} from "./reschedule.js";
import {
  buildMissPrompt,
  getMissPromptNative,
  PROMPT_ACTIONS,
  setMissPromptNative,
  toRescheduleRequest,
  type MissPromptNativeModule,
} from "./prompt.js";

// A Wednesday block inside the week; weekBounds resolves it to Sun 2025-01-12.
const WEEK_ID = "2025-01-12";
// 2025-01-15 is a Wednesday (remote, no commute). 19:00-19:30 Toronto.
const BLOCK_START = "2025-01-15T19:00:00-05:00";
const BLOCK_END = "2025-01-15T19:30:00-05:00";

// --- In-memory fakes for the injected ports --------------------------------

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
  seenWeek?: Week;
  constructor(private readonly events: CalendarEvent[] = []) {}
  async readWeek(week: Week) {
    this.seenWeek = week;
    return this.events;
  }
  async writeBlock(block: SoloBlock) {
    this.written.push(block);
    // Echo the incoming calendar event id so an in-place update keeps its id.
    return block.calendarEventId ?? "cal-new";
  }
}

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

function makeDeps(opts: {
  block?: PersistedBlock;
  settings?: RescheduleSettings;
  events?: CalendarEvent[];
}): {
  deps: RescheduleDeps;
  calendar: FakeCalendar;
  blocks: FakeBlocks;
} {
  const block = opts.block ?? makeBlock();
  const store = new Map<string, PersistedBlock>([
    [`${block.weekId}#${block.id}`, block],
  ]);
  const blocks = new FakeBlocks(store);
  const calendar = new FakeCalendar(opts.events ?? []);
  const settings = new FakeSettings(opts.settings ?? { holidays: [] });
  return {
    deps: { blocks, blocksWriter: blocks, settings, calendar },
    calendar,
    blocks,
  };
}

/** A busy calendar event over the block's current slot (so it must move). */
function overlappingMeeting(): CalendarEvent {
  return {
    id: "m1",
    summary: "Surprise sync",
    start: BLOCK_START,
    end: "2025-01-15T20:00:00-05:00",
    withOthers: true,
  };
}

describe("runReschedule", () => {
  describe("No answer leaves the block in place (R6.1)", () => {
    it("does not move or persist anything", async () => {
      const made = makeDeps({});
      const outcome = await runReschedule(
        { blockId: "b1", weekId: WEEK_ID, answer: "no" },
        made.deps,
      );
      expect(outcome.kind).toBe("declined");
      if (outcome.kind === "declined") {
        expect(outcome.block.status).toBe("scheduled");
      }
      expect(made.calendar.written).toEqual([]);
      expect(made.blocks.saved).toEqual([]);
    });
  });

  describe("Yes -> moved + Undo (R6.2)", () => {
    let outcome: Awaited<ReturnType<typeof runReschedule>>;
    let calendar: FakeCalendar;
    let blocks: FakeBlocks;

    beforeEach(async () => {
      const made = makeDeps({ events: [overlappingMeeting()] });
      calendar = made.calendar;
      blocks = made.blocks;
      outcome = await runReschedule(
        { blockId: "b1", weekId: WEEK_ID, answer: "yes" },
        made.deps,
      );
    });

    it("resolves the block's Sunday-Saturday week", () => {
      expect(calendar.seenWeek).toEqual(weekBounds(BLOCK_START));
    });

    it("moves the block to a later, non-overlapping slot", () => {
      expect(outcome.kind).toBe("moved");
      if (outcome.kind !== "moved") return;
      const meeting = overlappingMeeting();
      const newStart = new Date(outcome.to.start).getTime();
      // The new slot starts at or after the meeting ends.
      expect(newStart).toBeGreaterThanOrEqual(
        new Date(meeting.end).getTime(),
      );
      // Duration is preserved (30 minutes).
      const mins =
        (new Date(outcome.to.end).getTime() -
          new Date(outcome.to.start).getTime()) /
        60000;
      expect(mins).toBe(30);
    });

    it("updates the calendar event in place (same id)", () => {
      expect(calendar.written).toHaveLength(1);
      expect(calendar.written[0].calendarEventId).toBe("cal-123");
      expect(calendar.written[0].title).toBe("Deep work");
    });

    it("persists the moved block with status 'moved' and the new slot", () => {
      expect(blocks.saved).toHaveLength(1);
      const saved = blocks.saved[0];
      expect(saved.status).toBe("moved");
      if (outcome.kind === "moved") {
        expect(saved.start).toBe(outcome.to.start);
        expect(saved.end).toBe(outcome.to.end);
      }
    });

    it("returns an Undo token restoring the previous slot and status", () => {
      if (outcome.kind !== "moved") throw new Error("expected moved");
      expect(outcome.undo.previous.start).toBe(BLOCK_START);
      expect(outcome.undo.previous.end).toBe(BLOCK_END);
      expect(outcome.undo.previousStatus).toBe("scheduled");
      expect(outcome.undo.calendarEventId).toBe("cal-123");
      expect(outcome.from).toEqual({ start: BLOCK_START, end: BLOCK_END });
    });

    it("defaults a missing answer to yes", async () => {
      const made = makeDeps({ events: [overlappingMeeting()] });
      const res = await runReschedule(
        { blockId: "b1", weekId: WEEK_ID },
        made.deps,
      );
      expect(res.kind).toBe("moved");
    });
  });

  describe("no valid slot -> nothing-fits flow (R6.3)", () => {
    let outcome: Awaited<ReturnType<typeof runReschedule>>;
    let calendar: FakeCalendar;
    let blocks: FakeBlocks;

    beforeEach(async () => {
      // A 9-hour block cannot fit in any free window in the week.
      const huge = makeBlock({
        start: "2025-01-18T10:00:00-05:00", // Saturday
        end: "2025-01-18T19:00:00-05:00",
      });
      const made = makeDeps({ block: huge });
      calendar = made.calendar;
      blocks = made.blocks;
      outcome = await runReschedule(
        { blockId: "b1", weekId: WEEK_ID, answer: "yes" },
        made.deps,
      );
    });

    it("returns the shrink/drop/roll alert reusing the planning shape", () => {
      expect(outcome.kind).toBe("nothing-fits");
      if (outcome.kind !== "nothing-fits") return;
      expect(outcome.alert.options).toEqual([
        "shrink",
        "drop",
        "roll-to-next-week",
      ]);
      expect(outcome.alert.items).toHaveLength(1);
      expect(outcome.alert.items[0].id).toBe("item-1");
      expect(outcome.alert.message).toMatch(/shrink/i);
      expect(outcome.alert.message).toMatch(/next week/i);
    });

    it("moves nothing: no calendar write, no persistence", () => {
      expect(calendar.written).toEqual([]);
      expect(blocks.saved).toEqual([]);
    });
  });

  describe("missing block", () => {
    it("throws when the block does not exist", async () => {
      const made = makeDeps({});
      await expect(
        runReschedule({ blockId: "missing", weekId: WEEK_ID }, made.deps),
      ).rejects.toThrow(/not found/i);
    });
  });
});

describe("applyUndo (R6.2)", () => {
  it("restores a moved block to its previous slot and status", async () => {
    const made = makeDeps({ events: [overlappingMeeting()] });
    const outcome = await runReschedule(
      { blockId: "b1", weekId: WEEK_ID, answer: "yes" },
      made.deps,
    );
    if (outcome.kind !== "moved") throw new Error("expected moved");

    const restored = await applyUndo(outcome.undo, {
      blocks: made.blocks,
      blocksWriter: made.blocks,
      calendar: made.calendar,
    });

    expect(restored.start).toBe(BLOCK_START);
    expect(restored.end).toBe(BLOCK_END);
    expect(restored.status).toBe("scheduled");
    // The calendar event was updated in place both on move and on undo.
    expect(made.calendar.written).toHaveLength(2);
    expect(made.calendar.written[1].start).toBe(BLOCK_START);
  });
});

describe("Will-you-miss-this prompt surface (R6.1)", () => {
  it("carries Yes/No actions and the block context", () => {
    const prompt = buildMissPrompt({
      blockId: "b1",
      weekId: WEEK_ID,
      title: "Deep work",
      trigger: "meeting-overlap",
    });
    expect(prompt.title).toMatch(/will you miss/i);
    expect(prompt.actions).toEqual(PROMPT_ACTIONS);
    expect(prompt.actions.map((a) => a.id)).toEqual(["yes", "no"]);
    expect(prompt.blockId).toBe("b1");
    expect(prompt.weekId).toBe(WEEK_ID);
  });

  it("maps a Yes tap to a reschedule request", () => {
    const req = toRescheduleRequest(
      { promptId: "miss:b1", blockId: "b1", weekId: WEEK_ID, answer: "yes" },
      "2025-01-15T18:00:00-05:00",
    );
    expect(req).toEqual({
      blockId: "b1",
      weekId: WEEK_ID,
      answer: "yes",
      now: "2025-01-15T18:00:00-05:00",
    });
  });
});

// --- computeReschedule (pure core) -----------------------------------------

describe("computeReschedule (pure)", () => {
  const week = weekBounds(BLOCK_START);
  const busy = [overlappingMeeting()];

  it("finds a later slot that avoids the busy meeting", () => {
    const res = computeReschedule({
      block: makeBlock(),
      week,
      busy,
      constraints: { holidays: [] },
      now: BLOCK_START,
    });
    expect(res.kind).toBe("moved");
    if (res.kind !== "moved") return;
    expect(new Date(res.slot.start).getTime()).toBeGreaterThanOrEqual(
      new Date(overlappingMeeting().end).getTime(),
    );
  });

  it("never moves into the past: searches from max(block.start, now)", () => {
    // `now` is a day after the block's start, so the new slot must be later.
    const now = "2025-01-16T12:00:00-05:00";
    const res = computeReschedule({
      block: makeBlock(),
      week,
      busy: [],
      constraints: { holidays: [] },
      now,
    });
    expect(res.kind).toBe("moved");
    if (res.kind !== "moved") return;
    expect(new Date(res.slot.start).getTime()).toBeGreaterThanOrEqual(
      new Date(now).getTime(),
    );
  });

  it("returns the nothing-fits alert when no slot exists", () => {
    const res = computeReschedule({
      block: makeBlock({
        start: "2025-01-18T10:00:00-05:00",
        end: "2025-01-18T19:00:00-05:00",
      }),
      week,
      busy: [],
      constraints: { holidays: [] },
      now: "2025-01-18T10:00:00-05:00",
    });
    expect(res.kind).toBe("nothing-fits");
    if (res.kind !== "nothing-fits") return;
    expect(res.alert.items.map((i) => i.id)).toEqual(["item-1"]);
    expect(res.alert.options).toEqual(["shrink", "drop", "roll-to-next-week"]);
  });

  it("runReschedule honors request.now via computeReschedule", async () => {
    const now = "2025-01-16T12:00:00-05:00";
    const made = makeDeps({});
    const outcome = await runReschedule(
      { blockId: "b1", weekId: WEEK_ID, answer: "yes", now },
      made.deps,
    );
    expect(outcome.kind).toBe("moved");
    if (outcome.kind !== "moved") return;
    expect(new Date(outcome.to.start).getTime()).toBeGreaterThanOrEqual(
      new Date(now).getTime(),
    );
  });
});

describe("runReschedule with a block that has no calendarEventId", () => {
  it("creates a new event and persists its id", async () => {
    const noId = makeBlock();
    delete noId.calendarEventId;
    const made = makeDeps({ block: noId, events: [overlappingMeeting()] });
    const outcome = await runReschedule(
      { blockId: "b1", weekId: WEEK_ID, answer: "yes" },
      made.deps,
    );
    expect(outcome.kind).toBe("moved");
    if (outcome.kind !== "moved") return;
    expect(made.calendar.written).toHaveLength(1);
    expect("calendarEventId" in made.calendar.written[0]).toBe(false);
    expect(outcome.block.calendarEventId).toBe("cal-new");
    expect(outcome.undo.calendarEventId).toBe("cal-new");
    expect(made.blocks.saved[0].calendarEventId).toBe("cal-new");
  });
});

describe("getMissPromptNative (no React Native lookup)", () => {
  afterEach(() => {
    setMissPromptNative(undefined);
    delete (globalThis as { nativeModuleProxy?: unknown }).nativeModuleProxy;
  });

  it("ignores globalThis.nativeModuleProxy and throws when nothing is injected", () => {
    (globalThis as { nativeModuleProxy?: unknown }).nativeModuleProxy = {
      MissPrompt: {},
    };
    expect(() => getMissPromptNative()).toThrow(/unavailable/i);
  });

  it("returns the injected implementation", () => {
    const mod: MissPromptNativeModule = {
      presentPrompt: async () => {},
      cancelPrompt: async () => {},
      addAnswerListener: () => ({ remove() {} }),
    };
    setMissPromptNative(mod);
    expect(getMissPromptNative()).toBe(mod);
  });
});
