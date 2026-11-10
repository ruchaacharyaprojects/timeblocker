/**
 * End-to-end flow test (task 11).
 *
 * This exercises the whole TimeBlocker path by wiring the *actual* pure
 * orchestration layers together over shared in-memory stores — no real
 * network, no AWS, no Google. The point is to prove the modules compose, not
 * to re-test each in isolation (the per-module unit tests already do that):
 *
 *   intake  (extract -> confirm gate, R1)
 *     -> plan     (place items, write calendar blocks, persist, R2)
 *       -> calendar (solo blocks: 🧱 prefix + per-category color +
 *                    suppressed reminders, R4)
 *         -> reminder (15-min selection with I'm in / Skip / Move it, R5)
 *           -> reschedule ("Will you miss this?" yes -> move + undo, R6)
 *             -> review   (Saturday finished/partial/missed +
 *                          fitness-missed-not-rolled, R8/R9)
 *
 * The shared pieces are the whole trick: one `InMemoryCalendar` that round-
 * trips solo blocks through the *real* calendar-integration request builder
 * (so the 🧱 prefix, colors, and suppressed reminders are genuinely produced),
 * one items table, and one blocks table. Every step reads what the previous
 * step wrote through those shared stores, so a break in the seam between two
 * modules fails this test even when each module's own unit tests still pass.
 */

import { describe, expect, it } from "vitest";
import type { Week } from "@timeblocker/scheduling-engine";
import {
  buildEventRequest,
  parseCalendarEvent,
  BLOCK_PREFIX,
  CATEGORY_COLOR_ID,
  type CalendarEvent,
  type GoogleEventRequest,
  type RawGoogleEvent,
  type SoloBlock,
} from "@timeblocker/calendar-integration";
import type {
  NotificationPort,
  ReminderNotification,
} from "@timeblocker/reminders";
import type { UsageSummary } from "@timeblocker/usage-metrics";

import {
  extractItems,
  confirmItems,
  type IdGenerator,
  type IntakeDeps,
  type IntakeItem,
  type ItemsStore,
  type PlanningTrigger,
} from "../lambda/intake/intake.js";
import {
  runPlanning,
  type BlocksWriter as PlanBlocksWriter,
  type CalendarPort as PlanCalendarPort,
  type ItemsReader,
  type PersistedBlock as PlanPersistedBlock,
  type PlanningDeps,
  type PlanningSettings,
  type SettingsReader,
} from "../lambda/planning/plan.js";
import {
  runReminders,
  type BlocksReader as ReminderBlocksReader,
  type CalendarReadPort as ReminderCalendarPort,
  type RemindersDeps,
} from "../lambda/scheduler/reminders.js";
import {
  runMeetingConflictDetection,
  type CalendarReadPort as DetectCalendarPort,
  type DetectionDeps,
  type PromptRaiser,
  type WeekBlocksReader,
} from "../lambda/calendar-sync/detect.js";
import {
  applyUndo,
  runReschedule,
  type BlocksReader as RescheduleBlocksReader,
  type BlocksWriter as RescheduleBlocksWriter,
  type CalendarPort as RescheduleCalendarPort,
  type PersistedBlock,
  type RescheduleDeps,
  type RescheduleSettings,
  type SettingsReader as RescheduleSettingsReader,
} from "../lambda/reschedule/reschedule.js";
import {
  type NativeMissPrompt,
  type PromptAnswerEvent,
  toRescheduleRequest,
} from "../lambda/reschedule/prompt.js";
import {
  runSaturdayReview,
  type ReviewBlocksReader,
  type ReviewBlocksWriter,
  type ReviewWriter,
  type SaturdayReviewDeps,
  type UsageSummaryReader,
  type WeeklyReview,
} from "../lambda/scheduler/review.js";

// --- Fixed week + clock ----------------------------------------------------

// A Monday inside the planning week; weekBounds resolves it to Sun 2025-01-05.
const WEEK_OF = "2025-01-06T12:00:00-05:00";
const WEEK_ID = "2025-01-05";
// Plan from the very start of the week so nothing is cut by `now`.
const PLAN_NOW = "2025-01-05T00:00:00-05:00";

const MINUTE_MS = 60_000;

// --- Shared in-memory stores -----------------------------------------------

/**
 * One calendar shared across plan, reminders, reschedule and detection. It
 * stores events keyed by id and round-trips solo blocks through the real
 * calendar-integration request builder, so the 🧱 prefix, per-category color,
 * and suppressed reminders are produced exactly as production would. Reads are
 * filtered to the requested week, mirroring Google's events.list window.
 */
class InMemoryCalendar
  implements
    PlanCalendarPort,
    ReminderCalendarPort,
    DetectCalendarPort,
    RescheduleCalendarPort
{
  /** The last write request bodies, so the test can assert R4 formatting. */
  readonly writeRequests: GoogleEventRequest[] = [];
  private readonly events = new Map<string, RawGoogleEvent>();
  private seq = 0;

  /** Seed a real meeting-with-others (e.g. a newly-added conflicting event). */
  seedMeeting(event: {
    id: string;
    summary: string;
    start: string;
    end: string;
  }): void {
    this.events.set(event.id, {
      id: event.id,
      summary: event.summary,
      start: { dateTime: event.start },
      end: { dateTime: event.end },
      // Another attendee makes it a meeting-with-others.
      attendees: [{ self: true }, { email: "someone@example.com" }],
    });
  }

  async readWeek(week: Week): Promise<CalendarEvent[]> {
    const from = new Date(week.sunday).getTime();
    const to = new Date(week.saturday).getTime();
    const out: CalendarEvent[] = [];
    for (const raw of this.events.values()) {
      const parsed = parseCalendarEvent(raw);
      if (!parsed) continue;
      const start = new Date(parsed.start).getTime();
      if (start >= from && start < to) out.push(parsed);
    }
    out.sort((a, b) => a.start.localeCompare(b.start));
    return out;
  }

  private write(block: SoloBlock): string {
    const request = buildEventRequest(block);
    this.writeRequests.push(request);
    const id = block.calendarEventId ?? `cal-${this.seq++}`;
    // Store it back as a raw Google event (solo: only self attends) so a later
    // readWeek sees exactly what we wrote.
    this.events.set(id, {
      id,
      summary: request.summary,
      start: request.start,
      end: request.end,
      colorId: request.colorId,
      attendees: [{ self: true }],
    });
    return id;
  }

  async writeBlock(block: SoloBlock): Promise<string> {
    return this.write(block);
  }

  async writeBlocks(blocks: SoloBlock[]): Promise<string[]> {
    return blocks.map((b) => this.write(b));
  }

  /** The stored solo block events, for assertions. */
  soloBlockEvents(): RawGoogleEvent[] {
    return [...this.events.values()].filter((e) =>
      (e.summary ?? "").startsWith(BLOCK_PREFIX),
    );
  }
}

/** One items table shared by intake (write/read) and planning (read). */
class InMemoryItems implements ItemsStore, ItemsReader {
  private readonly rows = new Map<string, IntakeItem>();

  async putItems(items: IntakeItem[]): Promise<void> {
    for (const item of items) this.rows.set(item.id, { ...item });
  }

  async readItems(weekId: string): Promise<IntakeItem[]> {
    return [...this.rows.values()].filter((i) => i.weekId === weekId);
  }

  /** Planning reads only the confirmed items (the R1.3 gate). */
  async readConfirmedItems(weekId: string): Promise<IntakeItem[]> {
    return [...this.rows.values()].filter(
      (i) => i.weekId === weekId && i.confirmed,
    );
  }
}

/**
 * One blocks table shared by planning (write), reminders (read), reschedule
 * (read/write) and review (read/write). It stores the full persisted block so
 * every consumer sees the same rows.
 */
class InMemoryBlocks
  implements
    PlanBlocksWriter,
    ReminderBlocksReader,
    RescheduleBlocksReader,
    RescheduleBlocksWriter,
    WeekBlocksReader,
    ReviewBlocksReader,
    ReviewBlocksWriter
{
  readonly rows = new Map<string, PersistedBlock>();

  // Planning writes newly-placed blocks.
  async saveBlocks(blocks: PlanPersistedBlock[]): Promise<void> {
    for (const b of blocks) this.rows.set(b.id, { ...b } as PersistedBlock);
  }

  // Reschedule / review write a single updated block.
  async saveBlock(block: PersistedBlock): Promise<void> {
    this.rows.set(block.id, { ...block });
  }

  // Reminders (title/time slice), detection, and review all read the week's
  // blocks. A full PersistedBlock row satisfies every reader's shape.
  async readWeekBlocks(weekId: string): Promise<PersistedBlock[]> {
    return [...this.rows.values()].filter((b) => b.weekId === weekId);
  }

  async readBlock(
    weekId: string,
    blockId: string,
  ): Promise<PersistedBlock | null> {
    const found = this.rows.get(blockId);
    return found && found.weekId === weekId ? { ...found } : null;
  }

  all(): PersistedBlock[] {
    return [...this.rows.values()];
  }
}

// --- Fixed-value fakes for the remaining ports -----------------------------

class SequentialIds implements IdGenerator {
  private n = 0;
  next(): string {
    return `item-${this.n++}`;
  }
}

/** Records that planning was triggered after confirmation (the R1.3 gate). */
class RecordingPlanningTrigger implements PlanningTrigger {
  triggeredWeekIds: string[] = [];
  async triggerPlanning(weekId: string): Promise<void> {
    this.triggeredWeekIds.push(weekId);
  }
}

class FakePlanSettings implements SettingsReader {
  constructor(private readonly settings: PlanningSettings) {}
  async readSettings(): Promise<PlanningSettings> {
    return this.settings;
  }
}

class FakeRescheduleSettings implements RescheduleSettingsReader {
  constructor(private readonly settings: RescheduleSettings) {}
  async readSettings(): Promise<RescheduleSettings> {
    return this.settings;
  }
}

/** Records the "Will you miss this block?" prompts raised by detection. */
class RecordingPromptRaiser implements PromptRaiser {
  prompts: NativeMissPrompt[] = [];
  async presentPrompt(prompt: NativeMissPrompt): Promise<void> {
    this.prompts.push(prompt);
  }
}

class RecordingReviewWriter implements ReviewWriter {
  saved: WeeklyReview[] = [];
  async saveReview(review: WeeklyReview): Promise<void> {
    this.saved.push(review);
  }
}

class FakeUsageSummary implements UsageSummaryReader {
  constructor(private readonly summary: UsageSummary | null) {}
  async readWeekSummary(): Promise<UsageSummary | null> {
    return this.summary;
  }
}

/** Records the custom reminders delivered on a tick (R5 push edge). */
class RecordingNotificationPort implements NotificationPort {
  delivered: ReminderNotification[] = [];
  async deliver(notification: ReminderNotification): Promise<void> {
    this.delivered.push(notification);
  }
}

// --- The full flow ---------------------------------------------------------

describe("end-to-end: intake -> plan -> calendar -> reminder -> reschedule -> review", () => {
  // Shared stores — the seam between every step.
  const calendar = new InMemoryCalendar();
  const items = new InMemoryItems();
  const blocks = new InMemoryBlocks();

  const ids = new SequentialIds();
  const planningTrigger = new RecordingPlanningTrigger();

  // The pasted/typed intake payload: three items across three categories,
  // as a JSON item list (the format the device sends after the user pastes or
  // types their to-do list).
  const INTAKE_PAYLOAD = JSON.stringify({
    confidence: 0.9,
    items: [
      { text: "Finish quarterly report", durationMin: 90, priority: 1, category: "work" },
      { text: "Morning run", durationMin: 45, priority: 2, category: "fitness" },
      { text: "Read a chapter", durationMin: 30, priority: 3, category: "self-development" },
    ],
  });

  const intakeDeps: IntakeDeps = {
    items,
    planning: planningTrigger,
    ids,
  };

  const planningDeps: PlanningDeps = {
    items,
    settings: new FakePlanSettings({ planningMode: "earliest-fit", holidays: [] }),
    calendar,
    blocks,
  };

  // Outputs carried between steps.
  let extractedIds: string[] = [];
  let planned: Awaited<ReturnType<typeof runPlanning>>;
  let reminderBlock: PlanPersistedBlock;

  // --- Step 1: intake (R1) -------------------------------------------------

  it("intake: extracts items unconfirmed and schedules nothing yet (R1.1)", async () => {
    const extract = await extractItems(
      { itemsText: INTAKE_PAYLOAD, weekId: WEEK_ID },
      intakeDeps,
    );

    expect(extract.ocrFailed).toBe(false);
    expect(extract.candidates).toHaveLength(3);
    // Everything is unconfirmed right after extraction (the gate is closed).
    expect(extract.candidates.every((c) => !c.item.confirmed)).toBe(true);
    // Nothing is confirmed in the shared store yet, so planning would see none.
    expect(await items.readConfirmedItems(WEEK_ID)).toEqual([]);
    // Planning was not triggered by extraction.
    expect(planningTrigger.triggeredWeekIds).toEqual([]);

    extractedIds = extract.candidates.map((c) => c.item.id);
  });

  it("intake: confirming the review opens the gate and triggers planning (R1.2, R1.3)", async () => {
    const confirm = await confirmItems(
      {
        weekId: WEEK_ID,
        edits: extractedIds.map((id) => ({ id })),
      },
      intakeDeps,
    );

    expect(confirm.planningTriggered).toBe(true);
    expect(planningTrigger.triggeredWeekIds).toEqual([WEEK_ID]);
    // Exactly the confirmed items are now visible to planning.
    const confirmed = await items.readConfirmedItems(WEEK_ID);
    expect(confirmed.map((i) => i.id).sort()).toEqual([...extractedIds].sort());
    expect(confirmed.every((i) => i.confirmed)).toBe(true);
  });

  // --- Step 2 + 3: plan + calendar write (R2, R4) --------------------------

  it("plan: places the confirmed items into free time and persists blocks (R2.1)", async () => {
    planned = await runPlanning({ weekOf: WEEK_OF, now: PLAN_NOW }, planningDeps);

    expect(planned.weekId).toBe(WEEK_ID);
    expect(planned.placed).toHaveLength(3);
    expect(planned.unplaced).toEqual([]);
    expect(planned.alert).toBeUndefined();

    // Blocks were persisted to the shared table with calendar event ids.
    const persisted = blocks.all().filter((b) => b.weekId === WEEK_ID);
    expect(persisted).toHaveLength(3);
    expect(persisted.every((b) => b.status === "scheduled")).toBe(true);
    expect(persisted.every((b) => (b.calendarEventId ?? "").length > 0)).toBe(true);
  });

  it("calendar: each block is a solo event with 🧱 prefix, per-category color, and suppressed reminders (R4.1, R4.2)", async () => {
    // The real calendar-integration request builder ran for every placed block.
    expect(calendar.writeRequests).toHaveLength(3);
    for (const request of calendar.writeRequests) {
      expect(request.summary.startsWith(BLOCK_PREFIX)).toBe(true);
      // Suppressed reminders: no Google defaults, no email reminders (R4.2).
      expect(request.reminders.useDefault).toBe(false);
      expect(request.reminders.overrides).toEqual([]);
    }

    // Per-category color (R4.1): the work/fitness/self-development blocks each
    // carry their category's distinct Google color id.
    const placedByColor = new Map(
      planned.placed.map((p) => [p.item.category, CATEGORY_COLOR_ID[p.item.category]]),
    );
    const writtenColors = new Set(calendar.writeRequests.map((r) => r.colorId));
    for (const color of placedByColor.values()) {
      expect(writtenColors.has(color)).toBe(true);
    }

    // The shared calendar now reports those solo blocks back on a week read.
    const events = await calendar.readWeek(planned.week);
    const solo = events.filter((e) => e.summary.startsWith(BLOCK_PREFIX));
    expect(solo).toHaveLength(3);
  });

  // --- Step 4: reminder (R5) ----------------------------------------------

  it("reminder: fires a 15-min custom notification with I'm in / Skip / Move it for the upcoming block (R5.1, R5.2)", async () => {
    // Pick the earliest placed block and set `now` to 15 minutes before it so
    // exactly that block falls in this tick's lead window.
    const earliest = [...planned.placed].sort((a, b) =>
      a.slot.start.localeCompare(b.slot.start),
    )[0];
    reminderBlock = blocks
      .all()
      .find((b) => b.itemId === earliest.item.id) as PlanPersistedBlock;

    const now = new Date(
      new Date(earliest.slot.start).getTime() - 15 * MINUTE_MS,
    ).toISOString();

    const notifier = new RecordingNotificationPort();
    const remindersDeps: RemindersDeps = { blocks, calendar, notifier };

    const result = await runReminders({ now, weekOf: WEEK_OF }, remindersDeps);

    // The upcoming block was selected and delivered.
    const forBlock = result.selected.find(
      (n) => n.sourceId === reminderBlock.id,
    );
    expect(forBlock).toBeDefined();
    expect(forBlock?.kind).toBe("block");
    expect(result.delivered).toContain(forBlock?.id);
    expect(result.failures).toEqual([]);

    // The three actionable buttons (R5.2).
    expect(forBlock?.actions.map((a) => a.id)).toEqual([
      "im-in",
      "skip",
      "move-it",
    ]);
  });

  // --- Step 5: reschedule via "Will you miss this?" (R6) -------------------

  let undoToken: Extract<
    Awaited<ReturnType<typeof runReschedule>>,
    { kind: "moved" }
  >["undo"];
  let originalStart: string;

  it('reschedule: a new overlapping meeting raises "Will you miss this?", and Yes moves the block with Undo (R6.1, R6.2)', async () => {
    // A colleague books a meeting right on top of the upcoming block.
    originalStart = reminderBlock.start;
    calendar.seedMeeting({
      id: "conflict-mtg",
      summary: "Surprise sync",
      start: reminderBlock.start,
      end: reminderBlock.end,
    });

    // Meeting-conflict detection raises the shared prompt for the conflicted
    // block (R6.1).
    const prompt = new RecordingPromptRaiser();
    const detectDeps: DetectionDeps = { blocks, calendar, prompt };
    const detection = await runMeetingConflictDetection(
      { weekOf: WEEK_OF },
      detectDeps,
    );

    const raised = detection.raised.find(
      (r) => r.conflict.block.id === reminderBlock.id,
    );
    expect(raised).toBeDefined();
    expect(raised?.prompt.trigger).toBe("meeting-overlap");
    expect(raised?.prompt.actions.map((a) => a.id)).toEqual(["yes", "no"]);

    // The user taps "Yes" on the prompt -> routed into the shared reschedule
    // flow through the same mapping the native layer uses.
    const answerEvent: PromptAnswerEvent = {
      promptId: raised!.prompt.id,
      blockId: reminderBlock.id,
      weekId: WEEK_ID,
      answer: "yes",
    };
    const rescheduleRequest = toRescheduleRequest(answerEvent);

    const rescheduleDeps: RescheduleDeps = {
      blocks,
      blocksWriter: blocks,
      settings: new FakeRescheduleSettings({ holidays: [] }),
      calendar,
    };
    const outcome = await runReschedule(rescheduleRequest, rescheduleDeps);

    expect(outcome.kind).toBe("moved");
    if (outcome.kind !== "moved") throw new Error("expected a move");

    // It landed on a different slot, no longer on the meeting.
    expect(outcome.to.start).not.toBe(originalStart);
    // The shared blocks table reflects the move with status "moved".
    const movedRow = await blocks.readBlock(WEEK_ID, reminderBlock.id);
    expect(movedRow?.status).toBe("moved");
    expect(movedRow?.start).toBe(outcome.to.start);

    // The moved calendar event reused the same event id (updated in place).
    expect(outcome.block.calendarEventId).toBe(reminderBlock.calendarEventId);

    undoToken = outcome.undo;
  });

  it("reschedule: Undo restores the block to its original slot (R6.2)", async () => {
    const rescheduleDeps = {
      blocks,
      blocksWriter: blocks,
      calendar,
    };
    const restored = await applyUndo(undoToken, rescheduleDeps);

    expect(restored.start).toBe(originalStart);
    const row = await blocks.readBlock(WEEK_ID, reminderBlock.id);
    expect(row?.start).toBe(originalStart);
  });

  // --- Step 6: Saturday review (R8, R9) ------------------------------------

  it("review: Saturday review reports finished/partial/missed and does not roll a missed fitness block (R8.1, R9.1)", async () => {
    // Set up outcomes on the shared blocks table:
    //  - the work block was finished
    //  - the self-development block was partly done
    //  - the fitness block was never done and its window is in the past
    const persisted = blocks.all().filter((b) => b.weekId === WEEK_ID);
    const workBlock = persisted.find((b) => b.category === "work")!;
    const selfDev = persisted.find((b) => b.category === "self-development")!;
    const fitness = persisted.find((b) => b.category === "fitness")!;

    await blocks.saveBlock({ ...workBlock, status: "done" });
    await blocks.saveBlock({ ...selfDev, status: "partial" });
    // Leave the fitness block "scheduled" but in the past so the review counts
    // it as a miss that must not roll to next week (R8.1).
    await blocks.saveBlock({
      ...fitness,
      status: "scheduled",
      start: "2025-01-06T07:00:00-05:00",
      end: "2025-01-06T07:45:00-05:00",
    });

    const usage: UsageSummary = {
      window: { startMs: 0, endMs: 0 },
      totalScreenTimeMin: 280,
      distractionTimeMin: 120,
      distractionRatio: 0.43,
      distractionLevel: "moderate",
      distractionAppCount: 2,
    };

    const reviewWriter = new RecordingReviewWriter();
    const reviewDeps: SaturdayReviewDeps = {
      blocks,
      blocksWriter: blocks,
      reviews: reviewWriter,
      usage: new FakeUsageSummary(usage),
    };

    // A Saturday evening inside the week.
    const review = await runSaturdayReview(
      { now: "2025-01-11T18:00:00-05:00", weekOf: WEEK_OF },
      reviewDeps,
    );

    // R9.1: the week's outcomes are classified.
    expect(review.finished.map((e) => e.category)).toContain("work");
    expect(review.partial.map((e) => e.category)).toContain("self-development");
    expect(review.missed.map((e) => e.category)).toContain("fitness");

    // R9.2: the on-device usage summary is folded in.
    expect(review.screenTimeMin).toBe(280);
    expect(review.distractionLevel).toBe("moderate");

    // R9.4: the next-week photo prompt is carried.
    expect(review.photoPrompt).toBeTruthy();

    // R8.1: the missed fitness block was persisted as "missed" (stays in its
    // own week), not left schedulable to roll into next Sunday.
    expect(review.fitnessMissedCount).toBe(1);
    const fitnessRow = await blocks.readBlock(WEEK_ID, fitness.id);
    expect(fitnessRow?.status).toBe("missed");

    // The compiled review was persisted.
    expect(reviewWriter.saved).toHaveLength(1);
    expect(reviewWriter.saved[0].weekId).toBe(WEEK_ID);
  });
});
