import type { CalendarEvent } from "@timeblocker/calendar-integration";
import type { IntakeItem } from "@timeblocker/flows";
import { describe, expect, it } from "vitest";
import { MAX_BLOCK_NOTES_CHARS, UNDO_WINDOW_MS, type DeviceBlock, type OpenPrompt } from "../models.js";
import { blockReminderId } from "../notifications/desired.js";
import { NotificationService } from "../notifications/service.js";
import { Repositories } from "../repositories.js";
import { FakeClock, FakeNotifier, MemoryKeyValueStore } from "../testkit.js";
import { buildBlockDetail } from "../viewModels/blockDetail.js";
import {
  BlockActionService,
  MOVE_REASONS,
  NOTHING_FITS_TITLE,
  ROLLED_REASON,
  SHRUNK_REASON,
  UNDO_ACTION,
  nextWeekIdOf,
  nothingFitsOptionsFor,
  shrinkDurationMin,
  moveBusy,
  movedNotificationId,
  movedToLabel,
  nothingFitsDeepLink,
  nothingFitsNotificationId,
  isLengthEditable,
  normalizeLengthMin,
  LENGTH_MOVED_REASON,
} from "./blockActions.js";

const WEEK = "2025-07-06";
/** Monday 2025-07-07 08:00 Toronto (EDT). */
const NOW = "2025-07-07T12:00:00.000Z";
/** Monday 13:00-14:00 Toronto. */
const START = "2025-07-07T17:00:00.000Z";
const END = "2025-07-07T18:00:00.000Z";

const block = (id: string, overrides: Partial<DeviceBlock> = {}): DeviceBlock => ({
  id,
  itemId: `item-${id}`,
  title: `Task ${id}`,
  start: START,
  end: END,
  category: "work",
  status: "scheduled",
  weekId: WEEK,
  calendarEventId: `tbevent${id}`,
  calendarSynced: true,
  promptedMeetingIds: [],
  usagePrompted: false,
  updatedAt: 0,
  ...overrides,
});

const meeting = (id: string, start: string, end: string): CalendarEvent => ({
  id,
  summary: `Meeting ${id}`,
  start,
  end,
  withOthers: true,
  isBlock: false,
});

/** A meeting covering the whole Toronto week, so nothing fits. */
const WHOLE_WEEK = meeting("all-week", "2025-07-06T04:00:00.000Z", "2025-07-13T04:00:00.000Z");

const ms = (iso: string) => Date.parse(iso);
const overlaps = (a: { start: string; end: string }, b: { start: string; end: string }) =>
  ms(a.start) < ms(b.end) && ms(b.start) < ms(a.end);

async function setup(opts: { blocks?: DeviceBlock[]; events?: CalendarEvent[]; prompts?: OpenPrompt[] } = {}) {
  const kv = new MemoryKeyValueStore();
  const repos = new Repositories(kv);
  const clock = new FakeClock(NOW);
  const notifier = new FakeNotifier();
  const real = new NotificationService(repos, notifier, clock);
  await repos.blocks.save(WEEK, opts.blocks ?? [block("b1")]);
  await repos.calendarCache.save(WEEK, { syncedAt: ms(NOW), events: opts.events ?? [] });
  await repos.openPrompts.save(opts.prompts ?? []);
  await real.reconcile();
  notifier.cancelled.length = 0;
  notifier.shown.length = 0;

  const track = { reconciles: 0, flushes: 0, writesBeforeReconcile: -1, writesStart: kv.writes };
  const notifications = {
    reconcile: () => {
      track.reconciles += 1;
      if (track.writesBeforeReconcile < 0) track.writesBeforeReconcile = kv.writes - track.writesStart;
      return real.reconcile();
    },
  };
  let flushImpl: () => Promise<unknown> = async () => undefined;
  const flusher = {
    flush: () => {
      track.flushes += 1;
      return flushImpl();
    },
  };
  const service = new BlockActionService({ repos, clock, notifier, notifications, flusher });
  const setFlush = (fn: () => Promise<unknown>) => {
    flushImpl = fn;
  };
  return { kv, repos, clock, notifier, service, track, setFlush };
}

describe("BlockActionService.imIn / skip", () => {
  it("I'm in marks the block in progress in one write and dismisses the notification", async () => {
    const { repos, notifier, service, track } = await setup();
    const result = await service.imIn({ weekId: WEEK, blockId: "b1" }, { notificationId: "rem:x" });

    expect(result).toMatchObject({ kind: "updated", block: { status: "in-progress", start: START, end: END } });
    const [stored] = await repos.blocks.get(WEEK);
    expect(stored).toMatchObject({ status: "in-progress", updatedAt: ms(NOW) });
    expect(track.writesBeforeReconcile).toBe(1);
    expect(track.reconciles).toBe(1);
    expect(await repos.outbox.get()).toEqual([]);
    expect(notifier.cancelled).toContain("rem:x");
  });

  it("Skip marks the block skipped and its reminder is cancelled", async () => {
    const { repos, notifier, service } = await setup();
    const reminder = blockReminderId("b1", ms(START));
    expect(notifier.pending.has(reminder)).toBe(true);

    const result = await service.skip({ weekId: WEEK, blockId: "b1" });

    expect(result).toMatchObject({ kind: "updated", block: { status: "skipped" } });
    expect((await repos.blocks.get(WEEK))[0]!.status).toBe("skipped");
    expect(notifier.pending.has(reminder)).toBe(false);
  });

  it("reports not-found for an unknown block and changes nothing", async () => {
    const { kv, service } = await setup();
    const before = kv.snapshot();
    expect(await service.imIn({ weekId: WEEK, blockId: "nope" })).toEqual({ kind: "not-found" });
    expect(kv.snapshot()).toEqual(before);
  });
});

describe("BlockActionService.moveIt", () => {
  it("moves to a valid later slot in the same week with one outbox upsert, then reconciles and flushes", async () => {
    const lunch = meeting("m1", "2025-07-07T18:00:00.000Z", "2025-07-07T19:00:00.000Z");
    const other = block("b2", { start: "2025-07-07T19:00:00.000Z", end: "2025-07-07T20:00:00.000Z" });
    const { repos, notifier, service, track } = await setup({ blocks: [block("b1"), other], events: [lunch] });

    const result = await service.moveIt({ weekId: WEEK, blockId: "b1" }, { notificationId: "rem:tap" });

    expect(result.kind).toBe("moved");
    if (result.kind !== "moved") return;
    const to = result.to;
    expect(result.from).toEqual({ start: START, end: END });
    expect(ms(to.end) - ms(to.start)).toBe(ms(END) - ms(START));
    expect(ms(to.start)).toBeGreaterThanOrEqual(ms(NOW));
    expect(ms(to.start)).toBeGreaterThanOrEqual(ms("2025-07-06T04:00:00.000Z"));
    expect(ms(to.end)).toBeLessThanOrEqual(ms("2025-07-13T04:00:00.000Z"));
    for (const busy of [{ start: START, end: END }, lunch, other]) {
      expect(overlaps(to, busy)).toBe(false);
    }

    const stored = (await repos.blocks.get(WEEK)).find((b) => b.id === "b1")!;
    expect(stored).toMatchObject({
      start: to.start,
      end: to.end,
      status: "scheduled",
      movedFrom: { start: START, end: END },
      moveReason: MOVE_REASONS["move-it"],
      updatedAt: ms(NOW),
    });
    expect(await repos.outbox.get()).toEqual([
      { blockId: "b1", calendarEventId: "tbeventb1", op: "upsert", attempts: 0, enqueuedAt: ms(NOW) },
    ]);
    expect(track.writesBeforeReconcile).toBe(1);
    expect(track.flushes).toBe(1);
    expect(notifier.pending.has(blockReminderId("b1", ms(START)))).toBe(false);
    expect(notifier.pending.has(blockReminderId("b1", ms(to.start)))).toBe(true);
    expect(notifier.cancelled).toContain("rem:tap");
  });

  it("puts a skipped block back to scheduled when it moves", async () => {
    const { service } = await setup({ blocks: [block("b1", { status: "skipped" })] });
    const result = await service.moveIt({ weekId: WEEK, blockId: "b1" });
    expect(result).toMatchObject({ kind: "moved", block: { status: "scheduled" } });
  });

  it("leaves the block unchanged and shows a nothing-fits status notification when no slot exists", async () => {
    const { kv, repos, notifier, service, track } = await setup({ events: [WHOLE_WEEK] });
    const before = kv.snapshot();

    const result = await service.moveIt({ weekId: WEEK, blockId: "b1" }, { notificationId: "rem:tap" });

    expect(result).toMatchObject({ kind: "nothing-fits", source: "move-it", block: block("b1") });
    expect(kv.snapshot()).toEqual(before);
    expect(await repos.outbox.get()).toEqual([]);
    expect(track.flushes).toBe(0);
    const shown = notifier.shown.find((n) => n.id === nothingFitsNotificationId("b1"));
    expect(shown).toMatchObject({
      kind: "status",
      channel: "status",
      title: NOTHING_FITS_TITLE,
      deepLink: nothingFitsDeepLink("b1"),
    });
    expect(nothingFitsDeepLink("b1")).toBe("timeblocker://nothing-fits/b1");
    expect(notifier.cancelled).toContain("rem:tap");
  });

  it("a failing flush does not fail the move", async () => {
    const { repos, service, setFlush } = await setup();
    setFlush(() => Promise.reject(new Error("offline")));
    const result = await service.moveIt({ weekId: WEEK, blockId: "b1" });
    expect(result.kind).toBe("moved");
    expect(await repos.outbox.get()).toHaveLength(1);
  });
});

describe("BlockActionService.answerPrompt", () => {
  const prompt: OpenPrompt = { promptId: "miss:b1", blockId: "b1", meetingIds: ["m1"], shownAt: 0 };

  it("Yes moves the block and removes the prompt in the same write", async () => {
    const other: OpenPrompt = { promptId: "miss:b9", blockId: "b9", meetingIds: [], shownAt: 0 };
    const { repos, notifier, service, track } = await setup({ prompts: [prompt, other] });

    const result = await service.answerPrompt({ promptId: "miss:b1", answer: "yes", weekId: WEEK });

    expect(result).toMatchObject({ kind: "moved", source: "prompt-yes" });
    const stored = (await repos.blocks.get(WEEK))[0]!;
    expect(stored.moveReason).toBe(MOVE_REASONS["prompt-yes"]);
    expect(stored.start).not.toBe(START);
    expect(await repos.openPrompts.get()).toEqual([other]);
    expect(await repos.outbox.get()).toHaveLength(1);
    expect(track.writesBeforeReconcile).toBe(1);
    expect(notifier.cancelled).toContain("miss:b1");
  });

  it("Yes finds the block's week when the payload carries none", async () => {
    const { service } = await setup({ prompts: [prompt] });
    const result = await service.answerPrompt({ promptId: "miss:b1", answer: "yes" });
    expect(result.kind).toBe("moved");
  });

  it("Yes with no slot leaves the block, removes the prompt, and starts nothing-fits", async () => {
    const { repos, notifier, service } = await setup({ events: [WHOLE_WEEK], prompts: [prompt] });

    const result = await service.answerPrompt({ promptId: "miss:b1", answer: "yes", weekId: WEEK });

    expect(result).toMatchObject({ kind: "nothing-fits", source: "prompt-yes" });
    expect(await repos.blocks.get(WEEK)).toEqual([block("b1")]);
    expect(await repos.openPrompts.get()).toEqual([]);
    expect(await repos.outbox.get()).toEqual([]);
    expect(notifier.shown.map((n) => n.deepLink)).toContain(nothingFitsDeepLink("b1"));
  });

  it("No changes nothing but the prompt, and the reminder stays armed", async () => {
    const { repos, notifier, service, track } = await setup({ prompts: [prompt] });

    const result = await service.answerPrompt({ promptId: "miss:b1", answer: "no", weekId: WEEK });

    expect(result).toEqual({ kind: "declined", prompt });
    expect(await repos.blocks.get(WEEK)).toEqual([block("b1")]);
    expect(await repos.openPrompts.get()).toEqual([]);
    expect(await repos.outbox.get()).toEqual([]);
    expect(notifier.pending.has(blockReminderId("b1", ms(START)))).toBe(true);
    expect(notifier.cancelled).toEqual(["miss:b1"]);
    expect(track.flushes).toBe(0);
  });

  it("an already-answered prompt changes nothing (no double move)", async () => {
    const { kv, service } = await setup({ prompts: [prompt] });
    await service.answerPrompt({ promptId: "miss:b1", answer: "yes", weekId: WEEK });
    const after = kv.snapshot();
    expect(await service.answerPrompt({ promptId: "miss:b1", answer: "yes", weekId: WEEK })).toEqual({
      kind: "not-found",
    });
    expect(kv.snapshot()).toEqual(after);
  });
});

describe("moveBusy", () => {
  it("adds the original span under a distinct id and drops the block's own entry", () => {
    const b = block("b1");
    const busy = moveBusy([meeting("m", START, END), { ...meeting("x", START, END), isBlock: true }], [b, block("b2")], b);
    expect(busy.map((e) => e.id)).toEqual(["m", "b2", "b1#original"]);
    expect(busy.at(-1)).toEqual({ id: "b1#original", start: START, end: END, withOthers: false });
  });
});

describe("BlockActionService.undo", () => {
  const prompt: OpenPrompt = { promptId: "miss:b1", blockId: "b1", meetingIds: ["m1"], shownAt: 0 };

  it("a move stores an Undo token in the move's single write that block detail reads as live", async () => {
    const { repos, clock, service, track } = await setup({ blocks: [block("b1", { status: "skipped" })] });
    const result = await service.moveIt({ weekId: WEEK, blockId: "b1" });
    if (result.kind !== "moved") throw new Error("expected a move");

    expect(track.writesBeforeReconcile).toBe(1);
    expect(await repos.undo.get()).toEqual({
      blockId: "b1",
      weekId: WEEK,
      calendarEventId: "tbeventb1",
      previous: { start: START, end: END },
      previousStatus: "skipped",
      movedTo: result.to,
      expiresAt: ms(NOW) + UNDO_WINDOW_MS,
    });
    const undo = await repos.undo.get();
    expect(buildBlockDetail({ block: result.block, now: clock.now(), undo }).undo).toEqual({
      remainingMs: UNDO_WINDOW_MS,
      label: "Undo",
    });
    clock.advance(UNDO_WINDOW_MS);
    expect(buildBlockDetail({ block: result.block, now: clock.now(), undo }).undo).toBeNull();
  });

  it("Yes shows a 'Moved to …' status notification with an Undo action that times out", async () => {
    const { notifier, service } = await setup({ prompts: [prompt] });
    const result = await service.answerPrompt({ promptId: "miss:b1", answer: "yes", weekId: WEEK });
    if (result.kind !== "moved") throw new Error("expected a move");

    const shown = notifier.shown.find((n) => n.id === movedNotificationId("b1"));
    expect(shown).toMatchObject({
      kind: "status",
      channel: "status",
      title: `Moved to ${movedToLabel(result.to.start)}`,
      actions: [UNDO_ACTION],
      sourceId: "b1",
      weekId: WEEK,
      timeoutMs: UNDO_WINDOW_MS,
    });
    expect(UNDO_ACTION).toEqual({ id: "undo", label: "Undo" });
  });

  it("Move it from block detail shows no status notification", async () => {
    const { notifier, service } = await setup();
    await service.moveIt({ weekId: WEEK, blockId: "b1" });
    expect(notifier.shown.some((n) => n.id === movedNotificationId("b1"))).toBe(false);
  });

  it("formats the moved-to time as weekday and Toronto clock time", () => {
    expect(movedToLabel("2025-07-08T19:00:00.000Z")).toBe("Tue 3:00 PM");
  });

  it("Undo within the window restores start/end/status, enqueues an upsert, and reconciles reminders", async () => {
    const { repos, clock, notifier, service, track } = await setup({
      blocks: [block("b1", { status: "skipped" })],
      prompts: [prompt],
    });
    const moved = await service.answerPrompt({ promptId: "miss:b1", answer: "yes", weekId: WEEK });
    if (moved.kind !== "moved") throw new Error("expected a move");
    // The flush delivered the move's upsert.
    await repos.outbox.save([]);
    clock.advance(UNDO_WINDOW_MS - 1);
    const reconcilesBefore = track.reconciles;
    const flushesBefore = track.flushes;

    const result = await service.undo({ blockId: "b1", notificationId: movedNotificationId("b1") });

    expect(result).toMatchObject({ kind: "undone", restored: { start: START, end: END } });
    const stored = (await repos.blocks.get(WEEK))[0]!;
    expect(stored).toMatchObject({ start: START, end: END, status: "skipped", updatedAt: clock.now() });
    expect(stored.movedFrom).toBeUndefined();
    expect(stored.moveReason).toBeUndefined();
    expect(await repos.outbox.get()).toEqual([
      { blockId: "b1", calendarEventId: "tbeventb1", op: "upsert", attempts: 0, enqueuedAt: clock.now() },
    ]);
    expect(await repos.undo.get()).toBeNull();
    expect(track.reconciles).toBe(reconcilesBefore + 1);
    expect(track.flushes).toBe(flushesBefore + 1);
    expect(notifier.cancelled).toContain(movedNotificationId("b1"));
  });

  it("Undo restores a scheduled block's reminder at the original start", async () => {
    const { notifier, service } = await setup();
    const moved = await service.moveIt({ weekId: WEEK, blockId: "b1" });
    if (moved.kind !== "moved") throw new Error("expected a move");
    await service.undo();
    expect(notifier.pending.has(blockReminderId("b1", ms(START)))).toBe(true);
    expect(notifier.pending.has(blockReminderId("b1", ms(moved.to.start)))).toBe(false);
  });

  it("Undo at or after 10 s is rejected and changes nothing", async () => {
    const { kv, clock, service } = await setup();
    await service.moveIt({ weekId: WEEK, blockId: "b1" });
    clock.advance(UNDO_WINDOW_MS);
    const before = kv.snapshot();
    expect(await service.undo()).toEqual({ kind: "rejected", reason: "expired" });
    expect(kv.snapshot()).toEqual(before);
  });

  it("Undo after the block moved again elsewhere is rejected and changes nothing", async () => {
    const { kv, repos, service } = await setup();
    await service.moveIt({ weekId: WEEK, blockId: "b1" });
    const [b] = await repos.blocks.get(WEEK);
    await repos.blocks.save(WEEK, [{ ...b!, start: "2025-07-10T17:00:00.000Z", end: "2025-07-10T18:00:00.000Z" }]);
    const before = kv.snapshot();
    expect(await service.undo()).toEqual({ kind: "rejected", reason: "moved-again" });
    expect(kv.snapshot()).toEqual(before);
  });

  it("a second Undo, an Undo with no move, or an Undo for another block is rejected", async () => {
    const { kv, service } = await setup({ blocks: [block("b1"), block("b2", { start: "2025-07-08T17:00:00.000Z", end: "2025-07-08T18:00:00.000Z" })] });
    expect(await service.undo()).toEqual({ kind: "rejected", reason: "no-token" });
    await service.moveIt({ weekId: WEEK, blockId: "b1" });
    const before = kv.snapshot();
    expect(await service.undo({ blockId: "b2" })).toEqual({ kind: "rejected", reason: "other-block" });
    expect(kv.snapshot()).toEqual(before);
    expect((await service.undo({ blockId: "b1" })).kind).toBe("undone");
    const after = kv.snapshot();
    expect(await service.undo({ blockId: "b1" })).toEqual({ kind: "rejected", reason: "no-token" });
    expect(kv.snapshot()).toEqual(after);
  });
});

describe("nothing-fits helpers", () => {
  it("offers shrink, drop and roll, except roll for fitness (R8.1)", () => {
    expect(nothingFitsOptionsFor({ category: "work" })).toEqual(["shrink", "drop", "roll-to-next-week"]);
    expect(nothingFitsOptionsFor({ category: "fitness" })).toEqual(["shrink", "drop"]);
  });
  it("shrinks to 75%, 50% or a custom value of at least 15 min that is shorter", () => {
    expect(shrinkDurationMin(60, "75%")).toBe(45);
    expect(shrinkDurationMin(60, "50%")).toBe(30);
    expect(shrinkDurationMin(20, "50%")).toBe(15);
    expect(shrinkDurationMin(15, "50%")).toBeNull();
    expect(shrinkDurationMin(60, { customMin: 15 })).toBe(15);
    expect(shrinkDurationMin(60, { customMin: 14 })).toBeNull();
    expect(shrinkDurationMin(60, { customMin: 60 })).toBeNull();
    expect(shrinkDurationMin(60, { customMin: 20.5 })).toBeNull();
  });
  it("computes the next week id", () => {
    expect(nextWeekIdOf(WEEK)).toBe("2025-07-13");
    expect(nextWeekIdOf("2025-10-26")).toBe("2025-11-02");
  });
});

describe("BlockActionService.resolveNothingFits", () => {
  const ref = { weekId: WEEK, blockId: "b1" };
  const NEXT_WEEK = "2025-07-13";
  const item = (overrides: Partial<IntakeItem> = {}): IntakeItem => ({
    id: "item-b1",
    text: "Task b1",
    durationMin: 60,
    priority: 2,
    category: "work",
    confirmed: true,
    weekId: WEEK,
    ...overrides,
  });
  /** Busy all week except Monday 19:00-19:30 Toronto (23:00-23:30Z), after dinner. */
  const HALF_HOUR_GAP = [
    meeting("before", "2025-07-06T04:00:00.000Z", "2025-07-07T23:00:00.000Z"),
    meeting("after", "2025-07-07T23:30:00.000Z", "2025-07-13T04:00:00.000Z"),
  ];

  it("shrink retries placement: a span that still doesn't fit changes nothing", async () => {
    const { kv, service } = await setup({ events: HALF_HOUR_GAP });
    const before = kv.snapshot();
    const result = await service.resolveNothingFits(ref, { kind: "shrink", to: "75%" });
    expect(result).toMatchObject({ kind: "nothing-fits", durationMin: 45, block: { start: START, end: END } });
    expect(kv.snapshot()).toEqual(before);
  });

  it("shrink to 50% lands in the free slot with one upsert and dismisses the nothing-fits notification", async () => {
    const { repos, notifier, service, track } = await setup({ events: HALF_HOUR_GAP });
    const result = await service.resolveNothingFits(ref, { kind: "shrink", to: "50%" });
    expect(result).toMatchObject({
      kind: "shrunk",
      durationMin: 30,
      to: { start: "2025-07-07T23:00:00.000Z", end: "2025-07-07T23:30:00.000Z" },
    });
    const [stored] = await repos.blocks.get(WEEK);
    expect(ms(stored!.start)).toBe(ms("2025-07-07T23:00:00.000Z"));
    expect(ms(stored!.end)).toBe(ms("2025-07-07T23:30:00.000Z"));
    expect(stored).toMatchObject({ status: "scheduled", movedFrom: { start: START, end: END }, moveReason: SHRUNK_REASON });
    expect(await repos.outbox.get()).toEqual([
      { blockId: "b1", calendarEventId: "tbeventb1", op: "upsert", attempts: 0, enqueuedAt: ms(NOW) },
    ]);
    expect(notifier.cancelled).toContain(nothingFitsNotificationId("b1"));
    expect(track.reconciles).toBe(1);
    expect(track.flushes).toBe(1);
  });

  it("shrink with an invalid custom duration is rejected and changes nothing", async () => {
    const { kv, service } = await setup({ events: HALF_HOUR_GAP });
    const before = kv.snapshot();
    expect(await service.resolveNothingFits(ref, { kind: "shrink", to: { customMin: 10 } })).toEqual({
      kind: "rejected",
      reason: "invalid-duration",
    });
    expect(kv.snapshot()).toEqual(before);
  });

  it("drop removes the block and its item and enqueues a delete", async () => {
    const { repos, notifier, service } = await setup({ events: [WHOLE_WEEK] });
    await repos.items.save(WEEK, [item(), item({ id: "item-other" })]);
    const result = await service.resolveNothingFits(ref, { kind: "drop" });
    expect(result).toMatchObject({ kind: "dropped", blockId: "b1", itemId: "item-b1" });
    expect(await repos.blocks.get(WEEK)).toEqual([]);
    expect((await repos.items.get(WEEK)).map((i) => i.id)).toEqual(["item-other"]);
    expect(await repos.outbox.get()).toEqual([
      { blockId: "b1", calendarEventId: "tbeventb1", op: "delete", attempts: 0, enqueuedAt: ms(NOW) },
    ]);
    expect(notifier.pending.has(blockReminderId("b1", ms(START)))).toBe(false);
  });

  it("drop on a fitness block records it as missed and deletes its event (R8.1)", async () => {
    const { repos, service } = await setup({ blocks: [block("b1", { category: "fitness" })], events: [WHOLE_WEEK] });
    const result = await service.resolveNothingFits(ref, { kind: "drop" });
    expect(result).toMatchObject({ kind: "missed", block: { status: "missed" } });
    const [stored] = await repos.blocks.get(WEEK);
    expect(stored).toMatchObject({ id: "b1", status: "missed", calendarSynced: false });
    expect((await repos.outbox.get()).map((w) => w.op)).toEqual(["delete"]);
  });

  it("roll deletes this week's event, marks the block rolled, and adds the confirmed item to next week", async () => {
    const { repos, service } = await setup({ events: [WHOLE_WEEK] });
    await repos.items.save(WEEK, [item()]);
    const result = await service.resolveNothingFits(ref, { kind: "roll" });
    expect(result).toMatchObject({ kind: "rolled", nextWeekId: NEXT_WEEK });
    const [stored] = await repos.blocks.get(WEEK);
    expect(stored).toMatchObject({ status: "rolled", moveReason: ROLLED_REASON, calendarSynced: false, start: START });
    expect(await repos.outbox.get()).toEqual([
      { blockId: "b1", calendarEventId: "tbeventb1", op: "delete", attempts: 0, enqueuedAt: ms(NOW) },
    ]);
    expect(await repos.items.get(NEXT_WEEK)).toEqual([item({ weekId: NEXT_WEEK })]);
    // A second tap does nothing more.
    expect(await service.resolveNothingFits(ref, { kind: "roll" })).toEqual({ kind: "rejected", reason: "not-open" });
    expect(await repos.items.get(NEXT_WEEK)).toHaveLength(1);
  });

  it("roll is not offered for fitness and changes nothing", async () => {
    const { kv, service } = await setup({ blocks: [block("b1", { category: "fitness" })], events: [WHOLE_WEEK] });
    const before = kv.snapshot();
    expect(await service.resolveNothingFits(ref, { kind: "roll" })).toEqual({
      kind: "rejected",
      reason: "roll-not-offered",
    });
    expect(kv.snapshot()).toEqual(before);
  });

  it("reports not-found for an unknown block", async () => {
    const { service } = await setup();
    expect(await service.resolveNothingFits({ weekId: WEEK, blockId: "nope" }, { kind: "drop" })).toEqual({
      kind: "not-found",
    });
  });
});

describe("BlockActionService.changeLength", () => {
  const ref = { weekId: WEEK, blockId: "b1" };
  const iso = (m: number) => new Date(ms(START) + m * 60_000).toISOString();

  it("normalizeLengthMin rounds to 5 and enforces 5..480", () => {
    expect(normalizeLengthMin(45)).toBe(45);
    expect(normalizeLengthMin(47)).toBe(45);
    expect(normalizeLengthMin(48)).toBe(50);
    expect(normalizeLengthMin(4)).toBe(5);
    expect(normalizeLengthMin(480)).toBe(480);
    expect(normalizeLengthMin(2)).toBeNull();
    expect(normalizeLengthMin(0)).toBeNull();
    expect(normalizeLengthMin(485)).toBeNull();
    expect(normalizeLengthMin(Number.NaN)).toBeNull();
  });

  it("isLengthEditable needs a scheduled block that has not started", () => {
    expect(isLengthEditable({ status: "scheduled", start: START }, ms(NOW))).toBe(true);
    expect(isLengthEditable({ status: "scheduled", start: START }, ms(START))).toBe(false);
    expect(isLengthEditable({ status: "in-progress", start: START }, ms(NOW))).toBe(false);
    expect(isLengthEditable({ status: "done", start: START }, ms(NOW))).toBe(false);
  });

  it("shrinks in place: same start, new end, one upsert, reconcile, flush, undo token", async () => {
    const { repos, notifier, service, track } = await setup();
    const result = await service.changeLength(ref, 45, { notificationId: "rem:x" });

    expect(result).toMatchObject({ kind: "resized", durationMin: 45, moved: false });
    const [stored] = await repos.blocks.get(WEEK);
    expect(stored).toMatchObject({ start: START, end: iso(45), status: "scheduled", updatedAt: ms(NOW) });
    expect(stored!.movedFrom).toBeUndefined();
    expect(await repos.outbox.get()).toEqual([
      { blockId: "b1", calendarEventId: "tbeventb1", op: "upsert", attempts: 0, enqueuedAt: ms(NOW) },
    ]);
    expect(track.writesBeforeReconcile).toBe(1);
    expect(track.reconciles).toBe(1);
    expect(track.flushes).toBe(1);
    expect(notifier.cancelled).toContain("rem:x");
    expect(await repos.undo.get()).toMatchObject({
      blockId: "b1",
      previous: { start: START, end: END },
      previousStatus: "scheduled",
      movedTo: { start: START, end: iso(45) },
      expiresAt: ms(NOW) + UNDO_WINDOW_MS,
    });
  });

  it("extends in place when the time after the block is free", async () => {
    const { repos, service } = await setup();
    const result = await service.changeLength(ref, 90);
    expect(result).toMatchObject({ kind: "resized", moved: false, to: { start: START, end: iso(90) } });
    expect((await repos.blocks.get(WEEK))[0]).toMatchObject({ start: START, end: iso(90) });
  });

  it("rounds an off-grid length to the nearest 5 minutes", async () => {
    const { service } = await setup();
    expect(await service.changeLength(ref, 47)).toMatchObject({ kind: "resized", durationMin: 45 });
  });

  it("re-places the block when extending would overlap a meeting", async () => {
    const m = meeting("m1", END, iso(90));
    const { repos, service } = await setup({ events: [m] });
    const result = await service.changeLength(ref, 90);

    expect(result.kind).toBe("resized");
    if (result.kind !== "resized") return;
    expect(result.moved).toBe(true);
    expect(ms(result.to.end) - ms(result.to.start)).toBe(90 * 60_000);
    expect(ms(result.to.start)).toBeGreaterThanOrEqual(ms(START));
    expect(overlaps(result.to, m)).toBe(false);
    expect(ms(result.to.end)).toBeLessThanOrEqual(ms("2025-07-13T04:00:00.000Z"));
    expect((await repos.blocks.get(WEEK))[0]).toMatchObject({
      start: result.to.start,
      end: result.to.end,
      status: "scheduled",
      movedFrom: { start: START, end: END },
      moveReason: LENGTH_MOVED_REASON,
    });
    expect(await repos.outbox.get()).toHaveLength(1);
  });

  it("re-places the block when extending would overlap another block", async () => {
    const other = block("b2", { start: END, end: iso(120) });
    const { service } = await setup({ blocks: [block("b1"), other] });
    const result = await service.changeLength(ref, 90);
    expect(result).toMatchObject({ kind: "resized", moved: true });
    if (result.kind === "resized") expect(overlaps(result.to, other)).toBe(false);
  });

  it("never extends past the end of Saturday", async () => {
    const start = "2025-07-13T03:00:00.000Z"; // Sat 11:00 PM EDT
    const late = block("b1", { start, end: "2025-07-13T03:30:00.000Z" });
    const { service } = await setup({ blocks: [late] });
    const result = await service.changeLength(ref, 90);
    if (result.kind === "resized") {
      expect(result.moved).toBe(true);
      expect(ms(result.to.end)).toBeLessThanOrEqual(ms("2025-07-13T04:00:00.000Z"));
    } else {
      expect(result.kind).toBe("nothing-fits");
    }
  });

  it("returns nothing-fits and leaves everything unchanged when no slot exists", async () => {
    const { kv, repos, service, track } = await setup({ events: [WHOLE_WEEK] });
    const before = kv.snapshot();
    const result = await service.changeLength(ref, 90);

    expect(result).toMatchObject({ kind: "nothing-fits", durationMin: 90, block: block("b1") });
    expect(kv.snapshot()).toEqual(before);
    expect(await repos.outbox.get()).toEqual([]);
    expect(track.flushes).toBe(0);
  });

  it("rejects out-of-range lengths without changing anything", async () => {
    const { kv, service } = await setup();
    const before = kv.snapshot();
    for (const bad of [0, 2, 485, 600, -5, Number.NaN]) {
      expect(await service.changeLength(ref, bad)).toEqual({ kind: "rejected", reason: "invalid-duration" });
    }
    expect(kv.snapshot()).toEqual(before);
  });

  it("accepts the bounds 5 and 480", async () => {
    const { service } = await setup();
    expect(await service.changeLength(ref, 5)).toMatchObject({ kind: "resized", durationMin: 5 });
    expect(await service.changeLength(ref, 480)).toMatchObject({ kind: "resized", durationMin: 480 });
  });

  it("rejects an unchanged length, a started block, and non-scheduled blocks", async () => {
    const a = await setup();
    expect(await a.service.changeLength(ref, 60)).toEqual({ kind: "rejected", reason: "unchanged" });

    const b = await setup({ blocks: [block("b1", { start: "2025-07-07T11:00:00.000Z", end: "2025-07-07T13:00:00.000Z" })] });
    expect(await b.service.changeLength(ref, 30)).toEqual({ kind: "rejected", reason: "not-editable" });

    for (const status of ["in-progress", "done", "skipped"] as const) {
      const c = await setup({ blocks: [block("b1", { status })] });
      expect(await c.service.changeLength(ref, 30)).toEqual({ kind: "rejected", reason: "not-editable" });
    }
  });

  it("reports not-found for an unknown block", async () => {
    const { service } = await setup();
    expect(await service.changeLength({ weekId: WEEK, blockId: "nope" }, 30)).toEqual({ kind: "not-found" });
  });

  it("Undo restores the previous span", async () => {
    const { repos, service } = await setup();
    await service.changeLength(ref, 90);
    const undone = await service.undo({ blockId: "b1" });
    expect(undone.kind).toBe("undone");
    expect((await repos.blocks.get(WEEK))[0]).toMatchObject({ start: START, end: END, status: "scheduled" });
    expect(await repos.undo.get()).toBeNull();
    expect(await repos.outbox.get()).toHaveLength(1);
  });

  it("a failing flush does not fail the change", async () => {
    const { repos, service, setFlush } = await setup();
    setFlush(() => Promise.reject(new Error("offline")));
    expect((await service.changeLength(ref, 30)).kind).toBe("resized");
    expect(await repos.outbox.get()).toHaveLength(1);
  });
});

describe("BlockActionService.saveNotes", () => {
  it("stores only the notes field: no outbox write, no reconcile, no undo", async () => {
    const { repos, service, track } = await setup();
    const before = (await repos.blocks.get(WEEK))[0]!;
    const result = await service.saveNotes({ weekId: WEEK, blockId: "b1" }, "Draft email text");
    expect(result).toMatchObject({ kind: "saved", block: { id: "b1", notes: "Draft email text" } });
    const [stored] = await repos.blocks.get(WEEK);
    expect(stored).toEqual({ ...before, notes: "Draft email text" });
    expect(track.reconciles).toBe(0);
    expect(track.flushes).toBe(0);
    expect(await repos.outbox.get()).toEqual([]);
    expect(await repos.undo.get()).toBeNull();
  });
  it("cuts notes to the cap and removes them when empty", async () => {
    const { repos, service } = await setup();
    await service.saveNotes({ weekId: WEEK, blockId: "b1" }, "x".repeat(MAX_BLOCK_NOTES_CHARS + 50));
    expect((await repos.blocks.get(WEEK))[0]!.notes).toHaveLength(MAX_BLOCK_NOTES_CHARS);
    await service.saveNotes({ weekId: WEEK, blockId: "b1" }, "");
    expect("notes" in (await repos.blocks.get(WEEK))[0]!).toBe(false);
  });
  it("finds the block without a week hint and reports not-found for unknown blocks", async () => {
    const { kv, service } = await setup();
    const found = await service.saveNotes({ weekId: "", blockId: "b1" }, "hi");
    expect(found.kind).toBe("saved");
    const before = kv.snapshot();
    expect(await service.saveNotes({ weekId: WEEK, blockId: "nope" }, "hi")).toEqual({ kind: "not-found" });
    expect(kv.snapshot()).toEqual(before);
  });
  it("keeps notes through a later status change", async () => {
    const { repos, service } = await setup();
    await service.saveNotes({ weekId: WEEK, blockId: "b1" }, "keep me");
    await service.imIn({ weekId: WEEK, blockId: "b1" });
    expect((await repos.blocks.get(WEEK))[0]).toMatchObject({ status: "in-progress", notes: "keep me" });
  });
});
