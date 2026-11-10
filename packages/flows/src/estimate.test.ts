import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  CATEGORY_DEFAULT_DURATION_MIN,
  estimateCandidate,
  extractInlineDuration,
  inferCategory,
  isSimilar,
  similarity,
  validateIntakeInput,
  type HistoryEntry,
} from "./index.js";

const h = (
  title: string,
  durationMin: number,
  category: HistoryEntry["category"] = "misc",
  status?: string,
): HistoryEntry => ({ title, durationMin, category, ...(status ? { status } : {}) });

describe("extractInlineDuration (R15.2)", () => {
  const cases: Array<[string, string, number]> = [
    ["Write essay 30 min", "Write essay", 30],
    ["Write essay 30 mins", "Write essay", 30],
    ["Write essay 30 minutes", "Write essay", 30],
    ["Run 45m", "Run", 45],
    ["Read 1h", "Read", 60],
    ["Read 1 hr", "Read", 60],
    ["Read 2 hrs", "Read", 120],
    ["Read 1.5 hours", "Read", 90],
    ["Read 1h30", "Read", 90],
    ["Read 1h 30m", "Read", 90],
    ["Read 1 hr 30 min", "Read", 90],
    ["Read for 2 hrs", "Read", 120],
    ["Taxes (90m)", "Taxes", 90],
    ["Gym 3-4pm", "Gym", 60],
    ["Gym @ 3pm-4:30pm", "Gym", 90],
    ["Standup 9:00-10:15", "Standup", 75],
    ["Call 9am to 10am", "Call", 60],
    ["Lunch, 11-1pm", "Lunch", 120],
    ["Email boss, 30 min, then lunch", "Email boss, then lunch", 30],
    ["Call mom (30 min) tonight", "Call mom tonight", 30],
    ["Gym - 1h", "Gym", 60],
  ];
  it.each(cases)("%s", (input, title, mins) => {
    expect(extractInlineDuration(input)).toEqual({ title, durationMin: mins });
  });

  it("rounds to 5 minutes and clamps to 5..2400", () => {
    expect(extractInlineDuration("x 7 min").durationMin).toBe(5);
    expect(extractInlineDuration("x 3 min").durationMin).toBe(5);
    expect(extractInlineDuration("x 12 min").durationMin).toBe(10);
    expect(extractInlineDuration("x 13 min").durationMin).toBe(15);
    expect(extractInlineDuration("x 10 hours").durationMin).toBe(600);
    expect(extractInlineDuration("x 41 hours").durationMin).toBe(2400);
    expect(extractInlineDuration("x 1 min").durationMin).toBe(5);
  });

  it.each([
    "Call 3 people",
    "Chapter 2",
    "Q3 report",
    "Top 5 tasks",
    "Read pages 3-4",
    "Buy 3 meetings",
    "Chapter 2-3",
    "Plan trip 5 to 10 days",
  ])("does not misread %s", (input) => {
    expect(extractInlineDuration(input)).toEqual({ title: input });
  });

  it("ignores ranges that end before they start", () => {
    expect(extractInlineDuration("Gym 5pm-4pm").durationMin).toBeUndefined();
    expect(extractInlineDuration("Gym 10:00-9:00").durationMin).toBeUndefined();
  });

  it("keeps the original text when stripping would empty the title", () => {
    expect(extractInlineDuration("30 min")).toEqual({ title: "30 min", durationMin: 30 });
    expect(extractInlineDuration("for 2 hrs")).toEqual({ title: "for 2 hrs", durationMin: 120 });
  });
});

describe("similarity (R15.3)", () => {
  it("shares at least half the words", () => {
    expect(isSimilar("Morning run", "Run")).toBe(true); // 1/2
    expect(isSimilar("Morning run", "Evening run")).toBe(true); // 1/2
    expect(isSimilar("Write report for client", "Write the report")).toBe(true);
    expect(isSimilar("Morning run", "Read book")).toBe(false);
    expect(isSimilar("Run", "Run the long weekly route")).toBe(false); // 1/4
  });
  it("lowercases, strips punctuation, drops fillers, stems plurals", () => {
    expect(similarity("Emails!", "email")).toBe(1);
    expect(similarity("Do the Laundry", "laundry")).toBe(1);
    expect(similarity("a the of", "a the of")).toBe(0);
  });
  it("never treats empty word sets as similar", () => {
    expect(isSimilar("", "")).toBe(false);
    expect(isSimilar("the", "the")).toBe(false);
    expect(isSimilar("run", "")).toBe(false);
  });
});

describe("inferCategory (R15.5)", () => {
  it.each([
    ["Go to the gym", "fitness"],
    ["Morning RUN", "fitness"],
    ["yoga", "fitness"],
    ["Send email to client", "work"],
    ["Prep slides", "work"],
    ["Study for exam", "self-development"],
    ["Leetcode practice", "self-development"],
    ["Meditate", "self-care"],
    ["Skincare routine", "self-care"],
    ["Self-care evening", "self-care"],
  ] as const)("%s -> %s", (text, cat) => {
    expect(inferCategory(text)).toBe(cat);
  });
  it("is whole-word", () => {
    expect(inferCategory("Prerun")).toBeUndefined();
    expect(inferCategory("Gymnastics")).toBeUndefined();
    expect(inferCategory("Buy groceries")).toBeUndefined();
  });
  it("picks the category with most matches, ties by CATEGORIES order", () => {
    expect(inferCategory("email report then run")).toBe("work");
    expect(inferCategory("run and email")).toBe("fitness"); // tie
  });
});

describe("estimateCandidate precedence (R15.2-R15.6)", () => {
  it("stated beats everything", () => {
    const r = estimateCandidate(
      { text: "Gym 1h", durationMin: 20, category: "work", priority: 1 },
      [h("Gym", 90, "fitness")],
      [h("Gym", 100)],
    );
    expect(r).toMatchObject({
      text: "Gym",
      durationMin: 20,
      category: "work",
      priority: 1,
      lowConfidence: false,
      source: { duration: "stated", category: "stated" },
    });
  });
  it("inline duration counts as stated and beats history", () => {
    const r = estimateCandidate({ text: "Gym 1h" }, [h("Gym", 90, "fitness")], []);
    expect(r.durationMin).toBe(60);
    expect(r.source).toEqual({ duration: "stated", category: "history" });
  });
  it("history blocks beat events beat default", () => {
    const blocks = [h("Write report", 50, "work")];
    const events = [h("Write report", 20)];
    expect(estimateCandidate({ text: "Write report" }, blocks, events)).toMatchObject({
      durationMin: 50,
      category: "work",
      lowConfidence: false,
      source: { duration: "history", category: "history" },
    });
    expect(estimateCandidate({ text: "Write report" }, [], events)).toMatchObject({
      durationMin: 20,
      category: "work", // keyword
      lowConfidence: true,
      source: { duration: "calendar", category: "keyword" },
    });
    expect(estimateCandidate({ text: "Write report" }, [], [])).toMatchObject({
      durationMin: 60,
      source: { duration: "default", category: "keyword" },
    });
  });
  it("no history: category defaults", () => {
    for (const [text, cat] of [
      ["Email Bob", "work"],
      ["Study", "self-development"],
      ["Yoga", "fitness"],
      ["Nap", "self-care"],
      ["Pay rent", "misc"],
    ] as const) {
      const r = estimateCandidate({ text }, [], []);
      expect(r.category).toBe(cat);
      expect(r.durationMin).toBe(CATEGORY_DEFAULT_DURATION_MIN[cat]);
      expect(r.priority).toBe(3);
    }
    expect(estimateCandidate({ text: "Pay rent" }, [], [])).toMatchObject({
      lowConfidence: true,
      source: { duration: "default", category: "default" },
    });
  });
  it("exposes the default table", () => {
    expect(CATEGORY_DEFAULT_DURATION_MIN).toEqual({
      work: 60,
      "self-development": 45,
      fitness: 45,
      "self-care": 30,
      misc: 30,
    });
  });
});

describe("estimateCandidate median, category and filters", () => {
  it("uses the median (odd count)", () => {
    const hist = [h("Gym", 30), h("Gym", 90), h("Gym", 60)];
    expect(estimateCandidate({ text: "Gym" }, hist, []).durationMin).toBe(60);
  });
  it("averages the two middle values then rounds to 5 (even count)", () => {
    expect(
      estimateCandidate({ text: "Gym" }, [h("Gym", 30), h("Gym", 45)], []).durationMin,
    ).toBe(40); // 37.5 -> 40
  });
  it("rounds to nearest 5 and clamps", () => {
    expect(estimateCandidate({ text: "Gym" }, [h("Gym", 52)], []).durationMin).toBe(50);
    expect(estimateCandidate({ text: "Gym" }, [h("Gym", 1)], []).durationMin).toBe(5);
    expect(estimateCandidate({ text: "Gym" }, [h("Gym", 9999)], []).durationMin).toBe(480);
  });
  it("ignores skipped blocks for duration but not for category", () => {
    const hist = [h("Gym", 120, "fitness", "skipped"), h("Gym", 40, "fitness", "done")];
    const r = estimateCandidate({ text: "Gym" }, hist, []);
    expect(r.durationMin).toBe(40);
    const onlySkipped = estimateCandidate(
      { text: "Gym" },
      [h("Gym", 120, "fitness", "skipped")],
      [],
    );
    expect(onlySkipped.source.duration).toBe("default");
    expect(onlySkipped.source.category).toBe("history");
  });
  it("ignores dissimilar history", () => {
    const r = estimateCandidate({ text: "Gym" }, [h("Read book", 90, "self-development")], []);
    expect(r.source).toEqual({ duration: "default", category: "keyword" });
  });
  it("most common history category wins; ties go to the first in input order", () => {
    const mostCommon = [h("Gym", 30, "work"), h("Gym", 30, "fitness"), h("Gym", 30, "fitness")];
    expect(estimateCandidate({ text: "Gym" }, mostCommon, []).category).toBe("fitness");
    const tie = [h("Gym", 30, "work"), h("Gym", 30, "fitness")];
    expect(estimateCandidate({ text: "Gym" }, tie, []).category).toBe("work");
  });
  it("history category beats keywords", () => {
    const r = estimateCandidate({ text: "Gym" }, [h("Gym", 30, "self-care")], []);
    expect(r.category).toBe("self-care");
  });
});

describe("validateIntakeInput with estimation (R15.6)", () => {
  const ok = (raw: string, hist?: Parameters<typeof validateIntakeInput>[1]) => {
    const r = validateIntakeInput(raw, hist);
    if (!r.ok) throw new Error("expected ok");
    return r.candidates;
  };

  it("no history: extracts inline durations and keywords", () => {
    const [a, b, c] = ok("Gym 1h\nEmail Bob\nPay rent");
    expect(a).toMatchObject({ text: "Gym", durationMin: 60, category: "fitness" });
    expect(b).toMatchObject({ durationMin: 60, category: "work" });
    expect(c).toMatchObject({ durationMin: 30, category: "misc", priority: 3 });
  });
  it("explicit pipe values are never overridden", () => {
    const [a] = ok("Gym 1h | 20 | 1 | work", {
      blocks: [h("Gym", 90, "fitness")],
      events: [],
    });
    expect(a).toMatchObject({
      durationMin: 20,
      priority: 1,
      category: "work",
      source: { duration: "stated", category: "stated" },
    });
  });
  it("explicit JSON values are kept; only missing fields are estimated", () => {
    const [a] = ok(JSON.stringify([{ text: "Gym", durationMin: 25 }]), {
      blocks: [h("Gym", 90, "self-care")],
      events: [],
    });
    expect(a).toMatchObject({
      durationMin: 25,
      category: "self-care",
      source: { duration: "stated", category: "history" },
    });
  });
  it("uses history when supplied", () => {
    const [a] = ok("Write report", { blocks: [h("Write report", 75, "work")], events: [] });
    expect(a).toMatchObject({ durationMin: 75, lowConfidence: false });
  });
  it("a low reported confidence still flags the row", () => {
    const [a] = ok(JSON.stringify([{ text: "Gym", durationMin: 30, category: "fitness", confidence: 0.1 }]));
    expect(a!.lowConfidence).toBe(true);
  });
});

describe("estimateCandidate properties", () => {
  // Feature: timeblocker, Property 24: Estimated durations are valid
  it("estimated durations are multiples of 5 within 5..480", () => {
    fc.assert(
      fc.property(
        fc.string(),
        fc.array(
          fc.record({
            title: fc.string(),
            category: fc.constantFrom("fitness", "work", "misc" as const),
            durationMin: fc.integer({ min: -100, max: 2000 }),
          }),
          { maxLength: 6 },
        ),
        (text, hist) => {
          const history = hist as HistoryEntry[];
          const r = estimateCandidate({ text: text || "x" }, history, history);
          expect(Number.isInteger(r.durationMin)).toBe(true);
          expect(r.durationMin % 5).toBe(0);
          expect(r.durationMin).toBeGreaterThanOrEqual(5);
          expect(r.durationMin).toBeLessThanOrEqual(480);
        },
      ),
      { numRuns: 200 },
    );
  });
});

describe("duration from completed blocks (R23.4)", () => {
  it("uses only done/partial blocks when any exist", () => {
    const hist = [
      h("Gym", 120, "fitness", "missed"),
      h("Gym", 100, "fitness", "scheduled"),
      h("Gym", 40, "fitness", "done"),
      h("Gym", 50, "fitness", "partial"),
    ];
    // median of [40, 50] = 45
    expect(estimateCandidate({ text: "Gym" }, hist, []).durationMin).toBe(45);
  });

  it("falls back to all similar except skipped when none completed", () => {
    const hist = [
      h("Gym", 120, "fitness", "skipped"),
      h("Gym", 60, "fitness", "missed"),
      h("Gym", 30, "fitness", "scheduled"),
    ];
    // median of [60, 30] = 45
    expect(estimateCandidate({ text: "Gym" }, hist, []).durationMin).toBe(45);
  });
});
