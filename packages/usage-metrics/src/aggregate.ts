/**
 * On-device aggregation of raw usage into summary signals (R7.1, R7.3).
 *
 * This is the privacy boundary. The functions here take raw per-app usage
 * (`AppUsageRecord[]`, read from `UsageStatsManager` on the device) and return
 * only aggregate `UsageSummary` / `MissRiskSignal` values. The raw records are
 * never attached to the output, so a caller that only ever ships the return
 * value cannot leak raw app history off the device (R7.3).
 *
 * Pure and deterministic: no network, no I/O, no clock reads.
 */

import { distractionMatcher } from "./distractionList.js";
import type {
  AppUsageRecord,
  DistractionLevel,
  DistractionThresholds,
  MissRiskSignal,
  UsageSummary,
  UsageWindow,
} from "./types.js";

const MS_PER_MIN = 60_000;

/** Default ratio thresholds for the coarse distraction level. */
export const DEFAULT_THRESHOLDS: DistractionThresholds = {
  moderate: 0.2,
  high: 0.4,
};

/** Default lookback for the near-term miss-risk signal, in milliseconds. */
export const DEFAULT_MISS_RISK_LOOKBACK_MS = 10 * MS_PER_MIN;
/** Default distraction minutes in the lookback that count as "at risk". */
export const DEFAULT_MISS_RISK_THRESHOLD_MIN = 5;

function toMinutes(ms: number): number {
  return Math.round(ms / MS_PER_MIN);
}

/** Map a distraction ratio to a coarse level using the given thresholds. */
export function classifyDistraction(
  ratio: number,
  thresholds: DistractionThresholds = DEFAULT_THRESHOLDS,
): DistractionLevel {
  if (ratio >= thresholds.high) return "high";
  if (ratio >= thresholds.moderate) return "moderate";
  return "low";
}

/**
 * Collapse raw per-app usage into a single summary signal (R7.3).
 *
 * Negative durations are clamped to zero so a bad record can't drag totals
 * below zero. The returned object intentionally contains no per-app data.
 */
export function aggregateUsage(
  records: readonly AppUsageRecord[],
  window: UsageWindow,
  distractionApps: readonly string[],
  thresholds: DistractionThresholds = DEFAULT_THRESHOLDS,
): UsageSummary {
  const isDistraction = distractionMatcher(distractionApps);

  let totalMs = 0;
  let distractionMs = 0;
  let distractionAppCount = 0;

  for (const rec of records) {
    const fg = Math.max(0, rec.foregroundTimeMs);
    if (fg === 0) continue;
    totalMs += fg;
    if (isDistraction(rec.packageName)) {
      distractionMs += fg;
      distractionAppCount += 1;
    }
  }

  const totalScreenTimeMin = toMinutes(totalMs);
  const distractionTimeMin = toMinutes(distractionMs);
  const distractionRatio = totalMs === 0 ? 0 : distractionMs / totalMs;

  return {
    window,
    totalScreenTimeMin,
    distractionTimeMin,
    distractionRatio,
    distractionLevel: classifyDistraction(distractionRatio, thresholds),
    distractionAppCount,
  };
}

/**
 * Derive a near-term miss-risk signal from recent raw usage near a block's
 * start (R6.1). Only records overlapping the lookback window are considered,
 * weighted by the fraction of their foreground time that fell in the window.
 *
 * Inputs are raw and on-device; the returned signal is aggregate only.
 */
export function missRiskSignal(
  records: readonly AppUsageRecordWithWindow[],
  distractionApps: readonly string[],
  blockStartMs: number,
  options: {
    lookbackMs?: number;
    thresholdMin?: number;
  } = {},
): MissRiskSignal {
  const lookbackMs = options.lookbackMs ?? DEFAULT_MISS_RISK_LOOKBACK_MS;
  const thresholdMin =
    options.thresholdMin ?? DEFAULT_MISS_RISK_THRESHOLD_MIN;
  const lookbackStart = blockStartMs - lookbackMs;
  const isDistraction = distractionMatcher(distractionApps);

  let recentDistractionMs = 0;
  for (const rec of records) {
    if (!isDistraction(rec.packageName)) continue;
    const overlapStart = Math.max(rec.startMs, lookbackStart);
    const overlapEnd = Math.min(rec.endMs, blockStartMs);
    if (overlapEnd <= overlapStart) continue;
    const span = rec.endMs - rec.startMs;
    const fg = Math.max(0, rec.foregroundTimeMs);
    // Proportion of the app's foreground time that lands in the lookback.
    const fraction = span > 0 ? (overlapEnd - overlapStart) / span : 1;
    recentDistractionMs += fg * fraction;
  }

  const recentDistractionMin = toMinutes(recentDistractionMs);
  return {
    recentDistractionMin,
    atRisk: recentDistractionMin >= thresholdMin,
  };
}

/** A raw usage record carrying its own measurement window (for miss-risk). */
export interface AppUsageRecordWithWindow extends AppUsageRecord {
  startMs: number;
  endMs: number;
}
