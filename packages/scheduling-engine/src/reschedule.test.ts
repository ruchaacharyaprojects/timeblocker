import { describe, it, expect } from "vitest";
import { weekBounds, reschedule } from "./engine.js";
import { NO_FIT, type Block, type Constraints, type BusyEvent } from "./types.js";
import { tor, busy } from "./testkit.js";

const WEEK = weekBounds(tor(2025, 1, 15, 12, 0));
const NO_HOLIDAYS: Constraints = { holidays: [] };

function block(
  id: string,
  startIso: string,
  endIso: string,
  category: Block["category"] = "misc",
): Block {
  return { id, itemId: id, start: startIso, end: endIso, category };
}

describe("R6.2 reschedule to the next valid slot in the same week", () => {
  it("moves a block forward to the next free slot", () => {
    // Block Wednesday 19:00-19:30; busy occupies 19:00-20:00 so it must move.
    const b = block("b1", tor(2025, 1, 15, 19, 0), tor(2025, 1, 15, 19, 30));
    const busyEvents: BusyEvent[] = [busy(2025, 1, 15, 19, 0, 20, 0)];
    const slot = reschedule(b, WEEK, busyEvents, NO_HOLIDAYS);
    expect(slot).not.toBe(NO_FIT);
    if (slot !== NO_FIT) {
      // Next slot must start at or after the busy window end.
      expect(new Date(slot.start).getTime()).toBeGreaterThanOrEqual(
        new Date(tor(2025, 1, 15, 20, 0)).getTime(),
      );
      // Duration preserved (30 min).
      const mins =
        (new Date(slot.end).getTime() - new Date(slot.start).getTime()) / 60000;
      expect(mins).toBe(30);
    }
  });

  it("keeps the rescheduled slot within the Sunday-Saturday week", () => {
    const b = block("b2", tor(2025, 1, 17, 19, 0), tor(2025, 1, 17, 20, 0));
    const slot = reschedule(b, WEEK, [], NO_HOLIDAYS);
    expect(slot).not.toBe(NO_FIT);
    if (slot !== NO_FIT) {
      expect(new Date(slot.start).getTime()).toBeGreaterThanOrEqual(
        new Date(WEEK.sunday).getTime(),
      );
      expect(new Date(slot.end).getTime()).toBeLessThanOrEqual(
        new Date(WEEK.saturday).getTime(),
      );
    }
  });

  it("does not collide with its own current time when excluded by id", () => {
    const b = block("self", tor(2025, 1, 15, 19, 0), tor(2025, 1, 15, 19, 30));
    // The block itself is in the busy list (same id) and should be ignored.
    const busyEvents: BusyEvent[] = [
      { id: "self", start: b.start, end: b.end },
    ];
    const slot = reschedule(b, WEEK, busyEvents, NO_HOLIDAYS);
    expect(slot).not.toBe(NO_FIT);
    if (slot !== NO_FIT) {
      // Must move strictly forward from the original start.
      expect(new Date(slot.start).getTime()).toBeGreaterThan(
        new Date(b.start).getTime(),
      );
    }
  });
});

describe("R6.3 no valid slot -> no-fit", () => {
  it('returns "no-fit" when the whole remaining week is busy', () => {
    // Block on Saturday night; fill the remaining Saturday window entirely.
    const b = block("late", tor(2025, 1, 18, 20, 0), tor(2025, 1, 18, 20, 30));
    const busyEvents: BusyEvent[] = [
      busy(2025, 1, 18, 10, 0, 21, 0), // whole weekend window
    ];
    const slot = reschedule(b, WEEK, busyEvents, NO_HOLIDAYS);
    expect(slot).toBe(NO_FIT);
  });

  it('returns "no-fit" for a block longer than any free window', () => {
    const b = block("huge", tor(2025, 1, 18, 10, 0), tor(2025, 1, 18, 19, 0)); // 9h
    const slot = reschedule(b, WEEK, [], NO_HOLIDAYS);
    expect(slot).toBe(NO_FIT);
  });
});

describe("reschedule is pure", () => {
  it("does not mutate its inputs", () => {
    const b = block("b", tor(2025, 1, 15, 19, 0), tor(2025, 1, 15, 19, 30));
    const busyEvents: BusyEvent[] = [busy(2025, 1, 15, 19, 0, 20, 0)];
    const bCopy = JSON.parse(JSON.stringify(b));
    const busyCopy = JSON.parse(JSON.stringify(busyEvents));
    reschedule(b, WEEK, busyEvents, NO_HOLIDAYS);
    expect(b).toEqual(bCopy);
    expect(busyEvents).toEqual(busyCopy);
  });
});

describe("reschedule options.notBefore (R6.2, R13.4, R13.6)", () => {
  it("never moves a block that has already started into the past", () => {
    // Block Wednesday 19:00-19:30; it is now 19:10, so the block is in progress.
    const b = block("started", tor(2025, 1, 15, 19, 0), tor(2025, 1, 15, 19, 30));
    const now = tor(2025, 1, 15, 19, 10);
    const slot = reschedule(b, WEEK, [], NO_HOLIDAYS, { notBefore: now });
    expect(slot).not.toBe(NO_FIT);
    if (slot !== NO_FIT) {
      expect(new Date(slot.start).getTime()).toBeGreaterThanOrEqual(
        new Date(now).getTime(),
      );
      const mins =
        (new Date(slot.end).getTime() - new Date(slot.start).getTime()) / 60000;
      expect(mins).toBe(30);
    }
  });

  it("uses block.start when notBefore is earlier (same result as no options)", () => {
    const b = block("future", tor(2025, 1, 15, 19, 0), tor(2025, 1, 15, 19, 30));
    const busyEvents: BusyEvent[] = [busy(2025, 1, 15, 19, 0, 20, 0)];
    const withEarly = reschedule(b, WEEK, busyEvents, NO_HOLIDAYS, {
      notBefore: tor(2025, 1, 13, 8, 0),
    });
    expect(withEarly).toEqual(reschedule(b, WEEK, busyEvents, NO_HOLIDAYS));
  });

  it('returns "no-fit" when notBefore is past the end of the week', () => {
    const b = block("b", tor(2025, 1, 15, 19, 0), tor(2025, 1, 15, 19, 30));
    const afterWeek = new Date(new Date(WEEK.saturday).getTime() + 60000).toISOString();
    const slot = reschedule(b, WEEK, [], NO_HOLIDAYS, { notBefore: afterWeek });
    expect(slot).toBe(NO_FIT);
  });
});
