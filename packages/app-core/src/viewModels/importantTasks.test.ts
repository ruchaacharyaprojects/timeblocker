import type { IntakeItem } from "@timeblocker/flows";
import { describe, expect, it } from "vitest";
import type { DeviceBlock, DeviceBlockStatus } from "../models.js";
import { buildImportantTasks, dueLabel } from "./importantTasks.js";

const NOW = Date.parse("2025-03-11T15:00:00Z"); // Tue 11:00 EDT
const H = 3_600_000;
const D = 24 * H;
let seq = 0;
const block = (status: DeviceBlockStatus, dueAt: string | undefined, extra: Partial<DeviceBlock> = {}): DeviceBlock => {
  seq += 1;
  return {
    id: `b${seq}`,
    itemId: `i${seq}`,
    title: `Block ${seq}`,
    start: "2025-03-12T14:00:00Z",
    end: "2025-03-12T15:00:00Z",
    category: "work",
    status,
    weekId: "2025-03-09",
    calendarEventId: `evt${seq}0000`,
    calendarSynced: true,
    promptedMeetingIds: [],
    usagePrompted: false,
    updatedAt: NOW,
    ...(dueAt ? { dueAt } : {}),
    ...extra,
  };
};
const item = (id: string, dueAt: string | undefined, extra: Partial<IntakeItem> = {}): IntakeItem => ({
  id,
  text: `Item ${id}`,
  durationMin: 60,
  priority: 1,
  category: "work",
  confirmed: true,
  weekId: "2025-03-09",
  ...(dueAt ? { dueAt } : {}),
  ...extra,
});
const iso = (ms: number) => new Date(ms).toISOString();
const run = (blocks: DeviceBlock[], items: IntakeItem[] = [], now = NOW) =>
  buildImportantTasks({ now, blocks, items });

describe("buildImportantTasks", () => {
  it("is empty without deadlines", () => {
    expect(run([block("scheduled", undefined)], [item("x", undefined)])).toEqual({ rows: [], moreCount: 0 });
  });

  it.each([
    ["scheduled", true],
    ["in-progress", true],
    ["missed", true],
    ["done", false],
    ["partial", false],
    ["skipped", false],
    ["rolled", false],
  ] as const)("block status %s -> shown=%s", (status, shown) => {
    const b = block(status, iso(NOW + 2 * D));
    expect(run([b]).rows.map((r) => r.id)).toEqual(shown ? [b.id] : []);
  });

  it("builds a block row with a block target", () => {
    const b = block("scheduled", iso(NOW + 2 * H));
    const { rows } = run([b]);
    expect(rows[0]).toEqual({
      id: b.id,
      title: b.title,
      dueAt: b.dueAt,
      dueLabel: "Due today 1:00 PM",
      urgency: "soon",
      target: { kind: "block", blockId: b.id, weekId: "2025-03-09" },
    });
  });

  it("shows an unplaced deadline item with a summary target", () => {
    const { rows } = run([], [item("u1", iso(NOW + 3 * D), { weekId: "2025-03-09" })]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: "u1",
      title: "Item u1",
      urgency: "normal",
      target: { kind: "summary", weekId: "2025-03-09", itemId: "u1" },
    });
  });

  it("ignores unconfirmed items", () => {
    expect(run([], [item("u", iso(NOW + D), { confirmed: false })]).rows).toEqual([]);
  });

  it("does not list an item that has a block (any status)", () => {
    const b = block("scheduled", iso(NOW + D), { itemId: "same" });
    const done = block("done", iso(NOW + D), { itemId: "other" });
    const { rows } = run([b, done], [item("same", iso(NOW + D)), item("other", iso(NOW + D))]);
    expect(rows.map((r) => r.id)).toEqual([b.id]);
  });

  it("does not list a duplicated item twice", () => {
    const it1 = item("dup", iso(NOW + D));
    expect(run([], [it1, it1]).rows).toHaveLength(1);
  });

  it("window edges: -30 days and +21 days inclusive, beyond excluded", () => {
    const rows = run([], [
      item("old-edge", iso(NOW - 30 * D)),
      item("old-out", iso(NOW - 30 * D - 1)),
      item("new-edge", iso(NOW + 21 * D)),
      item("new-out", iso(NOW + 21 * D + 1)),
    ]).rows;
    expect(rows.map((r) => r.id)).toEqual(["old-edge", "new-edge"]);
  });

  it("sorts by due date ascending with overdue first", () => {
    const rows = run([block("scheduled", iso(NOW + 5 * D))], [
      item("late", iso(NOW + 9 * D)),
      item("over", iso(NOW - 2 * D)),
    ]).rows;
    expect(rows.map((r) => r.id)).toEqual(["over", expect.any(String), "late"]);
    expect(rows[0]!.urgency).toBe("overdue");
  });

  it("caps at 3 rows and counts the rest", () => {
    const items = [1, 2, 3, 4, 5].map((n) => item(`m${n}`, iso(NOW + n * D)));
    const r = run([], items);
    expect(r.rows.map((x) => x.id)).toEqual(["m1", "m2", "m3"]);
    expect(r.moreCount).toBe(2);
    expect(run([], items.slice(0, 3)).moreCount).toBe(0);
  });

  it("urgency: overdue at dueAt == now, soon within 24h, else normal", () => {
    const u = (ms: number) => run([], [item("x", iso(ms))]).rows[0]!.urgency;
    expect(u(NOW)).toBe("overdue");
    expect(u(NOW + 1)).toBe("soon");
    expect(u(NOW + D)).toBe("soon");
    expect(u(NOW + D + 1)).toBe("normal");
  });
});

describe("dueLabel", () => {
  it("covers each variant", () => {
    expect(dueLabel(NOW - 1, NOW)).toBe("Overdue");
    expect(dueLabel(NOW, NOW)).toBe("Overdue");
    expect(dueLabel(Date.parse("2025-03-11T21:00:00Z"), NOW)).toBe("Due today 5:00 PM");
    expect(dueLabel(Date.parse("2025-03-12T21:00:00Z"), NOW)).toBe("Due tomorrow 5:00 PM");
    expect(dueLabel(Date.parse("2025-03-14T21:00:00Z"), NOW)).toBe("Due Fri 5:00 PM");
    expect(dueLabel(Date.parse("2025-03-17T21:00:00Z"), NOW)).toBe("Due Mon 5:00 PM"); // +6 days
    expect(dueLabel(Date.parse("2025-03-18T21:00:00Z"), NOW)).toBe("Due Mar 18, 5:00 PM"); // +7 days
    expect(dueLabel(Date.parse("2025-03-31T21:00:00Z"), NOW)).toBe("Due Mar 31, 5:00 PM");
  });

  it("uses Toronto days, not UTC days", () => {
    // 2025-03-12T01:00Z is Mar 11 9:00 PM in Toronto: still today.
    expect(dueLabel(Date.parse("2025-03-12T01:00:00Z"), NOW)).toBe("Due today 9:00 PM");
  });

  it("handles DST: EST before, EDT after the 2025-03-09 change", () => {
    const before = Date.parse("2025-03-07T12:00:00Z"); // Fri 7 EST
    expect(dueLabel(Date.parse("2025-03-08T22:00:00Z"), before)).toBe("Due tomorrow 5:00 PM"); // EST
    expect(dueLabel(Date.parse("2025-03-10T21:00:00Z"), before)).toBe("Due Mon 5:00 PM"); // EDT
  });
});
