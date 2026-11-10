import { beforeEach, describe, expect, it } from "vitest";
import {
  CATEGORIES,
  DEFAULT_CATEGORY,
  DEFAULT_DURATION_MIN,
  DEFAULT_PRIORITY,
  LOW_CONFIDENCE_THRESHOLD,
  applyEdit,
  confirmItems,
  extractItems,
  normalizeCategory,
  normalizeDuration,
  normalizePriority,
  parseItemList,
  toIntakeItem,
  type IdGenerator,
  type IntakeDeps,
  type IntakeItem,
  type ItemsStore,
  type PlanningTrigger,
} from "../lambda/intake/intake.js";

const WEEK_ID = "2025-01-05";

// --- In-memory fakes for the injected ports --------------------------------

class FakeItemsStore implements ItemsStore {
  rows = new Map<string, IntakeItem>();
  putCalls: IntakeItem[][] = [];
  constructor(seed: IntakeItem[] = []) {
    for (const r of seed) this.rows.set(r.id, r);
  }
  async putItems(items: IntakeItem[]): Promise<void> {
    this.putCalls.push(items.map((i) => ({ ...i })));
    for (const i of items) this.rows.set(i.id, { ...i });
  }
  async readItems(weekId: string): Promise<IntakeItem[]> {
    return [...this.rows.values()].filter((i) => i.weekId === weekId);
  }
}

class FakePlanning implements PlanningTrigger {
  triggered: string[] = [];
  async triggerPlanning(weekId: string): Promise<void> {
    this.triggered.push(weekId);
  }
}

class SeqIds implements IdGenerator {
  private n = 0;
  next(): string {
    this.n += 1;
    return `item-${this.n}`;
  }
}

function makeDeps(opts: {
  seed?: IntakeItem[];
} = {}): {
  deps: IntakeDeps;
  items: FakeItemsStore;
  planning: FakePlanning;
} {
  const items = new FakeItemsStore(opts.seed);
  const planning = new FakePlanning();
  const ids = new SeqIds();
  return { deps: { items, planning, ids }, items, planning };
}

function makeItem(over: Partial<IntakeItem> = {}): IntakeItem {
  return {
    id: "item-1",
    text: "do taxes",
    durationMin: 60,
    priority: 2,
    category: "work",
    confirmed: false,
    weekId: WEEK_ID,
    ...over,
  };
}

// --- parseItemList (R1.1 pasted/typed parsing) -----------------------------

describe("parseItemList", () => {
  it("parses a JSON array of item objects with all fields", () => {
    const raw = JSON.stringify([
      {
        text: "Finish report",
        durationMin: 90,
        priority: 1,
        category: "work",
        confidence: 0.9,
      },
      { text: "Morning run", durationMin: 45, priority: 2, category: "fitness" },
    ]);
    const result = parseItemList(raw);
    expect(result.items).toHaveLength(2);
    expect(result.items[0]).toEqual({
      text: "Finish report",
      durationMin: 90,
      priority: 1,
      category: "work",
      confidence: 0.9,
    });
    expect(result.items[1]).toEqual({
      text: "Morning run",
      durationMin: 45,
      priority: 2,
      category: "fitness",
    });
  });

  it("parses a JSON object of the form {items:[...], confidence}", () => {
    const raw = JSON.stringify({
      confidence: 0.8,
      items: [{ text: "Read a chapter" }, { text: "Call mom", priority: 4 }],
    });
    const result = parseItemList(raw);
    expect(result.confidence).toBe(0.8);
    expect(result.items).toEqual([
      { text: "Read a chapter" },
      { text: "Call mom", priority: 4 },
    ]);
  });

  it("drops JSON entries without usable text", () => {
    const raw = JSON.stringify([{ durationMin: 30 }, { text: "   " }, { text: "real" }]);
    const result = parseItemList(raw);
    expect(result.items.map((i) => i.text)).toEqual(["real"]);
  });

  it("parses plain text, one item per line, trimming blanks", () => {
    const raw = "Finish report\n  Morning run  \n\nRead a chapter\n";
    const result = parseItemList(raw);
    expect(result.items).toEqual([
      { text: "Finish report" },
      { text: "Morning run" },
      { text: "Read a chapter" },
    ]);
  });

  it("parses pipe-delimited lines into text | minutes | priority | category", () => {
    const raw = [
      "Finish report | 90 | 1 | work",
      "Morning run | 45 | 2 | fitness",
      "Just text only",
      "Partial pipes | 30",
    ].join("\n");
    const result = parseItemList(raw);
    expect(result.items[0]).toEqual({
      text: "Finish report",
      durationMin: 90,
      priority: 1,
      category: "work",
    });
    expect(result.items[1]).toEqual({
      text: "Morning run",
      durationMin: 45,
      priority: 2,
      category: "fitness",
    });
    expect(result.items[2]).toEqual({ text: "Just text only" });
    expect(result.items[3]).toEqual({ text: "Partial pipes", durationMin: 30 });
  });

  it("yields no items for a malformed JSON-looking payload", () => {
    // A leading brace makes this look like JSON; it is not valid and must not
    // be mangled into junk text items either.
    expect(parseItemList("{ not valid json").items).toEqual([]);
    // Valid JSON object that is not an item list is treated as malformed.
    expect(parseItemList(JSON.stringify({ foo: "bar" })).items).toEqual([]);
    // An empty JSON array parses to zero items (also surfaced as a failure).
    expect(parseItemList("[]").items).toEqual([]);
  });

  it("yields no items for an empty/whitespace payload", () => {
    expect(parseItemList("").items).toEqual([]);
    expect(parseItemList("   \n  \n").items).toEqual([]);
  });
});

// --- Normalization ---------------------------------------------------------

describe("normalizeDuration", () => {
  it("defaults missing/invalid/zero durations", () => {
    expect(normalizeDuration(undefined)).toBe(DEFAULT_DURATION_MIN);
    expect(normalizeDuration(0)).toBe(DEFAULT_DURATION_MIN);
    expect(normalizeDuration(-10)).toBe(DEFAULT_DURATION_MIN);
    expect(normalizeDuration(Number.NaN)).toBe(DEFAULT_DURATION_MIN);
  });

  it("rounds and clamps to the sane range", () => {
    expect(normalizeDuration(45.4)).toBe(45);
    expect(normalizeDuration(2)).toBe(5); // below the 5-min floor
    expect(normalizeDuration(100000)).toBe(8 * 60); // above the 8h ceiling
  });
});

describe("normalizePriority", () => {
  it("defaults missing/invalid priorities", () => {
    expect(normalizePriority(undefined)).toBe(DEFAULT_PRIORITY);
    expect(normalizePriority(Number.NaN)).toBe(DEFAULT_PRIORITY);
  });

  it("rounds and clamps into 1..5 (1 = highest)", () => {
    expect(normalizePriority(1)).toBe(1);
    expect(normalizePriority(0)).toBe(1);
    expect(normalizePriority(9)).toBe(5);
    expect(normalizePriority(2.6)).toBe(3);
  });
});

describe("normalizeCategory", () => {
  it("maps known categories case-insensitively", () => {
    for (const c of CATEGORIES) {
      expect(normalizeCategory(c.toUpperCase())).toBe(c);
      expect(normalizeCategory(`  ${c}  `)).toBe(c);
    }
  });

  it("falls back to misc for unknown/empty categories", () => {
    expect(normalizeCategory(undefined)).toBe(DEFAULT_CATEGORY);
    expect(normalizeCategory("")).toBe(DEFAULT_CATEGORY);
    expect(normalizeCategory("errands")).toBe(DEFAULT_CATEGORY);
  });
});

describe("toIntakeItem (R1.1 candidate normalization)", () => {
  it("trims text, normalizes fields, and is always unconfirmed", () => {
    const item = toIntakeItem(
      { text: "  Gym  ", durationMin: 50, priority: 1, category: "FITNESS" },
      WEEK_ID,
      "x1",
    );
    expect(item).toEqual({
      id: "x1",
      text: "Gym",
      durationMin: 50,
      priority: 1,
      category: "fitness",
      confirmed: false,
      weekId: WEEK_ID,
    });
  });

  it("supplies defaults for a bare text-only guess", () => {
    const item = toIntakeItem({ text: "read a book" }, WEEK_ID, "x2");
    expect(item.durationMin).toBe(DEFAULT_DURATION_MIN);
    expect(item.priority).toBe(DEFAULT_PRIORITY);
    expect(item.category).toBe(DEFAULT_CATEGORY);
    expect(item.confirmed).toBe(false);
  });
});

// --- extractItems (R1.1) ---------------------------------------------------

describe("extractItems (R1.1 pasted/typed extraction)", () => {
  it("parses JSON candidates, persists them unconfirmed, and flags low confidence", async () => {
    const { deps, items } = makeDeps();
    const raw = JSON.stringify({
      confidence: 0.9,
      items: [
        {
          text: "Morning run",
          durationMin: 30,
          priority: 1,
          category: "fitness",
          confidence: 0.95,
        },
        // Low per-item confidence -> flagged even though overall is high.
        { text: "scribble?", confidence: 0.2 },
      ],
    });

    const res = await extractItems({ itemsText: raw, weekId: WEEK_ID }, deps);

    expect(res.ocrFailed).toBe(false);
    expect(res.candidates).toHaveLength(2);

    const [run, scribble] = res.candidates;
    expect(run.item.text).toBe("Morning run");
    expect(run.item.category).toBe("fitness");
    expect(run.lowConfidence).toBe(false);
    expect(scribble.lowConfidence).toBe(true);

    // Every extracted item is persisted UNCONFIRMED (the R1.3 gate).
    expect(items.putCalls).toHaveLength(1);
    for (const row of items.putCalls[0]) {
      expect(row.confirmed).toBe(false);
      expect(row.weekId).toBe(WEEK_ID);
    }
  });

  it("parses plain text lines, defaulting missing fields", async () => {
    const { deps, items } = makeDeps();
    const raw = "Finish report\nMorning run\nRead a chapter";

    const res = await extractItems({ itemsText: raw, weekId: WEEK_ID }, deps);

    expect(res.ocrFailed).toBe(false);
    expect(res.candidates.map((c) => c.item.text)).toEqual([
      "Finish report",
      "Morning run",
      "Read a chapter",
    ]);
    // Plain lines carry no confidence, so each row is flagged for review.
    expect(res.candidates.every((c) => c.lowConfidence)).toBe(true);
    for (const c of res.candidates) {
      expect(c.item.durationMin).toBe(DEFAULT_DURATION_MIN);
      expect(c.item.priority).toBe(DEFAULT_PRIORITY);
      expect(c.item.category).toBe(DEFAULT_CATEGORY);
    }
    expect(items.putCalls).toHaveLength(1);
  });

  it("parses pipe-delimited lines into structured fields", async () => {
    const { deps } = makeDeps();
    const raw = "Finish report | 90 | 1 | work";
    const res = await extractItems({ itemsText: raw, weekId: WEEK_ID }, deps);
    expect(res.candidates[0].item).toMatchObject({
      text: "Finish report",
      durationMin: 90,
      priority: 1,
      category: "work",
      confirmed: false,
    });
  });

  it("flags candidates as low confidence when none is reported", async () => {
    const { deps } = makeDeps();
    const res = await extractItems(
      { itemsText: "no confidence given", weekId: WEEK_ID },
      deps,
    );
    expect(res.candidates[0].lowConfidence).toBe(true);
  });

  it("uses the overall confidence when a candidate omits its own", async () => {
    const { deps } = makeDeps();
    const raw = JSON.stringify({
      confidence: LOW_CONFIDENCE_THRESHOLD + 0.1,
      items: [{ text: "inherits overall" }],
    });
    const res = await extractItems({ itemsText: raw, weekId: WEEK_ID }, deps);
    expect(res.candidates[0].lowConfidence).toBe(false);
  });

  it("drops empty/whitespace-only text guesses", async () => {
    const { deps } = makeDeps();
    const raw = JSON.stringify({
      confidence: 0.9,
      items: [{ text: "   " }, { text: "real item", confidence: 0.9 }],
    });
    const res = await extractItems({ itemsText: raw, weekId: WEEK_ID }, deps);
    expect(res.candidates.map((c) => c.item.text)).toEqual(["real item"]);
  });

  it("surfaces a malformed payload without throwing or scheduling (design.md fallback)", async () => {
    const { deps, items, planning } = makeDeps();

    const res = await extractItems(
      { itemsText: "{ not valid json", weekId: WEEK_ID },
      deps,
    );

    expect(res.ocrFailed).toBe(true);
    expect(res.candidates).toEqual([]);
    // Nothing persisted, nothing scheduled.
    expect(items.putCalls).toEqual([]);
    expect(planning.triggered).toEqual([]);
  });

  it("treats an empty payload as a failure (nothing usable)", async () => {
    const { deps, items } = makeDeps();
    const res = await extractItems({ itemsText: "", weekId: WEEK_ID }, deps);
    expect(res.ocrFailed).toBe(true);
    expect(res.candidates).toEqual([]);
    expect(items.putCalls).toEqual([]);
  });
});

// --- applyEdit (R1.2) ------------------------------------------------------

describe("applyEdit (R1.2 confirm/edit)", () => {
  it("overrides only the provided fields and re-normalizes them", () => {
    const base = makeItem();
    const edited = applyEdit(base, {
      id: base.id,
      durationMin: 9999,
      category: "self-care",
    });
    expect(edited.durationMin).toBe(8 * 60); // clamped
    expect(edited.category).toBe("self-care");
    // Untouched fields are preserved.
    expect(edited.text).toBe(base.text);
    expect(edited.priority).toBe(base.priority);
  });

  it("leaves the item unchanged when no fields are provided", () => {
    const base = makeItem();
    const edited = applyEdit(base, { id: base.id });
    expect(edited).toEqual(base);
  });
});

// --- confirmItems (R1.3 scheduling gate) -----------------------------------

describe("confirmItems (R1.3 scheduling gate)", () => {
  let seed: IntakeItem[];
  beforeEach(() => {
    seed = [
      makeItem({ id: "item-1", text: "taxes", confirmed: false }),
      makeItem({ id: "item-2", text: "gym", category: "fitness" }),
      makeItem({ id: "item-3", text: "call mom", category: "misc" }),
    ];
  });

  it("marks only confirmed ids as confirmed and triggers planning once", async () => {
    const { deps, items, planning } = makeDeps({ seed });

    const res = await confirmItems(
      {
        weekId: WEEK_ID,
        edits: [
          { id: "item-1", durationMin: 90, priority: 1 },
          { id: "item-2" },
        ],
      },
      deps,
    );

    expect(res.confirmed.map((i) => i.id).sort()).toEqual(["item-1", "item-2"]);
    expect(res.confirmed.every((i) => i.confirmed)).toBe(true);
    // Edit was applied.
    const taxes = res.confirmed.find((i) => i.id === "item-1")!;
    expect(taxes.durationMin).toBe(90);
    expect(taxes.priority).toBe(1);

    // Planning triggered exactly once for the week (R1.3).
    expect(res.planningTriggered).toBe(true);
    expect(planning.triggered).toEqual([WEEK_ID]);

    // The unconfirmed item stays unconfirmed in the store.
    const stored = await items.readItems(WEEK_ID);
    expect(stored.find((i) => i.id === "item-3")!.confirmed).toBe(false);
    expect(stored.find((i) => i.id === "item-1")!.confirmed).toBe(true);
  });

  it("does NOT trigger planning when nothing is confirmed (the gate holds)", async () => {
    const { deps, items, planning } = makeDeps({ seed });

    const res = await confirmItems({ weekId: WEEK_ID, edits: [] }, deps);

    expect(res.confirmed).toEqual([]);
    expect(res.planningTriggered).toBe(false);
    expect(planning.triggered).toEqual([]);
    // No item flipped to confirmed, so planning would schedule nothing.
    const stored = await items.readItems(WEEK_ID);
    expect(stored.some((i) => i.confirmed)).toBe(false);
  });

  it("ignores edits for ids that are not part of this week's items", async () => {
    const { deps, planning } = makeDeps({ seed });

    const res = await confirmItems(
      { weekId: WEEK_ID, edits: [{ id: "ghost-id" }] },
      deps,
    );

    expect(res.confirmed).toEqual([]);
    expect(res.planningTriggered).toBe(false);
    expect(planning.triggered).toEqual([]);
  });

  it("does not confirm or schedule items that were merely extracted (R1.3)", async () => {
    // Simulate the extract step having persisted unconfirmed items, then a
    // confirm call that touches none of them.
    const { deps: extractDeps, items } = makeDeps();
    await extractItems(
      {
        itemsText: JSON.stringify({
          confidence: 0.9,
          items: [{ text: "write report", confidence: 0.9 }],
        }),
        weekId: WEEK_ID,
      },
      extractDeps,
    );

    const planning = new FakePlanning();
    const confirmDeps: IntakeDeps = {
      items,
      planning,
      ids: new SeqIds(),
    };

    // User reviews but confirms nothing.
    const res = await confirmItems({ weekId: WEEK_ID, edits: [] }, confirmDeps);
    expect(res.planningTriggered).toBe(false);
    expect(planning.triggered).toEqual([]);
    const stored = await items.readItems(WEEK_ID);
    expect(stored.every((i) => i.confirmed === false)).toBe(true);
  });
});
