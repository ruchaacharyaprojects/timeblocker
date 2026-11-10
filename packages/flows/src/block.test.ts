import { describe, expect, it } from "vitest";
import {
  BLOCK_STATUSES,
  isBlockStatus,
  type BlockStatus,
  type PersistedBlock,
} from "./index.js";

describe("BlockStatus", () => {
  it("lists exactly the unified statuses, including legacy moved", () => {
    expect([...BLOCK_STATUSES].sort()).toEqual(
      [
        "done",
        "in-progress",
        "missed",
        "moved",
        "partial",
        "rolled",
        "scheduled",
        "skipped",
      ],
    );
    expect(new Set(BLOCK_STATUSES).size).toBe(BLOCK_STATUSES.length);
  });

  it("isBlockStatus accepts every status", () => {
    for (const s of BLOCK_STATUSES) expect(isBlockStatus(s)).toBe(true);
  });

  it("isBlockStatus rejects unknown values", () => {
    for (const v of ["", "Scheduled", "inprogress", "cancelled", 1, null, undefined, {}]) {
      expect(isBlockStatus(v)).toBe(false);
    }
  });
});

describe("PersistedBlock", () => {
  it("accepts each shape the three former infra copies produced", () => {
    // planning: status scheduled with a calendar event id
    const planned: PersistedBlock = {
      id: "2025-01-12#i1",
      itemId: "i1",
      start: "2025-01-15T19:00:00-05:00",
      end: "2025-01-15T19:30:00-05:00",
      category: "work",
      calendarEventId: "cal-1",
      status: "scheduled",
      weekId: "2025-01-12",
    };
    // reschedule: legacy moved with title/color
    const moved: PersistedBlock = {
      ...planned,
      status: "moved",
      color: "9",
      title: "Deep work",
    };
    // review: no calendar event id, carries moveReason
    const reviewed: PersistedBlock = {
      id: "b2",
      itemId: "i2",
      start: planned.start,
      end: planned.end,
      category: "fitness",
      status: "rolled",
      weekId: "2025-01-12",
      moveReason: "Nothing fit this week",
    };
    const statuses: BlockStatus[] = [planned.status, moved.status, reviewed.status];
    expect(statuses.every(isBlockStatus)).toBe(true);
  });
});
