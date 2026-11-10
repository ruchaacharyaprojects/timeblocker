import { describe, expect, it } from "vitest";
import { runReminderTick } from "./notify.js";
import type { ReminderSources } from "./select.js";
import { RecordingNotificationPort } from "./testkit.js";

const NOW = new Date("2025-01-06T09:00:00.000-05:00");

function afterNow(minutes: number): string {
  return new Date(NOW.getTime() + minutes * 60_000).toISOString();
}

const dueSources: ReminderSources = {
  blocks: [{ id: "b1", title: "Deep work", start: afterNow(16), end: afterNow(76) }],
  meetings: [
    {
      id: "m1",
      summary: "Standup",
      start: afterNow(20),
      end: afterNow(50),
      withOthers: true,
    },
  ],
};

describe("runReminderTick", () => {
  it("delivers every selected reminder through the port", async () => {
    const port = new RecordingNotificationPort();
    const result = await runReminderTick(dueSources, port, NOW);

    expect(result.selected.map((n) => n.id)).toEqual(["block:b1", "meeting:m1"]);
    expect(result.delivered).toEqual(["block:b1", "meeting:m1"]);
    expect(result.failures).toEqual([]);
    expect(port.delivered.map((n) => n.id)).toEqual(["block:b1", "meeting:m1"]);
  });

  it("collects per-notification failures without blocking the rest", async () => {
    const port = new RecordingNotificationPort(new Set(["block:b1"]));
    const result = await runReminderTick(dueSources, port, NOW);

    expect(result.delivered).toEqual(["meeting:m1"]);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0].id).toBe("block:b1");
    expect(port.delivered.map((n) => n.id)).toEqual(["meeting:m1"]);
  });

  it("delivers nothing when no reminders are due", async () => {
    const port = new RecordingNotificationPort();
    const result = await runReminderTick(
      { blocks: [], meetings: [] },
      port,
      NOW,
    );
    expect(result.selected).toEqual([]);
    expect(result.delivered).toEqual([]);
    expect(port.delivered).toEqual([]);
  });
});
