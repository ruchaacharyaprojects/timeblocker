/**
 * Tidy a title after removing count/duration/schedule text: drop empty
 * brackets, collapse spaces, and strip leading/trailing separators (R22.2).
 * Shared by `estimate.ts` and `schedule.ts`.
 */
export function cleanTitle(raw: string): string {
  return raw
    .replace(/\(\s*\)/g, " ")
    .replace(/\s+([,.;:!?])/g, "$1")
    .replace(/\s+/g, " ")
    .replace(/^[\s,;:@\-–—()]+/, "")
    .replace(/[\s,;:@\-–—(]+$/, "")
    .trim();
}
