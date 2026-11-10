import { describe, expect, it } from "vitest";
import type { CalendarEvent } from "@timeblocker/calendar-integration";
import type { DeviceBlock } from "../models.js";
import type { NotificationPayload } from "../ports.js";
import { Repositories } from "../repositories.js";
import { FakeCalendar, FakeClock, FakeNotifier, MemoryKeyValueStore } from "../testkit.js";
import {
  SYNC_STEPS,
  SyncService,
  meetingMissPromptPayload,
  newConflictPairs,
} from "./syncService.js";

const T0 = Date.parse("2025-06-02T14:00:00Z"); // Monday; Toronto week of 2025-06-01
const WEEK = "2025-06-01";

function block(id: string, overrides: Partial<DeviceBlock> = {}): DeviceBlock {
  return {
    id,
    itemId: `item-${id}`,
    title: `Task ${id}`,
    start: "2025-06-03T14:00:00Z",
    end: "2025-06-03T15:00:00Z",
    category: "work",
    status: "scheduled",
    weekId: WEEK,
    calendarEventId: `tb0000000${id}`,
    calendarSynced: true,
    promptedMeetingIds: [],
    usagePrompted: false,
    updatedAt: T0,
    ...overrides,
  };
}

/** A meeting with others overlapping block("…")'s default span. */
const meeting = (id: string, overrides: Partial<CalendarEvent> = {}): CalendarEvent => ({
  id,
  summary: `Meeting ${id}`,
  start: "2025-06-03T14:30:00Z",
  end: "2025-06-03T15:30:00Z",
  withOthers: true,
  isBlock: false,
  ...overrides,
});

async function setup(blocks: DeviceBlock[], events: CalendarEvent[], notifier: FakeNotifier | null = new FakeNotifier()) {
  const calendar = new FakeCalendar(events);
  for (const b of blocks) await calendar.upsertBlock({ ...b });
  const repos = new Repositories(new MemoryKeyValueStore());
  await repos.blocks.save(WEEK, blocks);
  const clock = new FakeClock(T0);
  const service = new SyncService({
    repos,
    clock,
    runtimeId: "rt-a",
    calendar,
    ...(notifier ? { notifier } : {}),
  });
  return { repos, clock, service, calendar, notifier };
}

describe("newConflictPairs (R14.4, R14.5)", () => {
  it("keeps only scheduled blocks overlapped half-open by non-🧱 meetings with others", () => {
    const blocks = [block("a"), block("b", { status: "done" })];
    const events = [
      meeting("m1"),
      meeting("solo", { withOthers: false }),
      meeting("brick", { isBlock: true }),
      meeting("touch", { start: "2025-06-03T15:00:00Z", end: "2025-06-03T16:00:00Z" }),
    ];
    const pairs = newConflictPairs(blocks, events);
    expect(pairs.map((p) => [p.block.id, p.meetings.map((m) => m.id)])).toEqual([["a", ["m1"]]]);
  });

  it("drops meetings already in promptedMeetingIds", () => {
    const blocks = [block("a", { promptedMeetingIds: ["m1"] }), block("b", { promptedMeetingIds: ["m1"] })];
    const pairs = newConflictPairs(blocks, [meeting("m1"), meeting("m2")]);
    expect(pairs.map((p) => [p.block.id, p.meetings.map((m) => m.id)])).toEqual([
      ["a", ["m2"]],
      ["b", ["m2"]],
    ]);
    expect(newConflictPairs([block("a", { promptedMeetingIds: ["m1"] })], [meeting("m1")])).toEqual([]);
  });
});

describe("meetingMissPromptPayload (R6.1, R13.5)", () => {
  it("is the miss:<blockId> Yes/No prompt whose body names the meeting", () => {
    const payload = meetingMissPromptPayload(block("a"), [meeting("m1", { summary: "Design review" })]);
    expect(payload).toEqual<NotificationPayload>({
      id: "miss:a",
      kind: "miss-prompt",
      channel: "prompts",
      title: "Will you miss this block?",
      body: "Task a overlaps Design review",
      actions: [
        { id: "yes", label: "Yes" },
        { id: "no", label: "No" },
      ],
      sourceId: "a",
      weekId: WEEK,
      deepLink: "timeblocker://block/a",
    });
    expect(meetingMissPromptPayload(block("a"), [meeting("m1", { summary: " " })]).body).toBe(
      "Task a overlaps a meeting",
    );
  });
});

describe("SyncService conflict prompts (R13.5, R14.5)", () => {
  it("shows one prompt per block and persists pairs, openPrompts, and the registry", async () => {
    const { repos, service, notifier } = await setup(
      [block("a"), block("b", { start: "2025-06-05T14:00:00Z", end: "2025-06-05T15:00:00Z" })],
      [meeting("m1"), meeting("m2", { start: "2025-06-03T13:30:00Z", end: "2025-06-03T14:15:00Z" })],
    );

    const result = await service.sync("pull");

    expect(result).toMatchObject({ status: "completed", report: { stepsRun: [...SYNC_STEPS] } });
    expect(notifier!.shown.map((n) => [n.id, n.body])).toEqual([["miss:a", "Task a overlaps Meeting m2, Meeting m1"]]);
    const [a, b] = await repos.blocks.get(WEEK);
    expect(a.promptedMeetingIds).toEqual(["m2", "m1"]);
    expect(b.promptedMeetingIds).toEqual([]);
    expect(await repos.openPrompts.get()).toEqual([
      { promptId: "miss:a", blockId: "a", meetingIds: ["m2", "m1"], shownAt: T0 },
    ]);
    expect(await repos.notifRegistry.get()).toEqual([
      {
        id: "miss:a",
        kind: "miss-prompt",
        sourceId: "a",
        startMs: Date.parse(a.start),
        fireAtMs: T0,
        exact: false,
        state: "shown",
      },
    ]);
  });

  it("never re-prompts the same pair on later syncs; a new meeting prompts once more", async () => {
    const { repos, service, notifier, calendar } = await setup([block("a")], [meeting("m1")]);

    await service.sync("pull");
    await service.sync("pull");
    expect(notifier!.shown.map((n) => n.id)).toEqual(["miss:a"]);

    calendar.addEvent(meeting("m2", { summary: "Standup" }));
    await service.sync("pull");
    await service.sync("foreground");

    expect(notifier!.shown.map((n) => n.body)).toEqual(["Task a overlaps Meeting m1", "Task a overlaps Standup"]);
    expect((await repos.blocks.get(WEEK))[0].promptedMeetingIds).toEqual(["m1", "m2"]);
    // The unanswered miss:a is replaced, not duplicated.
    expect(await repos.openPrompts.get()).toEqual([
      { promptId: "miss:a", blockId: "a", meetingIds: ["m1", "m2"], shownAt: T0 },
    ]);
    expect((await repos.notifRegistry.get()).map((e) => e.id)).toEqual(["miss:a"]);
  });

  it("persists the pairs before showing: a failed show is not retried and the sync completes", async () => {
    const notifier = new FakeNotifier();
    notifier.showNow = async () => {
      throw new Error("bridge down");
    };
    const { repos, service } = await setup([block("a")], [meeting("m1")], notifier);

    const result = await service.sync("pull");

    expect(result).toMatchObject({ status: "completed", report: { stepsRun: [...SYNC_STEPS] } });
    expect((await repos.blocks.get(WEEK))[0].promptedMeetingIds).toEqual(["m1"]);
    expect((await repos.openPrompts.get()).map((p) => p.promptId)).toEqual(["miss:a"]);

    let shows = 0;
    notifier.showNow = async () => {
      shows += 1;
    };
    await service.sync("pull");
    expect(shows).toBe(0);
  });

  it("keeps other open prompts and does nothing without a notifier", async () => {
    const { repos, service } = await setup([block("a")], [meeting("m1")], null);
    const other = { promptId: "miss:z", blockId: "z", meetingIds: [], shownAt: 1 };
    await repos.openPrompts.save([other]);

    await service.sync("pull");

    expect((await repos.blocks.get(WEEK))[0].promptedMeetingIds).toEqual([]);
    expect(await repos.openPrompts.get()).toEqual([other]);

    const notifier = new FakeNotifier();
    const withNotifier = new SyncService({
      repos,
      clock: new FakeClock(T0),
      runtimeId: "rt-b",
      calendar: new FakeCalendar([meeting("m1"), { ...meeting("tb0000000a"), isBlock: true, start: block("a").start, end: block("a").end }]),
      notifier,
    });
    await withNotifier.sync("pull");
    expect(notifier.shown.map((n) => n.id)).toEqual(["miss:a"]);
    expect((await repos.openPrompts.get()).map((p) => p.promptId)).toEqual(["miss:z", "miss:a"]);
  });
});
