/**
 * Pure interval arithmetic over half-open [start, end) ranges keyed by
 * epoch milliseconds. Used to carve free windows out of schedulable windows.
 */

export interface MsInterval {
  start: number;
  end: number;
}

/** Normalize, drop empties, sort, and merge overlapping/adjacent intervals. */
export function normalize(intervals: MsInterval[]): MsInterval[] {
  const valid = intervals
    .filter((i) => i.end > i.start)
    .sort((a, b) => a.start - b.start);
  const merged: MsInterval[] = [];
  for (const cur of valid) {
    const last = merged[merged.length - 1];
    if (last && cur.start <= last.end) {
      last.end = Math.max(last.end, cur.end);
    } else {
      merged.push({ ...cur });
    }
  }
  return merged;
}

/** Subtract all `holes` from `base`, returning the remaining pieces. */
export function subtract(base: MsInterval[], holes: MsInterval[]): MsInterval[] {
  const normHoles = normalize(holes);
  let result = normalize(base);
  for (const hole of normHoles) {
    const next: MsInterval[] = [];
    for (const seg of result) {
      // No overlap -> keep segment intact.
      if (hole.end <= seg.start || hole.start >= seg.end) {
        next.push(seg);
        continue;
      }
      // Left remainder.
      if (hole.start > seg.start) {
        next.push({ start: seg.start, end: hole.start });
      }
      // Right remainder.
      if (hole.end < seg.end) {
        next.push({ start: hole.end, end: seg.end });
      }
    }
    result = next;
  }
  return result;
}

/** Intersect each base interval with [lo, hi). */
export function clamp(
  intervals: MsInterval[],
  lo: number,
  hi: number,
): MsInterval[] {
  return normalize(
    intervals.map((i) => ({
      start: Math.max(i.start, lo),
      end: Math.min(i.end, hi),
    })),
  );
}

/** Duration in whole minutes. */
export function durationMin(i: MsInterval): number {
  return Math.floor((i.end - i.start) / 60000);
}
