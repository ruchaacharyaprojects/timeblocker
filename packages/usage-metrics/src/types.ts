/**
 * Shared data contracts for Android usage metrics (R7).
 *
 * The privacy boundary is expressed in these types: raw per-app usage
 * (`AppUsageRecord[]`) is an on-device-only input. It is never a field of the
 * `UsageSummary` that leaves the device. The aggregation layer collapses raw
 * records into a small, non-identifying summary signal.
 */

/**
 * A raw per-app usage record for a single app over a measurement window.
 * This is read from `UsageStatsManager` on the device and MUST NOT be uploaded
 * to the backend (R7.3). It stays input-only to the aggregation step.
 */
export interface AppUsageRecord {
  /** Android package name, e.g. "com.instagram.android". */
  packageName: string;
  /** Foreground time for this app in the window, in milliseconds. */
  foregroundTimeMs: number;
  /** Number of times the app was brought to the foreground. */
  launchCount?: number;
}

/** The window the raw usage was measured over (epoch ms, half-open). */
export interface UsageWindow {
  /** Window start, epoch ms. */
  startMs: number;
  /** Window end, epoch ms. */
  endMs: number;
}

/** Coarse buckets describing how distracting the window was (R7 / R9.2). */
export type DistractionLevel = "low" | "moderate" | "high";

/**
 * The only shape permitted to leave the device (R7.3). It carries aggregate
 * signals derived from raw usage, never the raw per-app history and never the
 * list of which apps were used.
 */
export interface UsageSummary {
  window: UsageWindow;
  /** Total screen time across all apps in the window, in minutes. */
  totalScreenTimeMin: number;
  /** Screen time spent in apps on the distraction list, in minutes. */
  distractionTimeMin: number;
  /** distractionTimeMin / totalScreenTimeMin, 0 when no screen time. */
  distractionRatio: number;
  /** Coarse bucket for the review and the "will you miss this" signal. */
  distractionLevel: DistractionLevel;
  /** Count of distinct distraction apps that saw any foreground time. */
  distractionAppCount: number;
}

/**
 * A focused, near-term signal used by the "will you miss this?" prompt (R6.1).
 * Derived from recent raw usage near a block's start, on-device only.
 */
export interface MissRiskSignal {
  /** Distraction minutes observed in the recent lookback window. */
  recentDistractionMin: number;
  /** Whether recent distraction crosses the risk threshold. */
  atRisk: boolean;
}

/** Thresholds for turning a distraction ratio into a coarse level. */
export interface DistractionThresholds {
  /** Ratio at or above which the level is at least "moderate". */
  moderate: number;
  /** Ratio at or above which the level is "high". */
  high: number;
}
