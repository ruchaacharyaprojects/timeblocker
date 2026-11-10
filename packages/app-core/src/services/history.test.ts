import type { CalendarEvent } from "@timeblocker/calendar-integration";
import { describe, expect, it } from "vitest";
import type { DeviceBlock } from "../models.js";
import { Repositories } from "../repositories.js";
import { FakeClock, MemoryKeyValueStore } from "../testkit.js";
import { HISTORY_WEEKS, HistoryReader, shiftWeekId } from "./history.js";

const WEEK = "2025-07-06";
const MIN = 60_000;

function block(id: string, weekId: string, startIso: string, minutes: number, extra: Partial<DeviceBlock> = {}): DeviceBlock {
  const start = Date.parse(startIso);
  return {
    id,
    itemId: `i-${id}`,
    title: `T ${id}`,
    start: startIso,
    end: new Date(start + minutes * MIN).toISOString(),
    category: "work",
    status: "done",
    weekId,
    calendarEventId: `tb${id}`,
    calendarSynced: true,
    promptedMeetingIds: [],
    usagePrompted: false,
    updatedAt: 0,
    ...extra,
  };
}

const event = (id: string, summary: string, startIso: string, hours: number): CalendarEvent => ({
  id,
  summary,
  start: startIso,
  end: new Date(Date.parse(startIso) + hours * 60 * MIN).toISOString(),
  withOthers: false,
});

function setup() {
  const kv = new MemoryKeyValueStore();
  const repos = new Repositories(kv);
  return { repos, reader: new HistoryReader({ repos, clock: new FakeClock(Date.parse("2025-07-08T12:00:00Z")) }) };
}

describe("shiftWeekId", () => {
  it("steps back by Sunday week ids across a DST change", () => {
    expect(shiftWeekId("2025-07-06", 1)).toBe("2025-06-29");
    expect(shiftWeekId("2025-03-16", 1)).toBe("2025-03-09");
    expect(shiftWeekId("2025-03-09", 1)).toBe("2025-03-02");
    expect(shiftWeekId("2025-07-06", -1)).toBe("2025-07-13");
  });
});

describe("HistoryReader.load", () => {
  it("returns empty history when nothing is stored", async () => {
    const { reader } = setup();
    expect(await reader.load(WEEK)).toEqual({ blocks: [], events: [] });
  });

  it("reads the target week and 26 earlier weeks, not the 27th", async () => {
    const { repos, reader } = setup();
    const w26 = shiftWeekId(WEEK, HISTORY_WEEKS);
    const w27 = shiftWeekId(WEEK, HISTORY_WEEKS + 1);
    await repos.blocks.save(WEEK, [block("cur", WEEK, "2025-07-07T14:00:00Z", 30)]);
    await repos.blocks.save(w26, [block("old", w26, "2025-01-07T14:00:00Z", 60)]);
    await repos.blocks.save(w27, [block("older", w27, "2024-12-31T14:00:00Z", 60)]);
    const { blocks } = await reader.load(WEEK);
    expect(blocks.map((b) => b.title)).toEqual(["T cur", "T old"]);
  });

  it("maps blocks, skips untitled ones, and orders most recent first", async () => {
    const { repos, reader } = setup();
    const prev = shiftWeekId(WEEK, 1);
    await repos.blocks.save(prev, [
      block("a", prev, "2025-06-30T14:00:00Z", 45, { category: "fitness", status: "skipped" }),
    ]);
    await repos.blocks.save(WEEK, [
      block("b", WEEK, "2025-07-07T14:00:00Z", 90),
      block("c", WEEK, "2025-07-08T14:00:00Z", 20, { title: "  ", text: "from text" }),
      block("d", WEEK, "2025-07-09T14:00:00Z", 20, { title: "", text: undefined }),
    ]);
    const { blocks } = await reader.load(WEEK);
    expect(blocks).toEqual([
      { title: "from text", category: "work", durationMin: 20, status: "done" },
      { title: "T b", category: "work", durationMin: 90, status: "done" },
      { title: "T a", category: "fitness", durationMin: 45, status: "skipped" },
    ]);
  });

  it("keeps meetings but drops 🧱 events and all-day-like events", async () => {
    const { repos, reader } = setup();
    await repos.calendarCache.save(WEEK, {
      syncedAt: 0,
      events: [
        event("e1", "Standup", "2025-07-07T14:00:00Z", 0.5),
        event("e2", "🧱 Block", "2025-07-07T15:00:00Z", 1),
        { ...event("e3", "Own block", "2025-07-07T16:00:00Z", 1), isBlock: true },
        event("e4", "Conference", "2025-07-07T04:00:00Z", 12),
        event("e5", "Holiday", "2025-07-07T04:00:00Z", 24),
        event("e6", "Long but ok", "2025-07-07T17:00:00Z", 11),
      ],
    });
    const { events } = await reader.load(WEEK);
    expect(events).toEqual([
      { title: "Long but ok", category: "misc", durationMin: 660 },
      { title: "Standup", category: "misc", durationMin: 30 },
    ]);
  });

  it("survives a failing week read", async () => {
    const { repos, reader } = setup();
    const bad = shiftWeekId(WEEK, 2);
    await repos.blocks.save(WEEK, [block("ok", WEEK, "2025-07-07T14:00:00Z", 30)]);
    const originalGet = repos.blocks.get.bind(repos.blocks);
    repos.blocks.get = async (id: string) => {
      if (id === bad) throw new Error("corrupt");
      return originalGet(id);
    };
    const { blocks } = await reader.load(WEEK);
    expect(blocks.map((b) => b.title)).toEqual(["T ok"]);
  });
});

describe("HistoryReader.categoryOutcomes", () => {
  it("returns category and status for each block in the window", async () => {
    const { repos, reader } = setup();
    const prev = shiftWeekId(WEEK, 1);
    const far = shiftWeekId(WEEK, 5);
    await repos.blocks.save(WEEK, [block("a", WEEK, "2025-07-07T14:00:00Z", 30, { status: "missed" })]);
    await repos.blocks.save(prev, [block("b", prev, "2025-06-30T14:00:00Z", 30, { category: "fitness" })]);
    await repos.blocks.save(far, [block("c", far, "2025-06-02T14:00:00Z", 30)]);
    expect(await reader.categoryOutcomes(WEEK)).toEqual([
      { category: "work", status: "missed" },
      { category: "fitness", status: "done" },
      { category: "work", status: "done" },
    ]);
    expect(await reader.categoryOutcomes(WEEK, 1)).toHaveLength(2);
  });
});
