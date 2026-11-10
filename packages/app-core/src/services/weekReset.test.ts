import type { IntakeItem } from "@timeblocker/flows";
import { describe, expect, it, vi } from "vitest";
import type { DeviceBlock, DeviceBlockStatus } from "../models.js";
import { Repositories } from "../repositories.js";
import { FakeClock, MemoryKeyValueStore } from "../testkit.js";
import { WeekResetService } from "./weekReset.js";

const WEEK = "2025-07-06";
/** Wednesday 2025-07-09 12:00 Toronto. */
const NOW = "2025-07-09T16:00:00.000Z";
const PAST = "2025-07-08T14:00:00.000Z";
const FUTURE = "2025-07-10T14:00:00.000Z";

const item = (id: string, extra: Partial<IntakeItem> = {}): IntakeItem => ({
  id,
  text: id,
  durationMin: 60,
  priority: 2,
  category: "work",
  confirmed: true,
  weekId: WEEK,
  ...extra,
});

const block = (
  id: string,
  status: DeviceBlockStatus,
  start: string,
  extra: Partial<DeviceBlock> = {},
): DeviceBlock => ({
  id,
  itemId: `i-${id}`,
  title: id,
  start,
  end: new Date(Date.parse(start) + 3_600_000).toISOString(),
  category: "work",
  status,
  weekId: WEEK,
  calendarEventId: `ev${id}`,
  calendarSynced: true,
  promptedMeetingIds: [],
  usagePrompted: false,
  updatedAt: 0,
  ...extra,
});

function setup() {
  const repos = new Repositories(new MemoryKeyValueStore());
  const clock = new FakeClock(NOW);
  const notifications = { reconcile: vi.fn(async () => undefined) };
  const flusher = { flush: vi.fn(async () => undefined) };
  const service = new WeekResetService({ repos, clock, notifications, flusher });
  return { repos, notifications, flusher, service };
}

async function seed(repos: Repositories, blocks: DeviceBlock[], extraItems: IntakeItem[] = []) {
  await repos.items.save(WEEK, [...blocks.map((b) => item(b.itemId)), ...extraItems]);
  await repos.blocks.save(WEEK, blocks);
}

describe("WeekResetService.clear", () => {
  it("removes unplaced and future scheduled; keeps history and started blocks", async () => {
    const { repos, service, notifications, flusher } = setup();
    const kept = [
      block("done", "done", PAST),
      block("partial", "partial", PAST),
      block("missed", "missed", PAST),
      block("skipped", "skipped", FUTURE),
      block("prog", "in-progress", FUTURE),
      block("started", "scheduled", PAST),
      block("rolled", "rolled", FUTURE),
    ];
    const removed = [block("f1", "scheduled", FUTURE), block("f2", "scheduled", FUTURE, { calendarSynced: false })];
    await seed(repos, [...kept, ...removed], [item("loose")]);
    await repos.intakeDraft.save({ text: "draft" } as never);
    await repos.outbox.enqueue({ blockId: "f2", calendarEventId: "evf2", op: "upsert", enqueuedAt: 1 });

    const res = await service.clear(WEEK);
    expect(res).toEqual({ removedTasks: 3, keptAsHistory: 7 });
    expect((await repos.blocks.get(WEEK)).map((b) => b.id)).toEqual(kept.map((b) => b.id));
    expect((await repos.items.get(WEEK)).map((i) => i.id).sort()).toEqual(
      kept.map((b) => b.itemId).sort(),
    );
    const outbox = await repos.outbox.get();
    expect(outbox.map((w) => [w.blockId, w.op, w.calendarEventId]).sort()).toEqual([
      ["f1", "delete", "evf1"],
      ["f2", "delete", "evf2"],
    ]);
    expect(await repos.intakeDraft.get()).toBeNull();
    expect(notifications.reconcile).toHaveBeenCalledTimes(1);
    expect(flusher.flush).toHaveBeenCalledTimes(1);
  });

  it("drops the undo token and open prompts of removed blocks only", async () => {
    const { repos, service } = setup();
    await seed(repos, [block("f1", "scheduled", FUTURE), block("d", "done", PAST)]);
    await repos.undo.save({
      blockId: "f1", weekId: WEEK, calendarEventId: "evf1",
      previous: { start: PAST, end: PAST }, previousStatus: "scheduled",
      movedTo: { start: FUTURE, end: FUTURE }, expiresAt: Date.parse(NOW) + 1000,
    });
    await repos.openPrompts.save([
      { promptId: "p1", blockId: "f1", meetingIds: [], shownAt: 1 },
      { promptId: "p2", blockId: "d", meetingIds: [], shownAt: 1 },
    ]);
    await service.clear(WEEK);
    expect(await repos.undo.get()).toBeNull();
    expect((await repos.openPrompts.get()).map((p) => p.promptId)).toEqual(["p2"]);
  });

  it("handles an empty week and is idempotent", async () => {
    const { repos, service, flusher } = setup();
    expect(await service.clear(WEEK)).toEqual({ removedTasks: 0, keptAsHistory: 0 });
    await seed(repos, [block("f1", "scheduled", FUTURE), block("d", "done", PAST)]);
    expect(await service.clear(WEEK)).toEqual({ removedTasks: 1, keptAsHistory: 1 });
    expect(await service.clear(WEEK)).toEqual({ removedTasks: 0, keptAsHistory: 1 });
    expect(flusher.flush).toHaveBeenCalledTimes(1);
    expect((await repos.outbox.get()).filter((w) => w.op === "delete")).toHaveLength(1);
  });

  it("does not throw when reconcile or flush fail", async () => {
    const { repos, service, notifications, flusher } = setup();
    notifications.reconcile.mockRejectedValue(new Error("boom"));
    flusher.flush.mockRejectedValue(new Error("boom"));
    await seed(repos, [block("f1", "scheduled", FUTURE)]);
    await expect(service.clear(WEEK)).resolves.toEqual({ removedTasks: 1, keptAsHistory: 0 });
  });

  it("regression: 14 items, 12 blocks, 2 unplaced", async () => {
    const { repos, service } = setup();
    const blocks = [
      ...["a", "b", "c", "d", "e"].map((id) => block(id, "done", PAST)),
      block("m", "missed", PAST),
      block("s", "scheduled", PAST),
      ...["f1", "f2", "f3", "f4", "f5"].map((id) => block(id, "scheduled", FUTURE)),
    ];
    expect(blocks).toHaveLength(12);
    await seed(repos, blocks, [
      item("project", { durationMin: 360 }),
      item("gym3", { text: "Gym 3 of 3", seriesId: "gym", seriesIndex: 3, seriesSize: 3 }),
    ]);
    expect((await repos.items.get(WEEK))).toHaveLength(14);
    const res = await service.clear(WEEK);
    expect(res).toEqual({ removedTasks: 7, keptAsHistory: 7 });
    const left = await repos.items.get(WEEK);
    expect(left).toHaveLength(7);
    expect(left.some((i) => i.id === "project" || i.id === "gym3")).toBe(false);
    expect(await repos.blocks.get(WEEK)).toHaveLength(7);
  });
});
