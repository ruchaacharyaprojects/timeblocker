import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  estimateCandidate,
  extractCount,
  isSimilar,
  parseItemList,
  similarity,
  validateIntakeInput,
} from "./index.js";

describe("extractCount forms (R20.2)", () => {
  const cases: Array<[string, string, number]> = [
    ["Gym 3x", "Gym", 3],
    ["Gym 3X", "Gym", 3],
    ["Gym 3 x", "Gym", 3],
    ["Gym x3", "Gym", 3],
    ["Gym x 3", "Gym", 3],
    ["Gym 3 times", "Gym", 3],
    ["Gym 3 sessions", "Gym", 3],
    ["Gym 3 days a week", "Gym", 3],
    ["Gym 3 days per week", "Gym", 3],
    ["Gym 3 days this week", "Gym", 3],
    ["Gym 3 days each week", "Gym", 3],
    ["Gym 3 times a week", "Gym", 3],
    ["Gym 3x a week", "Gym", 3],
    ["Gym 3x/week", "Gym", 3],
    ["Gym 3x per week", "Gym", 3],
    ["Gym 3 times this week", "Gym", 3],
    ["Gym 3 sessions each week", "Gym", 3],
    ["Gym once", "Gym", 1],
    ["Gym once a week", "Gym", 1],
    ["Gym twice", "Gym", 2],
    ["Gym twice per week", "Gym", 2],
    ["Gym Thrice", "Gym", 3],
    ["Gym thrice this week", "Gym", 3],
    ["Gym three times", "Gym", 3],
    ["Gym One times", "Gym", 1],
    ["Gym seven times a week", "Gym", 7],
    ["Gym (3x)", "Gym", 3],
    ["3x gym", "gym", 3],
    ["Gym 14x", "Gym", 14],
    ["Gym 1x", "Gym", 1],
  ];
  for (const [input, title, count] of cases) {
    it(`${JSON.stringify(input)} -> ${title} / ${count}`, () => {
      expect(extractCount(input)).toEqual({ title, count });
    });
  }

  it("uses the last count phrase when several appear", () => {
    expect(extractCount("Gym 2x then 4 times")).toEqual({ title: "Gym 2x then", count: 4 });
  });

  it("keeps the original text when stripping would empty the title", () => {
    expect(extractCount("3x")).toEqual({ title: "3x" });
    expect(extractCount("twice a week")).toEqual({ title: "twice a week" });
  });
});

describe("extractCount negatives (R20.3)", () => {
  const same = [
    "Call 3 people",
    "Chapter 2",
    "Top 5 tasks",
    "Q3 report",
    "Study 2-3",
    "Call mom once she is home",
    "Do it twice as fast",
    "Buy 2x4 lumber",
    "Gym 0x",
    "Gym 15x",
    "Gym 15 times",
    "Gym 0 times",
    "Gym 20 days a week",
    "Gym eight times",
    "Read 3 chapters",
    "Meet x",
    "Gym x0",
    "Gym x15",
    "a few times",
  ];
  for (const input of same) {
    it(`leaves ${JSON.stringify(input)} untouched`, () => {
      expect(extractCount(input)).toEqual({ title: input });
    });
  }

  it("accepts the 14 boundary and rejects 15 in the same text", () => {
    expect(extractCount("Gym 14 times")).toEqual({ title: "Gym", count: 14 });
    expect(extractCount("Gym 15 times").count).toBeUndefined();
  });
});

describe("count combined with durations (R20.4)", () => {
  const cases: Array<[string, string, number, number]> = [
    ["Gym 3x 45 min", "Gym", 45, 3],
    ["Gym 45 min x3", "Gym", 45, 3],
    ["3x gym for 1h", "gym", 60, 3],
    ["Gym 3 times a week, 1h", "Gym", 60, 3],
    ["Gym twice 30 min", "Gym", 30, 2],
  ];
  for (const [input, title, durationMin, count] of cases) {
    it(`${JSON.stringify(input)}`, () => {
      const r = estimateCandidate({ text: input }, [], []);
      expect(r.text).toBe(title);
      expect(r.durationMin).toBe(durationMin);
      expect(r.count).toBe(count);
    });
  }

  it("defaults count to 1 and leaves bare numbers alone", () => {
    const r = estimateCandidate({ text: "Call 3 people" }, [], []);
    expect(r.count).toBe(1);
    expect(r.text).toBe("Call 3 people");
  });

  it("a stated count wins over an inline one; invalid stated falls back", () => {
    expect(estimateCandidate({ text: "Gym 3x", count: 5 }, [], []).count).toBe(5);
    expect(estimateCandidate({ text: "Gym 3x", count: 99 }, [], []).count).toBe(3);
    expect(estimateCandidate({ text: "Gym 3x", count: 99 }, [], []).text).toBe("Gym");
  });
});

describe("explicit counts in the pipe form and JSON", () => {
  it("pipe form: fifth field", () => {
    const r = parseItemList("Gym | 45 | 2 | fitness | 4");
    expect(r.items[0]!.count).toBe(4);
  });
  it("JSON: count and times", () => {
    const r = parseItemList(JSON.stringify([{ text: "A", count: 3 }, { text: "B", times: 2 }, { text: "C", count: 20 }]));
    expect(r.items.map((i) => i.count)).toEqual([3, 2, undefined]);
  });
  it("validateIntakeInput honours stated over inline", () => {
    const r = validateIntakeInput("Gym 3x | 45 | 2 | fitness | 4");
    expect(r.ok && r.candidates[0]!.count).toBe(4);
    const j = validateIntakeInput(JSON.stringify([{ text: "Gym 3x", count: 2 }]));
    expect(j.ok && j.candidates[0]!.count).toBe(2);
  });
  it("candidates default to count 1", () => {
    const r = validateIntakeInput("A\nB");
    expect(r.ok && r.candidates.map((c) => c.count)).toEqual([1, 1]);
  });
});

describe("expanded 100-item limit (R20.6)", () => {
  it("accepts exactly 100 expanded items", () => {
    const lines = [...Array.from({ length: 90 }, (_, i) => `Task ${i}`), "Gym 10x"].join("\n");
    expect(validateIntakeInput(lines).ok).toBe(true);
  });
  it("rejects when the expanded total exceeds 100", () => {
    const lines = [...Array.from({ length: 95 }, (_, i) => `Task ${i}`), "Gym 10x"].join("\n");
    expect(validateIntakeInput(lines)).toEqual({ ok: false, reason: "too-many-items" });
  });
  it("still rejects 101 plain lines", () => {
    const lines = Array.from({ length: 101 }, (_, i) => `Task ${i}`).join("\n");
    expect(validateIntakeInput(lines)).toEqual({ ok: false, reason: "too-many-items" });
  });
});

describe("similarity ignores (i of n) suffixes (R20.5)", () => {
  it("treats 'Gym (2 of 3)' as similar to 'Gym'", () => {
    expect(similarity("Gym (2 of 3)", "Gym")).toBe(1);
    expect(isSimilar("Gym (2 of 3)", "Gym")).toBe(true);
    expect(similarity("Read book (1 of 4)", "Read book (3 of 4)")).toBe(1);
  });
  it("uses suffixed history for duration estimation", () => {
    const r = estimateCandidate({ text: "Gym" }, [{ title: "Gym (2 of 3)", category: "fitness", durationMin: 50 }], []);
    expect(r.durationMin).toBe(50);
    expect(r.source?.duration).toBe("history");
  });
});

describe("extractCount properties", () => {
  // Feature: timeblocker, Property 27: Counts are within 1..14 and bare numbers never count
  const titleArb = fc
    .array(fc.constantFrom("gym", "read", "call", "plan", "study", "write", "Mom", "report"), {
      minLength: 1,
      maxLength: 4,
    })
    .map((w) => w.join(" "));

  it("text without count tokens has no count and is unchanged", () => {
    fc.assert(
      fc.property(titleArb, fc.option(fc.integer({ min: 0, max: 999 }), { nil: undefined }), (title, n) => {
        const text = n === undefined ? title : `${title} ${n}`;
        const r = extractCount(text);
        expect(r.count).toBeUndefined();
        expect(r.title).toBe(text);
      }),
      { numRuns: 200 },
    );
  });

  it("`${title} ${n}x` gives count n and strips it, for n in 1..14", () => {
    fc.assert(
      fc.property(titleArb, fc.integer({ min: 1, max: 14 }), (title, n) => {
        const r = extractCount(`${title} ${n}x`);
        expect(r.count).toBe(n);
        expect(r.title).toBe(title);
      }),
      { numRuns: 200 },
    );
  });

  it("counts outside 1..14 are never returned", () => {
    fc.assert(
      fc.property(
        titleArb,
        fc.oneof(fc.integer({ min: 15, max: 999 }), fc.constant(0)),
        (title, n) => {
          const text = `${title} ${n}x`;
          expect(extractCount(text)).toEqual({ title: text });
        },
      ),
      { numRuns: 100 },
    );
  });
});
