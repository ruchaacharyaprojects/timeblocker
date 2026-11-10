/**
 * Usage Access permission flow (R7.1) and the collect-then-aggregate pipeline.
 *
 * Android's Usage Access is a special permission granted from a system
 * settings screen, not a runtime dialog. The flow is therefore:
 *   1. check status
 *   2. if denied, send the user to settings
 *   3. re-check on resume
 *   4. only then read + aggregate usage
 *
 * When permission is denied the app degrades gracefully: callers get a clear
 * `permissionDenied` result instead of raw data, and usage-based signals are
 * simply disabled (calendar-overlap detection still works — see design.md).
 */

import { aggregateUsage } from "./aggregate.js";
import {
  getUsageMetricsNative,
  type UsageMetricsNativeModule,
  type UsagePermissionStatus,
} from "./nativeModule.js";
import type {
  DistractionThresholds,
  UsageSummary,
  UsageWindow,
} from "./types.js";

/** Result of attempting to collect a usage summary. */
export type CollectResult =
  | { ok: true; summary: UsageSummary }
  | { ok: false; reason: "permission-denied" };

/** Options for the collect pipeline. */
export interface CollectOptions {
  distractionApps: readonly string[];
  thresholds?: DistractionThresholds;
  /** Inject a native module (defaults to the resolved platform module). */
  native?: UsageMetricsNativeModule;
}

/** Check the current Usage Access permission status (R7.1). */
export async function checkUsagePermission(
  native: UsageMetricsNativeModule = getUsageMetricsNative(),
): Promise<UsagePermissionStatus> {
  return native.getPermissionStatus();
}

/**
 * Ensure permission: if already granted, resolve immediately; otherwise open
 * the system Usage Access settings so the user can grant it (R7.1). Returns
 * the status known before settings were opened — the caller re-checks with
 * `checkUsagePermission` after the app resumes.
 */
export async function requestUsagePermission(
  native: UsageMetricsNativeModule = getUsageMetricsNative(),
): Promise<UsagePermissionStatus> {
  const status = await native.getPermissionStatus();
  if (status === "granted") return "granted";
  await native.openUsageAccessSettings();
  return "denied";
}

/**
 * Collect a usage summary for the window: verify permission, read raw usage on
 * the device, and aggregate it into summary signals (R7.1, R7.3).
 *
 * Raw records never leave this function — only the aggregate `UsageSummary` is
 * returned, enforcing the privacy boundary at the collection seam.
 */
export async function collectUsageSummary(
  window: UsageWindow,
  options: CollectOptions,
): Promise<CollectResult> {
  const native = options.native ?? getUsageMetricsNative();

  const status = await native.getPermissionStatus();
  if (status !== "granted") {
    return { ok: false, reason: "permission-denied" };
  }

  const rawRecords = await native.queryUsage(window);
  const summary = aggregateUsage(
    rawRecords,
    window,
    options.distractionApps,
    options.thresholds,
  );
  return { ok: true, summary };
}
