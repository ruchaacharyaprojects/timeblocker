import { NEXT_WEEK_LIST_PROMPT, ROLLED_DEFAULT_REASON } from "@timeblocker/flows";
import type { Category } from "@timeblocker/scheduling-engine";
import { describe, expect, it } from "vitest";
import type { DeviceBlock } from "../models.js";
import { KEYS, Repositories } from "../repositories.js";
import { FakeClock, FakeUsageSource, MemoryKeyValueStore } from "../testkit.js";
import { weekOfId } from "./planning.js";
import { ReviewService, reviewUsageWindow } from "./review.js";

const WEEK = "2025-07-06";
/** Saturday 2025-07-12 18:00 in Toronto (EDT). */
const NOW = "2025-07-12T22:00:00.000Z";
const MIN = 60_000;

let seq = 0;
function block(
  id: string,
  status: DeviceBlock["status"],
  category: Category = "work",
  overrides: Partial<DeviceBlock> = {},
): DeviceBlock {
  seq += 1;
  return {
    id,
    itemId: `item-${id}`,
    weekId: WEEK,
    title: `Block ${id}`,
    category,
    start: "2025-07-08T14:00:00.000Z",
    end: "2025-07-08T15:00:00.000Z",
    status,
    calendarEventId: `tb0000000${seq % 10}`,
    calendarSynced: true,
    promptedMeetingIds: [],
    usagePrompted: false,
    updatedAt: 1,
    ...overrides,
  };
}

function setup(usage = new FakeUsageSource()) {
  const kv = new MemoryKeyValueStore();
  const repos = new Repositories(kv);
  const clock = new FakeClock(NOW);
  const service = new ReviewService({ repos, clock, usage });
  return { kv, repos, clock, usage, service };
}

describe("ReviewService.build", () => {
  it("classifies the week's blocks and persists the review to reviews:<weekId> (R9.1, R9.3, R9.4)", async () => {
    const { kv, repos, service } = setup();
    await repos.blocks.save(WEEK, [
      block("done", "done"),
      block("inprog", "in-progress"),
      block("partial", "partial"),
      block("skipped", "skipped"),
      block("never", "scheduled"),
      block("rolled", "rolled", "misc", { moveReason: "Didn't fit this week" }),
      block("later", "scheduled", "work", {
        start: "2025-07-13T01:00:00.000Z",
        end: "2025-07-13T02:00:00.000Z",
      }),
    ]);

    const { review, weekId } = await service.build(WEEK);

    expect(weekId).toBe(WEEK);
    expect(review.weekId).toBe(WEEK);
    expect(review.finished.map((e) => e.blockId).sort()).toEqual(["done", "inprog"]);
    expect(review.partial.map((e) => e.blockId)).toEqual(["partial"]);
    expect(review.missed.map((e) => e.blockId).sort()).toEqual(["never", "skipped"]);
    expect(review.movedToNextWeek).toEqual([
      expect.objectContaining({ blockId: "rolled", reason: ROLLED_DEFAULT_REASON }),
    ]);
    expect(review.photoPrompt).toBe(NEXT_WEEK_LIST_PROMPT);

    expect(kv.data.has(KEYS.reviews(WEEK))).toBe(true);
    expect(await repos.reviews.get(WEEK)).toEqual(review);
    expect(await service.get(WEEK)).toEqual(review);
  });

  it("persists un-happened workouts as missed and never rolls them (R8.1)", async () => {
    const { kv, repos, service } = setup();
    await repos.blocks.save(WEEK, [
      block("gym-never", "scheduled", "fitness"),
      block("gym-skip", "skipped", "fitness"),
      block("gym-rolled", "rolled", "fitness", { moveReason: "Didn't fit this week" }),
      block("gym-done", "done", "fitness"),
      block("work-never", "scheduled", "work"),
    ]);
    const writesBefore = kv.writes;

    const result = await service.build(WEEK);

    // Blocks and review land in one atomic setMany.
    expect(kv.writes).toBe(writesBefore + 1);
    expect(result.fitnessMissed.map((b) => b.id).sort()).toEqual([
      "gym-never",
      "gym-rolled",
      "gym-skip",
    ]);
    expect(result.review.fitnessMissedCount).toBe(3);
    expect(result.review.movedToNextWeek).toEqual([]);

    const stored = new Map((await repos.blocks.get(WEEK)).map((b) => [b.id, b]));
    for (const id of ["gym-never", "gym-skip", "gym-rolled"]) {
      expect(stored.get(id)!.status).toBe("missed");
      expect(stored.get(id)!.updatedAt).toBe(Date.parse(NOW));
      // Sync fields are preserved.
      expect(stored.get(id)!.calendarEventId).toMatch(/^tb/);
    }
    expect(stored.get("gym-done")!.status).toBe("done");
    // Non-fitness never-happened blocks are shown missed but not rewritten.
    expect(stored.get("work-never")!.status).toBe("scheduled");
    // Nothing queued for the calendar.
    expect(await repos.outbox.get()).toEqual([]);
  });

  it("is idempotent: a second pass marks nothing new and only rewrites the review", async () => {
    const { kv, repos, service } = setup();
    await repos.blocks.save(WEEK, [block("gym", "scheduled", "fitness")]);

    await service.build(WEEK);
    const blocksAfterFirst = kv.data.get(KEYS.blocks(WEEK));
    const second = await service.build(WEEK);

    expect(second.fitnessMissed).toEqual([]);
    expect(second.review.missed.map((e) => e.blockId)).toEqual(["gym"]);
    expect(kv.data.get(KEYS.blocks(WEEK))).toBe(blocksAfterFirst);
  });

  it("counts the built-in distraction apps with an empty user list (R30.3)", async () => {
    const usage = new FakeUsageSource([
      { packageName: "com.instagram.android", foregroundTimeMs: 90 * MIN },
      { packageName: "com.google.android.apps.docs", foregroundTimeMs: 60 * MIN },
    ]);
    const { service } = setup(usage);
    const { review } = await service.build(WEEK);
    expect(review.screenTimeMin).toBe(150);
    expect(review.distractionLevel).toBe("high");
  });
  it("composes screen time and distraction level on device from the week window (R9.2, R12.9)", async () => {
    const usage = new FakeUsageSource([
      { packageName: "com.instagram.android", foregroundTimeMs: 90 * MIN },
      { packageName: "com.google.android.apps.docs", foregroundTimeMs: 60 * MIN },
    ]);
    const { kv, repos, service } = setup(usage);
    await repos.settings.save({
      planningMode: "earliest-fit",
      holidays: [],
      distractionApps: ["com.instagram.android"],
    });

    const { review, usage: outcome } = await service.build(WEEK);

    expect(outcome).toBe("ok");
    expect(review.screenTimeMin).toBe(150);
    expect(review.distractionLevel).toBe("high"); // 0.6 ratio
    expect(usage.reads).toEqual([
      { startMs: Date.parse(weekOfId(WEEK).sunday), endMs: Date.parse(NOW) },
    ]);
    // Raw per-app usage is never persisted.
    const stored = JSON.stringify(kv.snapshot());
    expect(stored).not.toContain("com.google.android.apps.docs");
    expect(kv.data.get(KEYS.reviews(WEEK))).not.toContain("instagram");
  });

  it("shows zero screen time without usage permission and reads nothing", async () => {
    const usage = new FakeUsageSource(
      [{ packageName: "com.instagram.android", foregroundTimeMs: 90 * MIN }],
      "denied",
    );
    const { service } = setup(usage);

    const result = await service.build(WEEK);

    expect(result.usage).toBe("permission-denied");
    expect(result.review.screenTimeMin).toBe(0);
    expect(result.review.distractionLevel).toBe("low");
    expect(usage.reads).toEqual([]);
  });

  it("defaults to the current Toronto week", async () => {
    const { service } = setup();
    expect(service.currentWeekId()).toBe(WEEK);
    expect((await service.build()).weekId).toBe(WEEK);
  });
});

describe("reviewUsageWindow", () => {
  const week = weekOfId(WEEK);
  const sunday = Date.parse(week.sunday);
  const end = Date.parse(week.saturday);

  it("runs from Sunday to now during the week", () => {
    expect(reviewUsageWindow(week, Date.parse(NOW))).toEqual({
      startMs: sunday,
      endMs: Date.parse(NOW),
    });
  });

  it("caps at the week's end and is empty before the week starts", () => {
    expect(reviewUsageWindow(week, end + 86_400_000)).toEqual({ startMs: sunday, endMs: end });
    expect(reviewUsageWindow(week, sunday - 1)).toEqual({ startMs: sunday, endMs: sunday });
  });
});
