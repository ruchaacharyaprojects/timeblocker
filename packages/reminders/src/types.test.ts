import { describe, expect, it } from "vitest";
import { LEGACY_REMINDER_ACTIONS, REMINDER_ACTIONS } from "./types.js";

describe("reminder actions (R17.4)", () => {
  it("device reminders offer exactly I'll be there and Move to later this week", () => {
    expect(REMINDER_ACTIONS).toEqual([
      { id: "im-in", label: "I'll be there" },
      { id: "move-it", label: "Move to later this week" },
    ]);
  });

  it("keeps the three-button set for the retained backend scheduler", () => {
    expect(LEGACY_REMINDER_ACTIONS.map((a) => a.id)).toEqual(["im-in", "skip", "move-it"]);
  });
});
