import { beforeEach, describe, expect, it } from "vitest";
import type { Item, Week } from "@timeblocker/scheduling-engine";
import type {
  CalendarEvent,
  SoloBlock,
} from "@timeblocker/calendar-integration";
import {
  buildNothingFitsAlert,
  runPlanning,
  weekIdOf,
  type BlocksWriter,
  type CalendarPort,
  type ItemsReader,
  type PersistedBlock,
  type PlanningDeps,
  type PlanningSettings,
  type SettingsReader,
} from "../lambda/planning/plan.js";

// A Monday inside the planning week; weekBounds resolves it to Sun 2025-01-05.
const WEEK_OF = "2025-01-06T12:00:00-05:00";
const WEEK_ID = "2025-01-05";
// Plan from the very start of the week so nothing is cut by `now`.
const NOW = "2025-01-05T00:00:00-05:00";

// --- In-memory fakes for the injected ports --------------------------------

class FakeItems implements ItemsReader {
  constructor(private readonly items: Item[]) {}
  seenWeekId?: string;
  async readConfirmedItems(weekId: string) {
    this.seenWeekId = weekId;
    return this.items;
  }
}

class FakeSettings implements SettingsReader {
  constructor(private readonly settings: PlanningSettings) {}
  async readSettings() {
    return this.settings;
  }
}

class FakeCalendar implements CalendarPort {
  written: SoloBlock[][] = [];
  constructor(private readonly events: CalendarEvent[] = []) {}
  seenWeek?: Week;
  async readWeek(week: Week) {
    this.seenWeek = week;
    return this.events;
  }
  async writeBlocks(blocks: SoloBlock[]) {
    this.written.push(blocks);
    // Deterministic ids echoing input order.
    return blocks.map((_, i) => `cal-event-${i}`);
  }
}

class FakeBlocks implements BlocksWriter {
  saved: PersistedBlock[] = [];
  async saveBlocks(blocks: PersistedBlock[]) {
    this.saved.push(...blocks);
  }
}

interface ItemSpec {
  id: string;
  durationMin: number;
  priority: number;
  category?: Item["category"];
  text?: string;
}

function makeItemsList(specs: ItemSpec[]): Item[] {
  return specs.map((s) => ({
    id: s.id,
    text: s.text ?? s.id,
    durationMin: s.durationMin,
    priority: s.priority,
    category: s.category ?? "work",
  }));
}

function makeDeps(opts: {
  items: ItemSpec[];
  settings?: PlanningSettings;
  events?: CalendarEvent[];
}): {
  deps: PlanningDeps;
  calendar: FakeCalendar;
  blocks: FakeBlocks;
  items: FakeItems;
} {
  const items = new FakeItems(makeItemsList(opts.items));
  const calendar = new FakeCalendar(opts.events ?? []);
  const blocks = new FakeBlocks();
  const settings = new FakeSettings(
    opts.settings ?? { planningMode: "earliest-fit", holidays: [] },
  );
  return { deps: { items, settings, calendar, blocks }, calendar, blocks, items };
}

describe("runPlanning", () => {
  describe("placement (R2.1, R2.2)", () => {
    let result: Awaited<ReturnType<typeof runPlanning>>;
    let calendar: FakeCalendar;
    let blocks: FakeBlocks;
    let items: FakeItems;

    beforeEach(async () => {
      const made = makeDeps({
        items: [
          { id: "a", durationMin: 60, priority: 1, category: "work" },
          { id: "b", durationMin: 45, priority: 2, category: "self-care" },
        ],
      });
      calendar = made.calendar;
      blocks = made.blocks;
      items = made.items;
      result = await runPlanning({ weekOf: WEEK_OF, now: NOW }, made.deps);
    });

    it("plans the Sunday-Saturday week the date falls in", () => {
      expect(result.weekId).toBe(WEEK_ID);
      expect(weekIdOf(result.week)).toBe(WEEK_ID);
      expect(items.seenWeekId).toBe(WEEK_ID);
      expect(calendar.seenWeek).toEqual(result.week);
    });

    it("places both items and leaves nothing unplaced", () => {
      expect(result.placed.map((p) => p.item.id).sort()).toEqual(["a", "b"]);
      expect(result.unplaced).toEqual([]);
    });

    it("writes each placed block to the calendar as a solo block", () => {
      expect(calendar.written).toHaveLength(1);
      const written = calendar.written[0];
      expect(written).toHaveLength(2);
      for (const block of written) {
        expect(block.title).toBeTruthy();
        expect(block.start).toBeTruthy();
        expect(block.end).toBeTruthy();
      }
    });

    it("persists a scheduled block per placement with the calendar event id", () => {
      expect(blocks.saved).toHaveLength(2);
      for (const block of blocks.saved) {
        expect(block.status).toBe("scheduled");
        expect(block.weekId).toBe(WEEK_ID);
        expect(block.calendarEventId).toMatch(/^cal-event-\d+$/);
        expect(block.id).toContain(block.itemId);
      }
    });

    it("omits the nothing-fits alert when everything fits (R2.3)", () => {
      expect(result.alert).toBeUndefined();
    });

    it("reports the configured planning mode (R2.2)", () => {
      expect(result.mode).toBe("earliest-fit");
    });
  });

  describe("spread mode flows through (R2.2)", () => {
    it("uses the settings planning mode", async () => {
      const made = makeDeps({
        items: [{ id: "a", durationMin: 60, priority: 1, category: "work" }],
        settings: { planningMode: "spread", holidays: [] },
      });
      const result = await runPlanning({ weekOf: WEEK_OF, now: NOW }, made.deps);
      expect(result.mode).toBe("spread");
      expect(result.placed).toHaveLength(1);
    });
  });

  describe("nothing-fits alert (R2.3)", () => {
    let result: Awaited<ReturnType<typeof runPlanning>>;
    let calendar: FakeCalendar;
    let blocks: FakeBlocks;

    beforeEach(async () => {
      const made = makeDeps({
        items: [
          // Fits easily.
          { id: "fits", durationMin: 60, priority: 1, category: "work" },
          // Far larger than any single free window in the week -> unplaceable.
          { id: "huge", durationMin: 1000, priority: 2, category: "work" },
        ],
      });
      calendar = made.calendar;
      blocks = made.blocks;
      result = await runPlanning({ weekOf: WEEK_OF, now: NOW }, made.deps);
    });

    it("returns the oversized item as unplaced and never forces it", () => {
      expect(result.placed.map((p) => p.item.id)).toEqual(["fits"]);
      expect(result.unplaced.map((i) => i.id)).toEqual(["huge"]);
    });

    it("includes the shrink/drop/roll alert for unplaced items", () => {
      expect(result.alert).toBeDefined();
      expect(result.alert?.options).toEqual([
        "shrink",
        "drop",
        "roll-to-next-week",
      ]);
      expect(result.alert?.items.map((i) => i.id)).toEqual(["huge"]);
      expect(result.alert?.message).toMatch(/shrink/i);
      expect(result.alert?.message).toMatch(/drop/i);
      expect(result.alert?.message).toMatch(/next week/i);
    });

    it("still writes and persists only the items that were placed", () => {
      expect(calendar.written[0]).toHaveLength(1);
      expect(blocks.saved).toHaveLength(1);
      expect(blocks.saved[0].itemId).toBe("fits");
    });
  });

  describe("no placeable items", () => {
    it("writes nothing and returns empty placed/unplaced with no alert", async () => {
      const made = makeDeps({ items: [] });
      const result = await runPlanning(
        { weekOf: WEEK_OF, now: NOW },
        made.deps,
      );
      expect(result.placed).toEqual([]);
      expect(result.unplaced).toEqual([]);
      expect(result.alert).toBeUndefined();
      expect(made.calendar.written).toEqual([]);
      expect(made.blocks.saved).toEqual([]);
    });
  });

  describe("real calendar events reduce free time (R2.1)", () => {
    it("does not place a block over a real meeting", async () => {
      // A meeting spanning the whole Sunday schedulable window.
      const sundayMeeting: CalendarEvent = {
        id: "m1",
        summary: "All-day offsite",
        start: "2025-01-05T15:00:00.000Z", // 10:00 Toronto
        end: "2025-01-05T23:00:00.000Z", // 18:00 Toronto
        withOthers: true,
      };
      const made = makeDeps({
        items: [{ id: "a", durationMin: 60, priority: 1, category: "work" }],
        events: [sundayMeeting],
      });
      const result = await runPlanning(
        { weekOf: WEEK_OF, now: NOW },
        made.deps,
      );
      // It still gets placed, but never inside the meeting window.
      const slot = result.placed[0]?.slot;
      expect(slot).toBeDefined();
      const start = new Date(slot!.start).getTime();
      const end = new Date(slot!.end).getTime();
      const mStart = new Date(sundayMeeting.start).getTime();
      const mEnd = new Date(sundayMeeting.end).getTime();
      const overlaps = start < mEnd && end > mStart;
      expect(overlaps).toBe(false);
    });
  });
});

describe("buildNothingFitsAlert", () => {
  it("lists the three resolutions and the offending items (R2.3)", () => {
    const alert = buildNothingFitsAlert([
      {
        id: "x",
        text: "x",
        durationMin: 999,
        priority: 1,
        category: "work",
      },
    ]);
    expect(alert.options).toEqual(["shrink", "drop", "roll-to-next-week"]);
    expect(alert.items).toHaveLength(1);
  });
});
