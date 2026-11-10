import { describe, expect, it } from "vitest";
import { capWords, normalize, verifyPoints, wordCount } from "../../ai/grounding.js";

const BG = "I led a team of 4 students to build a campus food-sharing app.\n  Won   2nd place at   HackWest 2024.";

describe("normalize", () => {
  it("lowercases, collapses whitespace and trims", () => {
    expect(normalize("  Hello \n\t WORLD  ")).toBe("hello world");
  });
});

describe("verifyPoints", () => {
  it("keeps points whose quote is in the background (case/whitespace-insensitive)", () => {
    const r = verifyPoints(
      [{ text: "Team lead", quote: "LED A TEAM of 4   students" }],
      BG,
    );
    expect(r.verified).toHaveLength(1);
    expect(r.missing).toEqual([]);
  });

  it("matches across newlines and repeated spaces in the background", () => {
    const r = verifyPoints([{ text: "Hackathon", quote: "won 2nd place at hackwest 2024" }], BG);
    expect(r.verified).toHaveLength(1);
  });

  it("drops hallucinated quotes into missing without echoing the claim as a fact", () => {
    const r = verifyPoints(
      [{ text: "Managed a 50 person team at Google for three years running", quote: "managed a 50 person team at google" }],
      BG,
    );
    expect(r.verified).toEqual([]);
    expect(r.missing).toEqual(["Add your own example for: Managed a 50 person team at Google for"]);
  });

  it("rejects quotes shorter than 8 characters after normalization", () => {
    const r = verifyPoints([{ text: "Short", quote: "  led a  t " }, { text: "Tiny", quote: "team" }], BG);
    expect(r.verified).toEqual([]);
    expect(r.missing).toHaveLength(2);
  });

  it("accepts an exactly 8 character quote", () => {
    expect(verifyPoints([{ text: "x", quote: "HackWest" }], BG).verified).toHaveLength(1);
  });

  it("dedupes verified quotes and missing topics", () => {
    const r = verifyPoints(
      [
        { text: "A", quote: "led a team of 4 students" },
        { text: "B", quote: "Led a team of 4  students" },
        { text: "Same topic", quote: "not in background at all" },
        { text: "Same topic", quote: "also not there anywhere" },
      ],
      BG,
    );
    expect(r.verified).toHaveLength(1);
    expect(r.missing).toEqual(["Add your own example for: Same topic"]);
  });

  it("uses a generic topic for an empty point text", () => {
    const r = verifyPoints([{ text: "  ", quote: "nope nope nope" }], BG);
    expect(r.missing).toEqual(["Add your own example for: this point"]);
  });
});

describe("capWords", () => {
  it("returns short text unchanged", () => {
    expect(capWords("One two three.", 120)).toBe("One two three.");
  });

  it("truncates at a sentence boundary within the cap", () => {
    const text = "First sentence here. Second sentence goes on and on and on";
    expect(capWords(text, 6)).toBe("First sentence here.");
  });

  it("hard-cuts at the word cap when there is no sentence end", () => {
    const text = Array.from({ length: 200 }, (_, i) => `w${i}`).join(" ");
    const out = capWords(text, 120);
    expect(wordCount(out)).toBe(120);
  });

  it("never exceeds 120 words for a long multi-sentence draft", () => {
    const sentence = "I built a small app for my campus community. ";
    const out = capWords(sentence.repeat(40), 120);
    expect(wordCount(out)).toBeLessThanOrEqual(120);
    expect(out.endsWith(".")).toBe(true);
  });
});
