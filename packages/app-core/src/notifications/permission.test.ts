/**
 * Unit tests for `NotificationService.ensurePermissionOnce()`,
 * the exact-alarm state, and `indicators()` (R13.8, R13.9, R13.10).
 */
import type { CalendarEvent } from "@timeblocker/calendar-integration";
import { describe, expect, it } from "vitest";
import type { DeviceBlock } from "../models.js";
import type { NotificationPermission } from "../ports.js";
import { Repositories } from "../repositories.js";
import { FakeClock, FakeNotifier, MemoryKeyValueStore } from "../testkit.js";
import { blockReminderId } from "./desired.js";
import { NotificationService, computeIndicators } from "./service.js";

const MIN = 60_000;
/** Wednesday 2025-06-11 09:00 America/Toronto (EDT). */
const NOW = Date.parse("2025-06-11T13:00:00Z");
const WEEK_ID = "2025-06-08";
const iso = (ms: number) => new Date(ms).toISOString();

function block(id: string, startMs: number): DeviceBlock {
  return {
    id,
    itemId: `item-${id}`,
    title: `Block ${id}`,
    start: iso(startMs),
    end: iso(startMs + 30 * MIN),
    category: "work",
    status: "scheduled",
    weekId: WEEK_ID,
    calendarEventId: `tb${id}`,
    calendarSynced: true,
    promptedMeetingIds: [],
    usagePrompted: false,
    updatedAt: NOW,
  };
}

function event(id: string, startMs: number, extra: Partial<CalendarEvent> = {}): CalendarEvent {
  return {
    id,
    summary: `Event ${id}`,
    start: iso(startMs),
    end: iso(startMs + 30 * MIN),
    withOthers: true,
    isBlock: false,
    ...extra,
  };
}

function setup(
  options: { permission?: NotificationPermission; exactAllowed?: boolean; apiLevel?: number } = {},
) {
  const kv = new MemoryKeyValueStore();
  const repos = new Repositories(kv);
  const notifier = new FakeNotifier(options);
  const clock = new FakeClock(NOW);
  const service = new NotificationService(repos, notifier, clock, { apiLevel: options.apiLevel });
  return { kv, repos, notifier, clock, service };
}

describe("ensurePermissionOnce (R13.8)", () => {
  it("requests once when undetermined on API 33+, persisting the flag first", async () => {
    const { service, notifier, repos } = setup({ permission: "undetermined" });
    notifier.requestOutcome = "denied";
    let flagAtRequest: boolean | undefined;
    const original = notifier.requestPermission.bind(notifier);
    notifier.requestPermission = async () => {
      flagAtRequest = (await repos.permissionState.get()).notificationsRequested;
      return original();
    };

    expect(await service.ensurePermissionOnce()).toEqual({ permission: "denied", requested: true });
    expect(flagAtRequest).toBe(true);
    expect(notifier.permissionRequests).toBe(1);
  });

  it("never asks again, even if the permission reads undetermined later", async () => {
    const { service, notifier } = setup({ permission: "undetermined" });
    notifier.requestOutcome = "undetermined"; // dialog dismissed
    await service.ensurePermissionOnce();
    await service.ensurePermissionOnce();
    notifier.setPermission("undetermined");
    expect(await service.ensurePermissionOnce()).toEqual({ permission: "undetermined", requested: false });
    expect(notifier.permissionRequests).toBe(1);
  });

  it("concurrent launches request at most once", async () => {
    const { service, notifier } = setup({ permission: "undetermined" });
    const results = await Promise.all([service.ensurePermissionOnce(), service.ensurePermissionOnce()]);
    expect(results.filter((r) => r.requested)).toHaveLength(1);
    expect(notifier.permissionRequests).toBe(1);
  });

  it("does not request when already granted or denied", async () => {
    for (const permission of ["granted", "denied"] as const) {
      const { service, notifier } = setup({ permission });
      expect(await service.ensurePermissionOnce()).toEqual({ permission, requested: false });
      expect(notifier.permissionRequests).toBe(0);
    }
  });

  it("does not request below API 33", async () => {
    const { service, notifier, repos } = setup({ permission: "undetermined", apiLevel: 32 });
    expect((await service.ensurePermissionOnce()).requested).toBe(false);
    expect(notifier.permissionRequests).toBe(0);
    expect((await repos.permissionState.get()).notificationsRequested).toBe(false);
  });
});

describe("exact-alarm state (R13.10)", () => {
  it("persists unavailable and reports 'Reminder timing may vary'", async () => {
    const { service, repos } = setup({ exactAllowed: false });
    const r = await service.refreshExactAlarmState();
    expect(r).toMatchObject({ exactAlarmsAvailable: false, reminderTimingMayVary: true });
    expect(r.reconciled).toBeUndefined();
    expect(await service.exactAlarmState()).toEqual({ exactAlarmsAvailable: false, reminderTimingMayVary: true });
    expect((await repos.permissionState.get()).exactAlarmsAvailable).toBe(false);
  });

  it("re-arms inexact reminders as exact when it becomes available, and clears the note", async () => {
    const { service, notifier, repos } = setup({ exactAllowed: false });
    const start = NOW + 60 * MIN;
    await repos.blocks.save(WEEK_ID, [block("a", start)]);
    await service.refreshExactAlarmState();
    await service.reconcile();
    const id = blockReminderId("a", start);
    expect(notifier.pending.get(id)?.exact).toBe(false);

    notifier.setExactAllowed(true);
    const r = await service.refreshExactAlarmState();
    expect(r.changed).toBe(true);
    expect(r.reconciled?.exact).toBe(true);
    expect(r.reconciled?.scheduled).toContain(id);
    expect(notifier.pending.get(id)?.exact).toBe(true);
    expect(await service.exactAlarmState()).toEqual({ exactAlarmsAvailable: true, reminderTimingMayVary: false });
    expect((await repos.notifRegistry.get()).find((e) => e.id === id)?.exact).toBe(true);

    // No change on the next foreground: no reconcile.
    const again = await service.refreshExactAlarmState();
    expect(again).toMatchObject({ changed: false, exactAlarmsAvailable: true });
    expect(again.reconciled).toBeUndefined();
  });

  it("keeps the ask-once flag when both are written", async () => {
    const { service, repos } = setup({ permission: "undetermined", exactAllowed: true });
    await Promise.all([service.ensurePermissionOnce(), service.refreshExactAlarmState()]);
    expect(await repos.permissionState.get()).toEqual({
      notificationsRequested: true,
      exactAlarmsAvailable: true,
    });
  });
});

describe("indicators (R13.9)", () => {
  it("is empty while notifications are granted", async () => {
    const { service, repos } = setup({ permission: "granted" });
    await repos.blocks.save(WEEK_ID, [block("a", NOW + 5 * MIN)]);
    expect(await service.indicators()).toEqual({ denied: false, blockIds: [], meetingIds: [] });
  });

  it("when denied, marks items with now < start ≤ now + 15 min and blocks with open prompts", async () => {
    const { service, repos } = setup({ permission: "denied" });
    await repos.blocks.save(WEEK_ID, [
      block("soon", NOW + 10 * MIN),
      block("edge", NOW + 15 * MIN),
      block("late", NOW + 16 * MIN),
      block("now", NOW),
      block("prompted", NOW + 3 * 60 * MIN),
    ]);
    await repos.calendarCache.save(WEEK_ID, {
      syncedAt: NOW,
      events: [
        event("m1", NOW + 5 * MIN),
        event("solo", NOW + 5 * MIN, { withOthers: false }),
        event("tb", NOW + 5 * MIN, { isBlock: true }),
        event("m2", NOW + 20 * MIN),
      ],
    });
    await repos.openPrompts.save([{ promptId: "p1", blockId: "prompted", meetingIds: ["m9"], shownAt: NOW }]);

    expect(await service.indicators()).toEqual({
      denied: true,
      blockIds: ["edge", "prompted", "soon"],
      meetingIds: ["m1"],
    });
  });

  it("computeIndicators drops items once they start", () => {
    const later = NOW + 11 * MIN;
    const r = computeIndicators({
      blocks: [block("soon", NOW + 10 * MIN)],
      events: [event("m1", NOW + 10 * MIN)],
      promptBlockIds: [],
      now: later,
    });
    expect(r).toEqual({ blockIds: [], meetingIds: [] });
  });
});
