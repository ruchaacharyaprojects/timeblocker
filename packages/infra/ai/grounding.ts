import type { TalkingPoint } from "./contract.js";

/** Case-, whitespace- and Unicode-form-insensitive form used for quote matching. */
export function normalize(s: string): string {
  return s.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
}

export const MIN_QUOTE_CHARS = 8;
export const MISSING_PREFIX = "Add your own example for: ";

function topicOf(text: string): string {
  const words = text.trim().split(/\s+/).filter(Boolean).slice(0, 8);
  const topic = words.join(" ").replace(/[\s.,;:!?"'()\[\]-]+$/g, "");
  return topic.length > 0 ? topic : "this point";
}

export interface VerifyResult {
  verified: TalkingPoint[];
  missing: string[];
}

/**
 * Keeps a point only when its quote (>= 8 chars after normalization) is a substring of the
 * normalized background. Dropped points become "Add your own example for: <topic>" entries,
 * so a dropped claim is never repeated as a fact beyond its first 8 words used as a topic label.
 */
export function verifyPoints(points: TalkingPoint[], background: string): VerifyResult {
  const bg = normalize(background);
  const verified: TalkingPoint[] = [];
  const missing: string[] = [];
  const seenQuotes = new Set<string>();
  const seenMissing = new Set<string>();
  for (const p of points) {
    const q = normalize(p.quote);
    const ok = q.length >= MIN_QUOTE_CHARS && bg.includes(q);
    if (ok) {
      if (seenQuotes.has(q)) continue;
      seenQuotes.add(q);
      verified.push({ text: p.text, quote: p.quote });
    } else {
      const line = MISSING_PREFIX + topicOf(p.text);
      const key = normalize(line);
      if (seenMissing.has(key)) continue;
      seenMissing.add(key);
      missing.push(line);
    }
  }
  return { verified, missing };
}

/** Caps text at maxWords words, preferring to end at a sentence boundary. */
export function capWords(text: string, maxWords: number): string {
  const trimmed = text.trim();
  const re = /\S+/g;
  let count = 0;
  let end = -1;
  let m: RegExpExecArray | null;
  while ((m = re.exec(trimmed)) !== null) {
    count++;
    if (count === maxWords) end = m.index + m[0].length;
    if (count > maxWords) break;
  }
  if (count <= maxWords) return trimmed;
  const slice = trimmed.slice(0, end);
  const sentenceEnd = /[.!?]["')\]]?(?=\s|$)/g;
  let last = -1;
  let s: RegExpExecArray | null;
  while ((s = sentenceEnd.exec(slice)) !== null) last = s.index + s[0].length;
  return last > 0 ? slice.slice(0, last).trim() : slice.trim();
}

export function wordCount(text: string): number {
  const t = text.trim();
  return t === "" ? 0 : t.split(/\s+/).length;
}
