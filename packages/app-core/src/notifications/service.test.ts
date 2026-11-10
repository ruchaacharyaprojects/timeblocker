/**
 * Unit tests for `NotificationService.reconcile()`
 * (R13.1, R13.2, R13.7, R13.10, R13.11, R14.7).
 */
import type { CalendarEvent } from "@timeblocker/calendar-integration";
import { describe, expect, it } from "vitest";
import type { DeviceBlock, RegistryEntry } from "../models.js";
import type { NotificationPayload } from "../ports.js";
import { Repositories } from "../repositories.js";
import { FakeClock, FakeNotifier, MemoryKeyValueStore } from "../testkit.js";
import { REMINDER_LEAD_MS, blockReminderId, meetingReminderId } from "./desired.js";
import { planReconcile } from "./reconcile.js";
import type { Forecast } from "./forecast.js";
import { NotificationService, reconcileWeekIds, weekIdAt } from "./service.js";

const MIN = 60_000;
/** Wednesday 2025-06-11 09:00 America/Toronto (EDT). */
const NOW = Date.parse("2025-06-11T13:00:00Z");
const WEEK_ID = "2025-06-08";
const iso = (ms: number) => new Date(ms).toISOString();

function block(id: string, startMs: number, extra: Partial<DeviceBlock> = {}): DeviceBlock {
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
    ...extra,
  };
}

function meeting(id: string, startMs: number): CalendarEvent {
  return {
    id,
    summary: `Meeting ${id}`,
    start: iso(startMs),
    end: iso(startMs + 30 * MIN),
    withOthers: true,
    isBlock: false,
  };
}

/** A FakeNotifier that counts the mutating calls. */
class CountingNotifier extends FakeNotifier {
  calls = { schedule: 0, showNow: 0, cancel: 0 };

  override async schedule(n: NotificationPayload, fireAtMs: number, exact: boolean): Promise<void> {
    this.calls.schedule += 1;
    return super.schedule(n, fireAtMs, exact);
  }

  override async showNow(n: NotificationPayload): Promise<void> {
    this.calls.showNow += 1;
    return super.showNow(n);
  }

  override async cancel(id: string): Promise<void> {
    this.calls.cancel += 1;
    return super.cancel(id);
  }

  reset(): void {
    this.calls = { schedule: 0, showNow: 0, cancel: 0 };
  }

  get total(): number {
    return this.calls.schedule + this.calls.showNow + this.calls.cancel;
  }
}

function setup(options: { exactAllowed?: boolean; permission?: "granted" | "denied" } = {}) {
  const kv = new MemoryKeyValueStore();
  const repos = new Repositories(kv);
  const notifier = new CountingNotifier(options);
  const clock = new FakeClock(NOW);
  const service = new NotificationService(repos, notifier, clock);
  return { kv, repos, notifier, clock, service };
}

const reminderIds = (ids: Iterable<string>) => [...ids].filter((id) => id.startsWith("rem:")).sort();

describe("NotificationService.reconcile", () => {
  it("schedules one exact reminder per future block and qualifying meeting, 15 minutes ahead", async () => {
    const { service, notifier, repos } = setup();
    const bStart = NOW + 2 * 60 * MIN;
    const mStart = NOW + 3 * 60 * MIN;
    const result = await service.reconcile({
      blocks: [block("b1", bStart), block("b2", bStart, { status: "skipped" })],
      events: [meeting("m1", mStart), { ...meeting("m2", mStart), withOthers: false }],
    });

    expect(result.exact).toBe(true);
    expect(reminderIds(notifier.pending.keys())).toEqual(
      [blockReminderId("b1", bStart), meetingReminderId("m1", mStart)].sort(),
    );
    const b1 = notifier.pending.get(blockReminderId("b1", bStart))!;
    expect(b1.fireAtMs).toBe(bStart - REMINDER_LEAD_MS);
    expect(b1.exact).toBe(true);
    expect(b1.notification.actions.map((a) => a.label)).toEqual(["I'll be there", "Move to later this week"]);
    // Weekly nudges are armed too.
    expect([...notifier.pending.keys()].filter((id) => id.startsWith("nudge:"))).toHaveLength(2);

    const registry = await repos.notifRegistry.get();
    expect(registry).toHaveLength(4);
    expect(registry.every((e) => e.state === "pending" && e.exact)).toBe(true);
  });

  it("is idempotent: a second pass with the same inputs makes no native calls", async () => {
    const { service, notifier, kv } = setup();
    const sources = {
      blocks: [block("b1", NOW + 60 * MIN), block("soon", NOW + 5 * MIN)],
      events: [meeting("m1", NOW + 10 * MIN)],
    };
    await service.reconcile(sources);
    expect(notifier.total).toBeGreaterThan(0);
    notifier.reset();
    const writes = kv.writes;

    const again = await service.reconcile(sources);
    expect(notifier.total).toBe(0);
    expect(again.scheduled).toEqual([]);
    expect(again.shown).toEqual([]);
    expect(again.cancelled).toEqual([]);
    expect(kv.writes).toBe(writes);
  });

  it("shows a reminder immediately when the start is under 15 minutes away, exactly once", async () => {
    const { service, notifier, repos, clock } = setup();
    const start = NOW + 5 * MIN;
    const sources = { blocks: [block("b1", start)], events: [meeting("m1", NOW + 14 * MIN)] };
    const first = await service.reconcile(sources);

    expect(first.shown.sort()).toEqual(
      [blockReminderId("b1", start), meetingReminderId("m1", NOW + 14 * MIN)].sort(),
    );
    expect(reminderIds(notifier.pending.keys())).toEqual([]);
    const entry = (await repos.notifRegistry.get()).find((e) => e.id === blockReminderId("b1", start))!;
    expect(entry.state).toBe("shown");
    expect(entry.fireAtMs).toBe(NOW);

    clock.advance(2 * MIN);
    notifier.reset();
    await service.reconcile(sources);
    expect(notifier.calls.showNow).toBe(0);
    expect(notifier.shown.filter((n) => n.id === blockReminderId("b1", start))).toHaveLength(1);
  });

  it("never schedules a reminder for a block or meeting that already started", async () => {
    const { service, notifier } = setup();
    await service.reconcile({
      blocks: [block("past", NOW - MIN), block("now", NOW)],
      events: [meeting("m-past", NOW - 10 * MIN)],
    });
    expect(reminderIds(notifier.pending.keys())).toEqual([]);
    expect(notifier.shown.filter((n) => n.id.startsWith("rem:"))).toEqual([]);
  });

  it("cancels the old reminder and schedules the new one when a block moves", async () => {
    const { service, notifier } = setup();
    const oldStart = NOW + 60 * MIN;
    const newStart = NOW + 4 * 60 * MIN;
    await service.reconcile({ blocks: [block("b1", oldStart)], events: [] });
    notifier.reset();

    const result = await service.reconcile({ blocks: [block("b1", newStart)], events: [] });
    expect(result.cancelled).toEqual([blockReminderId("b1", oldStart)]);
    expect(result.scheduled).toEqual([blockReminderId("b1", newStart)]);
    expect(reminderIds(notifier.pending.keys())).toEqual([blockReminderId("b1", newStart)]);
  });

  it("cancels a deleted block's reminder (R14.7) and a skipped block's reminder", async () => {
    const { service, notifier, repos } = setup();
    const start = NOW + 60 * MIN;
    await service.reconcile({ blocks: [block("gone", start), block("skip", start)], events: [] });

    const result = await service.reconcile({
      blocks: [block("skip", start, { status: "skipped" })],
      events: [],
    });
    expect(result.cancelled.sort()).toEqual(
      [blockReminderId("gone", start), blockReminderId("skip", start)].sort(),
    );
    expect(reminderIds(notifier.pending.keys())).toEqual([]);
    expect((await repos.notifRegistry.get()).filter((e) => e.kind === "block-reminder")).toEqual([]);
  });

  it("schedules inexact when exact alarms are unavailable, then re-arms exact when they return", async () => {
    const { service, notifier, repos } = setup({ exactAllowed: false });
    const start = NOW + 60 * MIN;
    const sources = { blocks: [block("b1", start)], events: [] };
    const first = await service.reconcile(sources);
    expect(first.exact).toBe(false);
    expect([...notifier.pending.values()].every((s) => !s.exact)).toBe(true);

    notifier.setExactAllowed(true);
    notifier.reset();
    const second = await service.reconcile(sources);
    expect(second.exact).toBe(true);
    expect(second.scheduled).toContain(blockReminderId("b1", start));
    expect(notifier.calls.cancel).toBe(0);
    expect([...notifier.pending.values()].every((s) => s.exact)).toBe(true);
    expect((await repos.notifRegistry.get()).every((e) => e.exact)).toBe(true);
  });

  it("falls back to inexact when an exact schedule throws mid-pass", async () => {
    const { service, notifier, repos } = setup({ exactAllowed: false });
    // The OS reported exact alarms available, then revoked them before scheduling.
    notifier.canScheduleExact = async () => true;
    const start = NOW + 60 * MIN;
    const result = await service.reconcile({ blocks: [block("b1", start)], events: [] });

    expect(result.failed).toEqual([]);
    expect(result.inexactFallback).toContain(blockReminderId("b1", start));
    expect(notifier.pending.get(blockReminderId("b1", start))!.exact).toBe(false);
    const entry = (await repos.notifRegistry.get()).find((e) => e.id === blockReminderId("b1", start))!;
    expect(entry.exact).toBe(false);
  });

  it("re-arms registry entries missing from the native pending set (force-stop)", async () => {
    const { service, notifier } = setup();
    const start = NOW + 60 * MIN;
    const sources = { blocks: [block("b1", start)], events: [] };
    await service.reconcile(sources);
    notifier.pending.clear();
    notifier.reset();

    const result = await service.reconcile(sources);
    expect(result.scheduled).toContain(blockReminderId("b1", start));
    expect(notifier.calls.showNow).toBe(0);
    expect(notifier.pending.get(blockReminderId("b1", start))!.fireAtMs).toBe(start - REMINDER_LEAD_MS);
  });

  it("records a fired alarm as shown without re-showing it, then prunes it after the start", async () => {
    const { service, notifier, repos, clock } = setup();
    const start = NOW + 60 * MIN;
    const sources = { blocks: [block("b1", start)], events: [] };
    await service.reconcile(sources);

    clock.set(start - 10 * MIN);
    notifier.fireDue(clock.now());
    notifier.reset();
    await service.reconcile(sources);
    expect(notifier.total).toBe(0);
    const entry = (await repos.notifRegistry.get()).find((e) => e.id === blockReminderId("b1", start))!;
    expect(entry.state).toBe("shown");

    clock.set(start + MIN);
    await service.reconcile(sources);
    expect(notifier.calls.cancel).toBe(0);
    expect(notifier.posted.has(blockReminderId("b1", start))).toBe(true);
    expect((await repos.notifRegistry.get()).some((e) => e.id === blockReminderId("b1", start))).toBe(false);
  });

  it("cancels a pending alarm whose source start has passed", async () => {
    const { service, notifier, repos, clock } = setup();
    const start = NOW + 60 * MIN;
    await service.reconcile({ blocks: [block("b1", start)], events: [] });
    // The alarm never fired (e.g. delayed inexact) and the block already started.
    clock.set(start + MIN);
    const result = await service.reconcile({ blocks: [block("b1", start)], events: [] });
    expect(result.cancelled).toContain(blockReminderId("b1", start));
    expect(notifier.pending.has(blockReminderId("b1", start))).toBe(false);
    expect((await repos.notifRegistry.get()).some((e) => e.kind === "block-reminder")).toBe(false);
  });

  it("records an immediate reminder as shown even when notifications are denied", async () => {
    const { service, notifier, repos } = setup({ permission: "denied" });
    const start = NOW + 5 * MIN;
    await service.reconcile({ blocks: [block("b1", start)], events: [] });
    expect(notifier.dropped.map((n) => n.id)).toContain(blockReminderId("b1", start));
    const entry = (await repos.notifRegistry.get()).find((e) => e.id === blockReminderId("b1", start))!;
    expect(entry.state).toBe("shown");
  });

  it("leaves prompt and status entries alone until their start passes", async () => {
    const { service, notifier, repos, clock } = setup();
    const prompt: RegistryEntry = {
      id: "prompt:b1",
      kind: "miss-prompt",
      sourceId: "b1",
      startMs: NOW + 60 * MIN,
      fireAtMs: NOW,
      exact: false,
      state: "shown",
    };
    await repos.notifRegistry.save([prompt]);
    await notifier.schedule({ id: "status:x", kind: "status", channel: "status", title: "", body: "", actions: [], sourceId: "x" }, NOW + MIN, false);
    notifier.reset();

    await service.reconcile({ blocks: [], events: [] });
    expect(notifier.calls.cancel).toBe(0);
    expect(notifier.pending.has("status:x")).toBe(true);
    expect((await repos.notifRegistry.get()).find((e) => e.id === prompt.id)).toEqual(prompt);

    clock.set(NOW + 61 * MIN);
    await service.reconcile({ blocks: [], events: [] });
    expect((await repos.notifRegistry.get()).some((e) => e.id === prompt.id)).toBe(false);
  });

  it("cancels orphaned TimeBlocker alarms that are neither desired nor registered", async () => {
    const { service, notifier } = setup();
    const orphan = blockReminderId("old", NOW + 90 * MIN);
    await notifier.schedule(
      { id: orphan, kind: "block-reminder", channel: "reminders", title: "", body: "", actions: [], sourceId: "old" },
      NOW + 75 * MIN,
      true,
    );
    const result = await service.reconcile({ blocks: [], events: [] });
    expect(result.cancelled).toEqual([orphan]);
  });

  it("keeps a failed cancel in the registry so the next pass retries it", async () => {
    const { service, notifier, repos } = setup();
    const start = NOW + 60 * MIN;
    await service.reconcile({ blocks: [block("b1", start)], events: [] });
    const original = notifier.cancel.bind(notifier);
    notifier.cancel = async () => {
      throw new Error("boom");
    };
    const failed = await service.reconcile({ blocks: [], events: [] });
    expect(failed.failed.map((f) => f.id)).toEqual([blockReminderId("b1", start)]);
    expect((await repos.notifRegistry.get()).some((e) => e.id === blockReminderId("b1", start))).toBe(true);

    notifier.cancel = original;
    const retry = await service.reconcile({ blocks: [], events: [] });
    expect(retry.cancelled).toEqual([blockReminderId("b1", start)]);
  });

  it("serializes overlapping passes so no duplicate calls are made", async () => {
    const { service, notifier } = setup();
    const sources = { blocks: [block("b1", NOW + 5 * MIN)], events: [] };
    await Promise.all([service.reconcile(sources), service.reconcile(sources)]);
    expect(notifier.calls.showNow).toBe(1);
  });

  it("reads blocks and cached meetings for the current and next week by default", async () => {
    const { service, notifier, repos } = setup();
    const [current, next] = reconcileWeekIds(NOW);
    expect(current).toBe(WEEK_ID);
    expect(next).toBe("2025-06-15");
    const thisWeek = NOW + 60 * MIN;
    const nextWeek = Date.parse("2025-06-16T13:00:00Z");
    expect(weekIdAt(nextWeek)).toBe(next);
    await repos.blocks.save(current!, [block("b1", thisWeek)]);
    await repos.blocks.save(next!, [block("b2", nextWeek, { weekId: next! })]);
    await repos.calendarCache.save(current!, { syncedAt: NOW, events: [meeting("m1", thisWeek)] });

    await service.reconcile();
    expect(reminderIds(notifier.pending.keys())).toEqual(
      [blockReminderId("b1", thisWeek), blockReminderId("b2", nextWeek), meetingReminderId("m1", thisWeek)].sort(),
    );
  });
});

describe("planReconcile", () => {
  it("returns no actions for an empty state", () => {
    expect(planReconcile({ desired: [], registry: [], pending: [], now: NOW })).toEqual([]);
  });

  it("ignores native alarms whose ids TimeBlocker does not own", () => {
    expect(planReconcile({ desired: [], registry: [], pending: ["other:1"], now: NOW })).toEqual([]);
  });
});

describe("NotificationService.reconcile: forecasts and replaced content (R17.3, R17.5)", () => {
  const bStart = NOW + 2 * 60 * MIN;
  const id = blockReminderId("b1", bStart);
  const sources = { blocks: [block("b1", bStart)], events: [] as CalendarEvent[] };
  const forecast = (line: string): Forecast => ({ verdict: "unlikely", reason: "r", line });

  function withProvider(provider: NonNullable<ConstructorParameters<typeof NotificationService>[3]>["forecasts"]) {
    const kv = new MemoryKeyValueStore();
    const repos = new Repositories(kv);
    const notifier = new CountingNotifier();
    const service = new NotificationService(repos, notifier, new FakeClock(NOW), { forecasts: provider });
    return { notifier, service, repos };
  }

  it("puts the provider's forecast line in the armed body", async () => {
    const { service, notifier } = withProvider(async () => new Map([["b1", forecast("May not happen: Overlaps Standup")]]));
    await service.reconcile(sources);
    expect(notifier.pending.get(id)!.notification.body).toBe("Starts at 11:00 AM\nMay not happen: Overlaps Standup");
  });

  it("re-arms under the same id when the forecast text changes, and not when unchanged", async () => {
    let line = "May not happen: Overlaps Standup";
    const { service, notifier } = withProvider(async () => new Map([["b1", forecast(line)]]));
    await service.reconcile(sources);
    notifier.reset();
    await service.reconcile(sources);
    expect(notifier.total).toBe(0);

    line = "May not happen: You've been on your distraction apps";
    const changed = await service.reconcile(sources);
    expect(changed.scheduled).toEqual([id]);
    expect(notifier.calls.schedule).toBe(1);
    expect(notifier.pending.get(id)!.notification.body).toContain("distraction apps");

    notifier.reset();
    await service.reconcile(sources);
    expect(notifier.total).toBe(0);
  });

  it("re-arms an entry from an older build whose registry has no content key", async () => {
    const { service, notifier, repos } = withProvider(undefined);
    await service.reconcile(sources);
    const registry = await repos.notifRegistry.get();
    await repos.notifRegistry.save(registry.map(({ contentKey: _k, ...rest }) => rest));
    notifier.reset();
    const result = await service.reconcile(sources);
    expect(result.scheduled).toContain(id);
  });

  it("reconciles without forecasts when the provider throws", async () => {
    const { service, notifier } = withProvider(async () => {
      throw new Error("history unavailable");
    });
    const result = await service.reconcile(sources);
    expect(result.failed).toEqual([]);
    expect(notifier.pending.get(id)!.notification.body).toBe("Starts at 11:00 AM");
  });
});
