import { describe, expect, it } from "vitest";
import {
  clampApplicationHelpRequest,
  isApplicationHelpMode,
  limitWords,
  validateApplicationHelpResponse,
  validateParseTasksResponse,
} from "./contract.js";

const item = (index: number, category = "work", kind = "task") => ({ index, category, kind });

describe("validateParseTasksResponse", () => {
  it("accepts exactly one entry per title, in order", () => {
    const out = validateParseTasksResponse(
      { items: [item(0, "fitness", "workout"), item(1, "misc", "other")] },
      2,
    );
    expect(out).toEqual([
      { index: 0, category: "fitness", kind: "workout" },
      { index: 1, category: "misc", kind: "other" },
    ]);
  });

  it("drops unknown extra fields from entries", () => {
    const out = validateParseTasksResponse({ items: [{ ...item(0), title: "hacked", durationMin: 5 }] }, 1);
    expect(out).toEqual([{ index: 0, category: "work", kind: "task" }]);
  });

  it.each([
    ["wrong count (fewer)", { items: [item(0)] }, 2],
    ["wrong count (more)", { items: [item(0), item(1), item(2)] }, 2],
    ["out-of-order index", { items: [item(1), item(0)] }, 2],
    ["duplicate index", { items: [item(0), item(0)] }, 2],
    ["unknown category", { items: [item(0, "chores")] }, 1],
    ["unknown kind", { items: [item(0, "work", "meeting")] }, 1],
    ["category not a string", { items: [{ index: 0, category: 3, kind: "task" }] }, 1],
    ["missing kind", { items: [{ index: 0, category: "work" }] }, 1],
    ["string index", { items: [{ index: "0", category: "work", kind: "task" }] }, 1],
    ["entry not an object", { items: ["work"] }, 1],
    ["items not an array", { items: "x" }, 1],
    ["not an object", [item(0)], 1],
    ["null", null, 1],
    ["code-fenced string", "```json\n{}\n```", 1],
  ])("rejects %s", (_name, data, count) => {
    expect(validateParseTasksResponse(data, count as number)).toBeUndefined();
  });

  it("rejects a nonsensical expected count", () => {
    expect(validateParseTasksResponse({ items: [] }, 0)).toBeUndefined();
    expect(validateParseTasksResponse({ items: Array.from({ length: 41 }, (_, i) => item(i)) }, 41)).toBeUndefined();
  });
});

describe("validateApplicationHelpResponse", () => {
  const point = { text: "Led a team", quote: "led a team of four" };

  it("accepts an application reply and trims", () => {
    const out = validateApplicationHelpResponse("application", {
      points: [{ text: "  Led a team ", quote: " led a team of four " }],
      missing: ["Add your own example for: SQL"],
      draft: "  I led a team.  ",
      checklist: ["Résumé", "Cover letter"],
    });
    expect(out).toEqual({
      points: [point],
      missing: ["Add your own example for: SQL"],
      draft: "I led a team.",
      checklist: ["Résumé", "Cover letter"],
    });
  });

  it("allows no points and an empty draft (nothing verified)", () => {
    expect(
      validateApplicationHelpResponse("application", { points: [], missing: ["Add your own example for: x"], draft: "" }),
    ).toEqual({ points: [], missing: ["Add your own example for: x"], draft: "" });
  });

  it("cuts a draft to 120 words", () => {
    const draft = Array.from({ length: 200 }, (_, i) => `w${i}`).join(" ");
    const out = validateApplicationHelpResponse("application", { points: [], missing: [], draft }) as {
      draft: string;
    };
    expect(out.draft.split(/\s+/)).toHaveLength(120);
    expect(out.draft.endsWith("w119")).toBe(true);
  });

  it("cuts an email body to 120 words and keeps the subject", () => {
    const body = Array.from({ length: 150 }, (_, i) => `b${i}`).join(" ");
    const out = validateApplicationHelpResponse("email", { subject: " Hello ", body }) as {
      subject: string;
      body: string;
    };
    expect(out.subject).toBe("Hello");
    expect(out.body.split(/\s+/)).toHaveLength(120);
  });

  it("accepts study steps (1 to 6)", () => {
    expect(validateApplicationHelpResponse("study", { steps: ["a", " b "] })).toEqual({ steps: ["a", "b"] });
  });

  it.each([
    ["point without quote", "application", { points: [{ text: "x" }], missing: [], draft: "" }],
    ["point with empty quote", "application", { points: [{ text: "x", quote: " " }], missing: [], draft: "" }],
    ["points not an array", "application", { points: "x", missing: [], draft: "" }],
    ["too many points", "application", { points: Array(9).fill(point), missing: [], draft: "" }],
    ["missing not strings", "application", { points: [], missing: [1], draft: "" }],
    ["draft missing", "application", { points: [], missing: [] }],
    ["draft not a string", "application", { points: [], missing: [], draft: 4 }],
    ["checklist wrong type", "application", { points: [], missing: [], draft: "", checklist: "x" }],
    ["application shape in email mode", "email", { points: [], missing: [], draft: "" }],
    ["email missing body", "email", { subject: "s" }],
    ["email empty subject", "email", { subject: "  ", body: "b" }],
    ["study with 7 steps", "study", { steps: Array(7).fill("s") }],
    ["study with 0 steps", "study", { steps: [] }],
    ["study step too long", "study", { steps: ["x".repeat(401)] }],
    ["not an object", "study", ["a"]],
    ["null", "email", null],
  ])("rejects %s", (_name, mode, data) => {
    expect(validateApplicationHelpResponse(mode as "study", data)).toBeUndefined();
  });

  it("rejects an unknown mode", () => {
    expect(validateApplicationHelpResponse("poem" as never, { steps: ["a"] })).toBeUndefined();
  });
});

describe("limitWords", () => {
  it("keeps short text and trims", () => {
    expect(limitWords("  a b c  ", 5)).toBe("a b c");
    expect(limitWords("", 5)).toBe("");
  });

  it("keeps line breaks inside the kept words", () => {
    expect(limitWords("a b\nc d e", 4)).toBe("a b\nc d");
  });
});

describe("clampApplicationHelpRequest / isApplicationHelpMode", () => {
  it("caps every free-text field and drops blanks", () => {
    const out = clampApplicationHelpRequest({
      mode: "application",
      title: "t".repeat(500),
      job: "j".repeat(7000),
      question: "q".repeat(700),
      background: "b".repeat(4000),
      intent: "   ",
    });
    expect(out.title).toHaveLength(200);
    expect(out.job).toHaveLength(6000);
    expect(out.question).toHaveLength(600);
    expect(out.background).toHaveLength(3000);
    expect(out).not.toHaveProperty("intent");
  });

  it("knows the three modes", () => {
    expect(["application", "email", "study"].every(isApplicationHelpMode)).toBe(true);
    expect(isApplicationHelpMode("poem")).toBe(false);
    expect(isApplicationHelpMode(undefined)).toBe(false);
  });
});
