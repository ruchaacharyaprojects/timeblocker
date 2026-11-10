/**
 * TimeBlocker Android usage metrics (R7).
 *
 * Public surface for:
 *  - the UsageStatsManager permission flow (R7.1) — `permission.ts`
 *  - on-device aggregation into summary signals (R7.1, R7.3) — `aggregate.ts`
 *  - the user-editable distraction app list (R7.2) — `distractionList.ts`
 *
 * Privacy (R7.3): raw per-app usage is input-only to aggregation and is never
 * part of any exported result type. Only `UsageSummary` / `MissRiskSignal`
 * values are meant to leave the device.
 */

export * from "./types.js";
export {
  DEFAULT_DISTRACTION_APPS,
  effectiveDistractionApps,
  normalizePackageName,
  normalizeDistractionList,
  addDistractionApp,
  removeDistractionApp,
  isDistractionApp,
  distractionMatcher,
} from "./distractionList.js";
export {
  DEFAULT_THRESHOLDS,
  DEFAULT_MISS_RISK_LOOKBACK_MS,
  DEFAULT_MISS_RISK_THRESHOLD_MIN,
  classifyDistraction,
  aggregateUsage,
  missRiskSignal,
  type AppUsageRecordWithWindow,
} from "./aggregate.js";
export {
  SLEEP_START_MIN,
  SLEEP_END_MIN,
  SLEEP_EXCLUDED_PACKAGES,
  nightWindow,
  sleepScore,
  sleepUsageMin,
  nightsEndedBefore,
  HEALTH_SESSION_MIN_LENGTH_MS,
  HEALTH_TARGET_ASLEEP_MIN,
  healthReadWindow,
  selectNightSession,
  healthSleepScore,
} from "./sleep.js";
export {
  type UsagePermissionStatus,
  type UsageMetricsNativeModule,
  setUsageMetricsNative,
  getUsageMetricsNative,
} from "./nativeModule.js";
export {
  type CollectResult,
  type CollectOptions,
  checkUsagePermission,
  requestUsagePermission,
  collectUsageSummary,
} from "./permission.js";
