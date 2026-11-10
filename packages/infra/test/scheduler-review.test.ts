import { describe, expect, it } from "vitest";
import type { UsageSummary } from "@timeblocker/usage-metrics";
import {
  buildSundayNudge,
  buildWeeklyReview,
  NEXT_WEEK_PHOTO_PROMPT,
  runSaturdayReview,
  runSundayPlanningNudge,
  SUNDAY_NUDGE_BODY,
  SUNDAY_NUDGE_TITLE,
  weekIdOf,
  type NudgeNotification,
  type NudgePort,
  type PersistedBlock,
  type ReviewBlocksReader,
  type ReviewBlocksWriter,
  type ReviewWriter,
  type UsageSummaryReader,
  type WeeklyReview,
} from "../lambda/scheduler/review.js";

// A Saturday evening inside the week; weekBounds resolves it to Sun 2025-01-05.
const NOW = "2025-01-11T18:00:00-05:00";
const WEEK_ID = "2025-01-05";

/** A block earlier in the week (its window is fully in the past at NOW). */
function pastBlock(partial: Partial<PersistedBlock>): PersistedBlock {
  return {
    id: partial.id ?? "blk",
    itemId: partial.itemId ?? "item",
    start: partial.start ?? "2025-01-06T09:00:00-05:00",
    end: partial.end ?? "2025-01-06T10:00:00-05:00",
    category: partial.category ?? "work",
    status: partial.status ?? "scheduled",
    weekId: partial.weekId ?? WEEK_ID,
    title: partial.title,
    text: partial.text,
    moveReason: partial.moveReason,
  };
}

function makeUsage(
  overrides: Partial<UsageSummary> = {},
): UsageSummary {
  return {
    window: { startMs: 0, endMs: 0 },
    totalScreenTimeMin: 320,
    distractionTimeMin: 150,
    distractionRatio: 0.47,
    distractionLevel: "high",
    distractionAppCount: 3,
    ...overrides,
  };
}

// --- In-memory fakes for the injected ports --------------------------------

class FakeBlocks implements ReviewBlocksReader {
  seenWeekId?: string;
  constructor(private readonly rows: PersistedBlock[]) {}
  async readWeekBlocks(weekId: string) {
    this.seenWeekId = weekId;
    return this.rows;
  }
}

class RecordingBlocksWriter implements ReviewBlocksWriter {
  saved: PersistedBlock[] = [];
  async saveBlock(block: PersistedBlock) {
    this.saved.push(block);
  }
}

class RecordingReviewWriter implements ReviewWriter {
  saved: WeeklyReview[] = [];
  async saveReview(review: WeeklyReview) {
    this.saved.push(review);
  }
}

class FakeUsage implements UsageSummaryReader {
  constructor(private readonly summary: UsageSummary | null) {}
  async readWeekSummary() {
    return this.summary;
  }
}

class RecordingNudge implements NudgePort {
  delivered: NudgeNotification[] = [];
  async deliver(notification: NudgeNotification) {
    this.delivered.push(notification);
  }
}

// --- buildWeeklyReview (pure, R9.1) ----------------------------------------

describe("buildWeeklyReview classification (R9.1)", () => {
  it("sorts done/partial/missed blocks into finished/partial/missed", () => {
    const blocks: PersistedBlock[] = [
      pastBlock({ id: "a", status: "done", title: "Ship PR" }),
      pastBlock({ id: "b", status: "partial", title: "Read chapter" }),
      pastBlock({ id: "c", status: "missed", title: "Call dentist" }),
    ];

    const { review } = buildWeeklyReview(WEEK_ID, blocks, makeUsage(), new Date(NOW));

    expect(review.finished.map((e) => e.blockId)).toEqual(["a"]);
    expect(review.partial.map((e) => e.blockId)).toEqual(["b"]);
    expect(review.missed.map((e) => e.blockId)).toEqual(["c"]);
    expect(review.finished[0].title).toBe("Ship PR");
  });

  it("counts a still-scheduled past block as missed (R9.1)", () => {
    const blocks = [pastBlock({ id: "x", status: "scheduled", category: "work" })];

    const { review, fitnessMissed } = buildWeeklyReview(
      WEEK_ID,
      blocks,
      makeUsage(),
      new Date(NOW),
    );

    expect(review.missed.map((e) => e.blockId)).toEqual(["x"]);
    // Non-fitness never-happened blocks are not part of the no-roll contract.
    expect(fitnessMissed).toEqual([]);
  });

  it("leaves a still-scheduled future block unclassified (not yet missed)", () => {
    const future = pastBlock({
      id: "future",
      status: "scheduled",
      start: "2025-01-11T20:00:00-05:00",
      end: "2025-01-11T21:00:00-05:00",
    });

    const { review } = buildWeeklyReview(
      WEEK_ID,
      [future],
      makeUsage(),
      new Date(NOW),
    );

    expect(review.finished).toEqual([]);
    expect(review.partial).toEqual([]);
    expect(review.missed).toEqual([]);
  });
});

describe("buildWeeklyReview moved-with-reason (R9.3)", () => {
  it("lists moved blocks with their recorded reason", () => {
    const blocks = [
      pastBlock({
        id: "m",
        status: "moved",
        title: "Gym",
        moveReason: "Meeting ran over the block start.",
      }),
    ];

    const { review } = buildWeeklyReview(WEEK_ID, blocks, makeUsage(), new Date(NOW));

    expect(review.movedToNextWeek).toHaveLength(1);
    expect(review.movedToNextWeek[0].blockId).toBe("m");
    expect(review.movedToNextWeek[0].reason).toBe(
      "Meeting ran over the block start.",
    );
  });

  it("falls back to a generic reason when none was recorded", () => {
    const blocks = [pastBlock({ id: "m2", status: "moved" })];

    const { review } = buildWeeklyReview(WEEK_ID, blocks, makeUsage(), new Date(NOW));

    expect(review.movedToNextWeek[0].reason).toMatch(/moved/i);
  });
});

describe("buildWeeklyReview fitness-missed-not-rolled (R8.1)", () => {
  it("marks a never-happened workout missed and flags it for no-roll", () => {
    const workout = pastBlock({
      id: "workout",
      status: "scheduled",
      category: "fitness",
      title: "Leg day",
    });

    const { review, fitnessMissed } = buildWeeklyReview(
      WEEK_ID,
      [workout],
      makeUsage(),
      new Date(NOW),
    );

    // Counted as missed in the review (R8.1 "shown in the Saturday review").
    expect(review.missed.map((e) => e.blockId)).toEqual(["workout"]);
    expect(review.fitnessMissedCount).toBe(1);

    // Flagged for the caller to persist as "missed" so it does not roll into
    // next Sunday (R8.1). Its status is already flipped to "missed".
    expect(fitnessMissed).toHaveLength(1);
    expect(fitnessMissed[0].id).toBe("workout");
    expect(fitnessMissed[0].status).toBe("missed");
  });

  it("does not flag a completed workout as missed", () => {
    const workout = pastBlock({
      id: "done-workout",
      status: "done",
      category: "fitness",
    });

    const { review, fitnessMissed } = buildWeeklyReview(
      WEEK_ID,
      [workout],
      makeUsage(),
      new Date(NOW),
    );

    expect(review.finished.map((e) => e.blockId)).toEqual(["done-workout"]);
    expect(review.missed).toEqual([]);
    expect(fitnessMissed).toEqual([]);
  });
});

describe("buildWeeklyReview usage + photo prompt (R9.2, R9.4)", () => {
  it("carries screen time and distraction level from the usage summary", () => {
    const { review } = buildWeeklyReview(
      WEEK_ID,
      [],
      makeUsage({ totalScreenTimeMin: 410, distractionLevel: "moderate" }),
      new Date(NOW),
    );

    expect(review.screenTimeMin).toBe(410);
    expect(review.distractionLevel).toBe("moderate");
  });

  it("defaults screen time to 0 and distraction to low when no summary", () => {
    const { review } = buildWeeklyReview(WEEK_ID, [], null, new Date(NOW));

    expect(review.screenTimeMin).toBe(0);
    expect(review.distractionLevel).toBe("low");
  });

  it("always includes the next-week paste/type list prompt (R9.4)", () => {
    const { review } = buildWeeklyReview(WEEK_ID, [], null, new Date(NOW));
    expect(review.photoPrompt).toBe(NEXT_WEEK_PHOTO_PROMPT);
    expect(NEXT_WEEK_PHOTO_PROMPT).toBe("Paste or type next week's to-do list");
    expect(NEXT_WEEK_PHOTO_PROMPT).not.toMatch(/photo/i);
  });
});

// --- runSaturdayReview (orchestration) -------------------------------------

describe("runSaturdayReview (R8.1, R9)", () => {
  it("compiles the review, persists it, and persists fitness misses only", async () => {
    const blocks = new FakeBlocks([
      pastBlock({ id: "done", status: "done" }),
      pastBlock({ id: "workout", status: "scheduled", category: "fitness" }),
      pastBlock({ id: "chore", status: "scheduled", category: "misc" }),
    ]);
    const blocksWriter = new RecordingBlocksWriter();
    const reviews = new RecordingReviewWriter();
    const usage = new FakeUsage(makeUsage());

    const review = await runSaturdayReview(
      { now: NOW },
      { blocks, blocksWriter, reviews, usage },
    );

    // Reads the correct Sunday-Saturday week.
    expect(blocks.seenWeekId).toBe(WEEK_ID);

    // Review persisted exactly once.
    expect(reviews.saved).toHaveLength(1);
    expect(reviews.saved[0]).toBe(review);
    expect(review.weekId).toBe(WEEK_ID);

    // Only the fitness miss is persisted back as "missed" (R8.1); the misc
    // never-happened block is surfaced as missed but not rewritten.
    expect(blocksWriter.saved.map((b) => b.id)).toEqual(["workout"]);
    expect(blocksWriter.saved[0].status).toBe("missed");

    // Both never-happened blocks are missed in the review; the done one is not.
    expect(review.missed.map((e) => e.blockId).sort()).toEqual([
      "chore",
      "workout",
    ]);
    expect(review.finished.map((e) => e.blockId)).toEqual(["done"]);
  });

  it("persists no block changes when no fitness block was missed", async () => {
    const blocks = new FakeBlocks([pastBlock({ id: "done", status: "done" })]);
    const blocksWriter = new RecordingBlocksWriter();
    const reviews = new RecordingReviewWriter();

    await runSaturdayReview(
      { now: NOW },
      { blocks, blocksWriter, reviews, usage: new FakeUsage(null) },
    );

    expect(blocksWriter.saved).toEqual([]);
    expect(reviews.saved).toHaveLength(1);
    expect(reviews.saved[0].screenTimeMin).toBe(0);
  });
});

// --- Sunday planning nudge (R9) --------------------------------------------

describe("runSundayPlanningNudge (R9)", () => {
  it("delivers the Sunday planning nudge for the current week", async () => {
    const nudge = new RecordingNudge();

    // A Sunday morning; weekBounds resolves it to the same week's Sunday.
    const sundayNow = "2025-01-05T08:00:00-05:00";
    const notification = await runSundayPlanningNudge(
      { now: sundayNow },
      { nudge },
    );

    expect(nudge.delivered).toHaveLength(1);
    expect(notification.id).toBe("sunday-nudge:2025-01-05");
    expect(notification.title).toBe(SUNDAY_NUDGE_TITLE);
    expect(notification.body).toBe(SUNDAY_NUDGE_BODY);
    expect(SUNDAY_NUDGE_BODY).toMatch(/paste or type/i);
    expect(SUNDAY_NUDGE_BODY).not.toMatch(/photo/i);
    expect(nudge.delivered[0]).toEqual(notification);
  });

  it("buildSundayNudge is pure and week-scoped", () => {
    const n = buildSundayNudge("2025-02-02");
    expect(n.id).toBe("sunday-nudge:2025-02-02");
    expect(n.title).toBe(SUNDAY_NUDGE_TITLE);
  });

  it("weekIdOf returns the Sunday date portion", () => {
    expect(
      weekIdOf({ sunday: "2025-01-05T00:00:00-05:00", saturday: "x" }),
    ).toBe("2025-01-05");
  });
});
