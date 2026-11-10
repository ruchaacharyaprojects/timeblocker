import { describe, it, expect } from "vitest";
import { weekBounds } from "./engine.js";
import { torontoWeekday, torontoMinutesOfDay } from "./timezone.js";
import { tor } from "./testkit.js";

describe("weekBounds (America/Toronto, Sunday-Saturday)", () => {
  it("returns Sunday 00:00 and following Sunday 00:00 for a mid-week date", () => {
    // 2025-01-15 is a Wednesday.
    const wb = weekBounds("2025-01-15T12:00:00Z");
    expect(wb.sunday).toBe(tor(2025, 1, 12, 0, 0));
    expect(wb.saturday).toBe(tor(2025, 1, 19, 0, 0));
  });

  it("bounds start on Sunday and end on the next Sunday in Toronto", () => {
    const wb = weekBounds("2025-01-15T12:00:00Z");
    expect(torontoWeekday(new Date(wb.sunday))).toBe(0);
    expect(torontoWeekday(new Date(wb.saturday))).toBe(0);
    expect(torontoMinutesOfDay(new Date(wb.sunday))).toBe(0);
    expect(torontoMinutesOfDay(new Date(wb.saturday))).toBe(0);
  });

  it("treats a date already on Sunday as the week start", () => {
    const wb = weekBounds(tor(2025, 1, 12, 9, 0));
    expect(wb.sunday).toBe(tor(2025, 1, 12, 0, 0));
    expect(wb.saturday).toBe(tor(2025, 1, 19, 0, 0));
  });

  it("treats a Saturday night date as the same week", () => {
    const wb = weekBounds(tor(2025, 1, 18, 23, 30));
    expect(wb.sunday).toBe(tor(2025, 1, 12, 0, 0));
    expect(wb.saturday).toBe(tor(2025, 1, 19, 0, 0));
  });

  it("spans exactly 7 Toronto days across a spring-forward DST week", () => {
    // DST begins 2025-03-09 (spring forward). Pick a date in that week.
    const wb = weekBounds(tor(2025, 3, 11, 12, 0));
    expect(wb.sunday).toBe(tor(2025, 3, 9, 0, 0));
    expect(wb.saturday).toBe(tor(2025, 3, 16, 0, 0));
    // That week is 23 hours short of 7*24 due to spring forward.
    const hours =
      (new Date(wb.saturday).getTime() - new Date(wb.sunday).getTime()) /
      3600000;
    expect(hours).toBe(7 * 24 - 1);
  });

  it("spans exactly 7 Toronto days across a fall-back DST week", () => {
    // DST ends 2025-11-02 (fall back).
    const wb = weekBounds(tor(2025, 11, 4, 12, 0));
    expect(wb.sunday).toBe(tor(2025, 11, 2, 0, 0));
    expect(wb.saturday).toBe(tor(2025, 11, 9, 0, 0));
    const hours =
      (new Date(wb.saturday).getTime() - new Date(wb.sunday).getTime()) /
      3600000;
    expect(hours).toBe(7 * 24 + 1);
  });
});
