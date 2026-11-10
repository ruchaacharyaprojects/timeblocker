import { NEXT_WEEK_LIST_PROMPT, type WeeklyReview } from "@timeblocker/flows";
import { describe, expect, it } from "vitest";
import type { DeviceBlock, UndoToken } from "../models.js";
import { REMINDER_TIMING_MAY_VARY } from "../notifications/service.js";
import { buildBlockDetail } from "./blockDetail.js";
import { buildReviewView } from "./reviewView.js";
import { buildSettingsView } from "./settingsView.js";

const NOW = Date.parse("2025-03-11T15:00:00Z");

const BLOCK: DeviceBlock = {
  id: "b1",
  itemId: "i1",
  title: "Write report",
  start: "2025-03-11T18:30:00Z",
  end: "2025-03-11T19:30:00Z",
  category: "self-development",
  status: "scheduled",
  weekId: "2025-03-09",
  calendarEventId: "evtb10000",
  calendarSynced: true,
  promptedMeetingIds: [],
  usagePrompted: false,
  updatedAt: 0,
};

describe("buildBlockDetail", () => {
  it("shows title, category, Toronto start/end, status, and the three actions", () => {
    const d = buildBlockDetail({ block: BLOCK, now: NOW });
    expect(d).toMatchObject({
      title: "Write report",
      categoryLabel: "Self-development",
      color: "#0B8043",
      statusLabel: "Scheduled",
      startLabel: "Tue, Mar 11, 2:30 PM",
      endLabel: "Tue, Mar 11, 3:30 PM",
      undo: null,
      hasOpenPrompt: false,
    });
    expect(d.actions.map((a) => a.label)).toEqual(["I'm in", "Skip", "Move it"]);
  });

  it("offers Undo only while the token is live and the block is still at the moved-to slot", () => {
    const undo: UndoToken = {
      blockId: "b1",
      weekId: "2025-03-09",
      calendarEventId: "evtb10000",
      previous: { start: "2025-03-11T16:00:00Z", end: "2025-03-11T17:00:00Z" },
      previousStatus: "scheduled",
      movedTo: { start: BLOCK.start, end: BLOCK.end },
      expiresAt: NOW + 4_000,
    };
    expect(buildBlockDetail({ block: BLOCK, now: NOW, undo }).undo).toEqual({ remainingMs: 4_000, label: "Undo" });
    expect(buildBlockDetail({ block: BLOCK, now: undo.expiresAt, undo }).undo).toBeNull();
    const movedAgain = { ...BLOCK, start: "2025-03-12T18:30:00Z", end: "2025-03-12T19:30:00Z" };
    expect(buildBlockDetail({ block: movedAgain, now: NOW, undo }).undo).toBeNull();
    expect(buildBlockDetail({ block: { ...BLOCK, id: "b2" }, now: NOW, undo }).undo).toBeNull();
  });

  it("exposes the duration and whether the length can change (R15.9)", () => {
    const d = buildBlockDetail({ block: BLOCK, now: NOW });
    expect(d).toMatchObject({ durationMin: 60, durationLabel: "1 h", lengthEditable: true, lengthDisabledReason: null });

    const short = { ...BLOCK, end: "2025-03-11T19:15:00Z" };
    expect(buildBlockDetail({ block: short, now: NOW })).toMatchObject({ durationMin: 45, durationLabel: "45 min" });
    const long = { ...BLOCK, end: "2025-03-11T20:00:00Z" };
    expect(buildBlockDetail({ block: long, now: NOW }).durationLabel).toBe("1 h 30 min");
  });

  it("disables the length change for started or non-scheduled blocks, with a reason", () => {
    const started = buildBlockDetail({ block: BLOCK, now: Date.parse(BLOCK.start) });
    expect(started.lengthEditable).toBe(false);
    expect(started.lengthDisabledReason).toMatch(/started/);
    for (const status of ["in-progress", "done", "skipped", "missed", "rolled"] as const) {
      const d = buildBlockDetail({ block: { ...BLOCK, status }, now: NOW });
      expect(d.lengthEditable).toBe(false);
      expect(d.lengthDisabledReason).toMatch(/scheduled/);
    }
  });

  it("flags an unanswered miss prompt", () => {
    const d = buildBlockDetail({ block: BLOCK, now: NOW, openPrompts: [{ promptId: "p", blockId: "b1", meetingIds: [], shownAt: 0 }] });
    expect(d.hasOpenPrompt).toBe(true);
  });
});

describe("buildSettingsView", () => {
  const base = {
    settings: { planningMode: "spread" as const, holidays: ["2025-12-25", "2025-07-01"], distractionApps: ["com.instagram.android"] },
    usagePermission: "denied" as const,
    notificationPermission: "granted" as const,
    exactAlarm: { exactAlarmsAvailable: true, reminderTimingMayVary: false },
  };

  it("selects exactly one mode, lists holidays sorted and apps, and shows permission rows", () => {
    const v = buildSettingsView(base);
    expect(v.planningMode.options.filter((o) => o.selected).map((o) => o.value)).toEqual(["spread"]);
    expect(v.holidays).toEqual([
      { date: "2025-07-01", label: "Tue, Jul 1" },
      { date: "2025-12-25", label: "Thu, Dec 25" },
    ]);
    expect(v.distractionApps).toEqual([{ packageName: "com.instagram.android" }]);
    expect(v.permissions).toEqual([
      { id: "usage-access", label: "Usage access", granted: false, statusLabel: "Not granted", action: { label: "Open settings", target: "openUsageAccess" } },
      { id: "notifications", label: "Notifications", granted: true, statusLabel: "Granted", action: { label: "Open settings", target: "openNotificationSettings" } },
    ]);
    expect(v.reminderTimingNote).toBeNull();
  });

  it("treats undetermined notifications as not granted and shows the timing note when inexact", () => {
    const v = buildSettingsView({
      ...base,
      notificationPermission: "undetermined",
      exactAlarm: { exactAlarmsAvailable: false, reminderTimingMayVary: true },
    });
    expect(v.permissions[1]!.statusLabel).toBe("Not granted");
    expect(v.reminderTimingNote).toBe(REMINDER_TIMING_MAY_VARY);
  });
});

describe("buildReviewView", () => {
  const entry = (blockId: string, start: string) => ({
    blockId, itemId: `i-${blockId}`, title: blockId, category: "fitness" as const, start, end: start.replace("T18", "T19"),
  });
  const review: WeeklyReview = {
    weekId: "2025-03-09",
    finished: [entry("f2", "2025-03-12T18:00:00Z"), entry("f1", "2025-03-10T18:00:00Z")],
    partial: [entry("p1", "2025-03-11T18:00:00Z")],
    missed: [entry("m1", "2025-03-13T18:00:00Z")],
    screenTimeMin: 205,
    distractionLevel: "moderate",
    movedToNextWeek: [{ ...entry("r1", "2025-03-14T18:00:00Z"), category: "work", reason: "Didn't fit this week" }],
    photoPrompt: NEXT_WEEK_LIST_PROMPT,
    fitnessMissedCount: 1,
  };

  it("presents finished/partial/missed, usage, moved with reasons, and the next-week prompt", () => {
    const v = buildReviewView("2025-03-09", review);
    expect(v.available).toBe(true);
    expect(v.weekLabel).toBe("Sun, Mar 9 – Sat, Mar 15");
    expect(v.sections.map((s) => [s.title, s.items.map((i) => i.blockId)])).toEqual([
      ["Finished", ["f1", "f2"]],
      ["Partly finished", ["p1"]],
      ["Missed", ["m1"]],
    ]);
    expect(v.sections[0]!.items[0]!.whenLabel).toBe("Mon, Mar 10 · 2:00 PM – 3:00 PM");
    expect(v.screenTime).toEqual({ minutes: 205, label: "3 h 25 min" });
    expect(v.distractionLevel).toEqual({ level: "moderate", label: "Moderate" });
    expect(v.moved).toMatchObject([{ blockId: "r1", categoryLabel: "Work", reason: "Didn't fit this week" }]);
    expect(v.fitnessMissedCount).toBe(1);
    expect(v.nextWeekPrompt).toBe("Paste or type next week's to-do list");
  });

  it("still offers the next-week prompt when no review exists yet", () => {
    const v = buildReviewView("2025-03-09", null);
    expect(v.available).toBe(false);
    expect(v.sections.every((s) => s.items.length === 0)).toBe(true);
    expect(v.screenTime).toBeNull();
    expect(v.nextWeekPrompt).toBe(NEXT_WEEK_LIST_PROMPT);
  });
});
