import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { estimateCandidate, splitTotal, validateIntakeInput } from "./index.js";

const est = (text: string, extra: { durationMin?: number } = {}) =>
  estimateCandidate({ text, ...extra }, [], []);

function candidates(raw: string) {
  const r = validateIntakeInput(raw);
  if (!r.ok) throw new Error(r.reason);
  return r;
}

const REAL = [
  "Go to the gym x 3 – Legs/Chest/Full Body",
  "Study for cloud certification exam – 10 hours",
  "Do laundry",
  "Go grocery shopping",
  "Meal prep – 40 minutes, twice this week",
  "Get 8 hours of sleep every night",
  "Study AI concepts",
  "Build out networking project – 6 hours",
].join("\n");

describe("real-world lines (R22)", () => {
  const r = candidates(REAL);
  const by = (prefix: string) => r.candidates.find((c) => c.text.startsWith(prefix))!;

  it("ignores the sleep line", () => {
    expect(r.ignored).toEqual([{ text: "Get 8 hours of sleep every night", reason: "sleep" }]);
    expect(r.candidates).toHaveLength(7);
  });
  it("gym: count 3, 45 min, fitness, descriptive tail kept", () => {
    const c = by("Go to the gym");
    expect(c).toMatchObject({
      text: "Go to the gym – Legs/Chest/Full Body",
      count: 3,
      durationMin: 45,
      category: "fitness",
    });
  });
  it("study cloud: 5 x 120, self-development", () => {
    expect(by("Study for cloud")).toMatchObject({
      text: "Study for cloud certification exam",
      count: 5,
      durationMin: 120,
      category: "self-development",
      splitFromTotalMin: 600,
    });
  });
  it("laundry and groceries: one misc block", () => {
    expect(by("Do laundry")).toMatchObject({ count: 1, durationMin: 30, category: "misc" });
    expect(by("Go grocery")).toMatchObject({ count: 1, durationMin: 30, category: "misc" });
  });
  it("meal prep: twice, 40 min, clean title", () => {
    expect(by("Meal prep")).toMatchObject({ text: "Meal prep", count: 2, durationMin: 40 });
  });
  it("study AI concepts: self-development", () => {
    expect(by("Study AI")).toMatchObject({ count: 1, category: "self-development" });
  });
  it("networking: 3 x 120", () => {
    expect(by("Build out")).toMatchObject({
      text: "Build out networking project",
      count: 3,
      durationMin: 120,
    });
  });
});

describe("splitting boundaries (R22.1)", () => {
  it("180 stays one block, 181 splits in two", () => {
    expect(est("Read – 3 hours")).toMatchObject({ count: 1, durationMin: 180 });
    // Inline totals are rounded to 5 first (181 -> 180); explicit minutes are exact.
    expect(est("Read – 181 min")).toMatchObject({ count: 1, durationMin: 180 });
    expect(est("Read", { durationMin: 181 })).toMatchObject({ count: 2, durationMin: 90 });
    expect(est("Read – 185 min")).toMatchObject({ count: 2, durationMin: 95 });
  });
  it("examples", () => {
    expect(est("Read – 4 hours")).toMatchObject({ count: 2, durationMin: 120 });
    expect(est("Read – 200 minutes")).toMatchObject({ count: 2, durationMin: 100 });
  });
  it("40h is accepted (capped at 14 sessions of 120), 41h clamps to the same", () => {
    expect(est("Read – 40 hours")).toMatchObject({
      count: 14,
      durationMin: 120,
      splitFromTotalMin: 2400,
    });
    expect(est("Read – 41 hours")).toMatchObject({ count: 14, durationMin: 120, splitFromTotalMin: 2400 });
  });
  it("a count disables splitting", () => {
    expect(est("Gym 3x 45 min")).toMatchObject({ count: 3, durationMin: 45 });
    const r = est("Study 4x 3h");
    expect(r).toMatchObject({ count: 4, durationMin: 180 });
    expect(r.splitFromTotalMin).toBeUndefined();
    expect(est("Study 2x 10h").durationMin).toBe(480);
  });
  it("explicit duration over 180 splits; over 480 is clamped first", () => {
    expect(est("Project", { durationMin: 360 })).toMatchObject({ count: 3, durationMin: 120 });
    expect(est("Project", { durationMin: 900 })).toMatchObject({ count: 4, durationMin: 120 });
    const r = candidates("Project | 360");
    expect(r.candidates[0]).toMatchObject({ count: 3, durationMin: 120 });
    const j = candidates('[{"text":"Project","durationMin":240}]');
    expect(j.candidates[0]).toMatchObject({ count: 2, durationMin: 120 });
  });
});

describe("title cleanup (R22.2)", () => {
  it.each([
    ["Study - 10 hours", "Study"],
    ["Study – 10 hours", "Study"],
    ["Study — 10 hours", "Study"],
    ["Study, 10 hours", "Study"],
    ["Study: 10 hours", "Study"],
    ["Study (10 hours)", "Study"],
    ["Meal prep – 40 minutes, twice this week", "Meal prep"],
    ["Meal prep, twice this week – 40 minutes", "Meal prep"],
    ["Meal prep 2x – 40 min", "Meal prep"],
  ])("%s", (input, title) => {
    expect(est(input).text).toBe(title);
  });
  it("keeps a descriptive tail and never empties the title", () => {
    expect(est("Gym x 3 – Legs").text).toBe("Gym – Legs");
    expect(est("2 hours").text).toBe("2 hours");
  });
});

describe("sleep lines (R22.3)", () => {
  it.each(["Sleep 8 hours", "Take a nap", "Bedtime routine", "bed time"])("%s ignored", (t) => {
    expect(validateIntakeInput(`${t}\nLaundry`)).toMatchObject({
      ok: true,
      ignored: [{ text: t, reason: "sleep" }],
    });
  });
  it("only sleep lines is no-items; JSON items too", () => {
    expect(validateIntakeInput("Sleep well")).toEqual({ ok: false, reason: "no-items" });
    const r = validateIntakeInput('[{"text":"Nap"},{"text":"Laundry"}]');
    expect(r).toMatchObject({ ok: true, ignored: [{ text: "Nap", reason: "sleep" }] });
  });
  it("does not match words containing sleep-ish substrings", () => {
    expect(validateIntakeInput("Nape of neck stretch")).toMatchObject({ ok: true, ignored: [] });
  });
});

describe("split properties", () => {
  // Feature: timeblocker, Property 31: Split sessions sum to about the total and each is within 5..120
  it("sessions sum to about the total, each within 5..120, count <= 14", () => {
    fc.assert(
      fc.property(fc.integer({ min: 181, max: 2400 }), (total) => {
        const { count, durationMin } = splitTotal(total);
        expect(count).toBeLessThanOrEqual(14);
        expect(durationMin).toBeGreaterThanOrEqual(5);
        expect(durationMin).toBeLessThanOrEqual(120);
        if (total <= 14 * 120) {
          expect(Math.abs(count * durationMin - total)).toBeLessThanOrEqual(2.5 * count);
        } else {
          expect(count).toBe(14);
          expect(durationMin).toBe(120);
        }
      }),
      { numRuns: 500 },
    );
  });
});
