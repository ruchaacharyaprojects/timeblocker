/**
 * Learned placement preferences (R23, design D21). Pure and on-device: no
 * I/O, no model, no network.
 *
 * From past blocks, compute per category a completion rate for each 2-hour
 * bucket of the block's Toronto start time, smoothed toward the category's
 * overall rate with a prior weight of {@link PRIOR_WEIGHT} blocks.
 */

import { torontoMinutesOfDay, type Category } from "@timeblocker/scheduling-engine";

/** Prior weight (in blocks) pulling a bucket toward the overall rate (R23.2). */
export const PRIOR_WEIGHT = 3;
/** Counted blocks a category needs before its preferences are used (R23.2). */
export const MIN_COUNTED = 5;
/** Number of 2-hour buckets in a day. */
export const BUCKET_COUNT = 12;

/** One past block, reduced to what learning needs. */
export interface PlacementHistoryEntry {
  category: Category;
  /** ISO instant of the block's start. */
  start: string;
  status: string;
}

export interface CategoryPreference {
  /** Blocks counted (done, partial, missed, skipped). */
  counted: number;
  /** Completed points / counted, in 0..1. */
  overall: number;
  /** Smoothed rate per 2-hour bucket of the Toronto start hour (0 = 00-02). */
  buckets: number[];
}

export type PlacementPreferences = Partial<Record<Category, CategoryPreference>>;

/** Completion points for a status, or undefined when the status is ignored. */
function points(status: string): number | undefined {
  switch (status) {
    case "done":
      return 1;
    case "partial":
      return 0.5;
    case "missed":
    case "skipped":
      return 0;
    default:
      return undefined;
  }
}

/** Bucket index (0..11) of an instant's Toronto start hour. */
export function bucketOf(startMs: number): number {
  const minutes = torontoMinutesOfDay(new Date(startMs));
  return Math.min(BUCKET_COUNT - 1, Math.floor(minutes / 120));
}

/** Build preferences from history (R23.1, R23.2). */
export function buildPlacementPreferences(
  history: readonly PlacementHistoryEntry[],
): PlacementPreferences {
  interface Acc {
    n: number;
    pts: number;
    bn: number[];
    bp: number[];
  }
  const acc = new Map<Category, Acc>();
  for (const h of history) {
    const p = points(h.status);
    if (p === undefined) continue;
    const ms = Date.parse(h.start);
    if (!Number.isFinite(ms)) continue;
    let a = acc.get(h.category);
    if (!a) {
      a = {
        n: 0,
        pts: 0,
        bn: new Array<number>(BUCKET_COUNT).fill(0),
        bp: new Array<number>(BUCKET_COUNT).fill(0),
      };
      acc.set(h.category, a);
    }
    const b = bucketOf(ms);
    a.n += 1;
    a.pts += p;
    a.bn[b]! += 1;
    a.bp[b]! += p;
  }

  const out: PlacementPreferences = {};
  for (const [category, a] of acc) {
    if (a.n < MIN_COUNTED) continue;
    const overall = a.pts / a.n;
    out[category] = {
      counted: a.n,
      overall,
      buckets: a.bn.map((n, i) => (a.bp[i]! + PRIOR_WEIGHT * overall) / (n + PRIOR_WEIGHT)),
    };
  }
  return out;
}

/** Smoothed rate for a start instant, or undefined when the category has no preferences. */
export function preferenceScore(
  prefs: PlacementPreferences,
  category: Category,
  startMs: number,
): number | undefined {
  const pref = prefs[category];
  if (!pref) return undefined;
  return pref.buckets[bucketOf(startMs)];
}
