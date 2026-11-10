import { describe, expect, it } from "vitest";
import {
  DEFAULT_CATEGORY,
  DEFAULT_DURATION_MIN,
  DEFAULT_PRIORITY,
  MAX_INTAKE_CHARS,
  MAX_INTAKE_ITEMS,
  validateIntakeInput,
} from "./index.js";

/** Build `n` plain-text lines, one item each. */
function lines(n: number): string {
  return Array.from({ length: n }, (_, i) => `Task ${i + 1}`).join("\n");
}

function reasonOf(raw: string): string | undefined {
  const r = validateIntakeInput(raw);
  return r.ok ? undefined : r.reason;
}

describe("validateIntakeInput (R1.1, R11.4-R11.6)", () => {
  it("exposes the 20,000 char and 100 item limits", () => {
    expect(MAX_INTAKE_CHARS).toBe(20_000);
    expect(MAX_INTAKE_ITEMS).toBe(100);
  });

  // --- Reasons -------------------------------------------------------------

  it("rejects empty and whitespace-only input as empty", () => {
    expect(reasonOf("")).toBe("empty");
    expect(reasonOf("   \n\t \r\n  ")).toBe("empty");
  });

  it("rejects broken JSON starting with [ or { as malformed-json", () => {
    expect(reasonOf('[{"text": "Run"')).toBe("malformed-json");
    expect(reasonOf('  \n {"items": [')).toBe("malformed-json");
  });

  it("rejects input that parses to zero usable items as no-items", () => {
    expect(reasonOf("[]")).toBe("no-items");
    expect(reasonOf('{"items": []}')).toBe("no-items");
    expect(reasonOf('[{"text": "   "}, 42, null]')).toBe("no-items");
    expect(reasonOf('{"foo": 1}')).toBe("no-items");
  });

  it("rejects more than 100 items as too-many-items", () => {
    expect(reasonOf(lines(101))).toBe("too-many-items");
    const json = JSON.stringify(
      Array.from({ length: 101 }, (_, i) => ({ text: `Item ${i}` })),
    );
    expect(reasonOf(json)).toBe("too-many-items");
  });

  it("rejects input longer than 20,000 chars as too-long, before other checks", () => {
    expect(reasonOf("a".repeat(20_001))).toBe("too-long");
    // Whitespace-only but too long is still too-long (length checked first).
    expect(reasonOf(" ".repeat(20_001))).toBe("too-long");
  });

  // --- Boundaries ----------------------------------------------------------

  it("accepts exactly 20,000 chars", () => {
    const r = validateIntakeInput("a".repeat(20_000));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.candidates).toHaveLength(1);
  });

  it("accepts exactly 1 item", () => {
    const r = validateIntakeInput("Buy groceries");
    expect(r).toEqual({
      ok: true,
      ignored: [],
      candidates: [
        {
          text: "Buy groceries",
          durationMin: DEFAULT_DURATION_MIN,
          priority: DEFAULT_PRIORITY,
          category: DEFAULT_CATEGORY,
          lowConfidence: true,
          count: 1,
          source: { duration: "default", category: "default" },
        },
      ],
    });
  });

  it("accepts exactly 100 items", () => {
    const r = validateIntakeInput(lines(100));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.candidates).toHaveLength(100);
  });

  // --- Plain text and JSON parsing ----------------------------------------

  it("treats each non-blank line as one item with defaults 30 / 3 / misc", () => {
    // ("Read ..." would now be inferred as self-development from keywords.)
    const r = validateIntakeInput("  Call mom \n\n   \r\nPay rent\n");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.candidates.map((c) => c.text)).toEqual(["Call mom", "Pay rent"]);
    for (const c of r.candidates) {
      expect(c.durationMin).toBe(30);
      expect(c.priority).toBe(3);
      expect(c.category).toBe("misc");
    }
  });

  it("normalizes JSON array items and keeps their order", () => {
    const r = validateIntakeInput(
      JSON.stringify([
        {
          text: "Gym",
          durationMin: 60,
          priority: 2,
          category: "Fitness",
          confidence: 0.9,
        },
        { text: "Taxes" },
      ]),
    );
    expect(r).toEqual({
      ok: true,
      ignored: [],
      candidates: [
        {
          text: "Gym",
          durationMin: 60,
          priority: 2,
          category: "fitness",
          lowConfidence: false,
          count: 1,
          source: { duration: "stated", category: "stated" },
        },
        {
          text: "Taxes",
          durationMin: 30,
          priority: 3,
          category: "misc",
          lowConfidence: true,
          count: 1,
          source: { duration: "default", category: "default" },
        },
      ],
    });
  });
});
