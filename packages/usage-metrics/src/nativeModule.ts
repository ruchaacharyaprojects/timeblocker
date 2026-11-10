/**
 * TypeScript contract for the Android native module (R7.1).
 *
 * The native side (see `android/UsageMetricsModule.kt`) reads screen time and
 * per-app usage through `UsageStatsManager` once permission is granted, and
 * exposes the small surface below to JavaScript. Keeping raw reads on the
 * native/device side and only crossing the bridge with already-small data
 * supports the privacy rule (R7.3).
 *
 * This file declares the interface and a tiny resolver so the pure RN layer
 * (`permission.ts`) and tests can depend on an injectable module rather than
 * React Native's global `NativeModules`, which does not exist under vitest.
 */

import type { AppUsageRecord, UsageWindow } from "./types.js";

/** Whether the user has granted the Usage Access special permission. */
export type UsagePermissionStatus = "granted" | "denied";

/**
 * The methods the Android native module exposes to JS. All are async because
 * they cross the native bridge. `AppUsageRecord[]` is raw per-app data and
 * MUST be aggregated on-device before anything is sent to the backend (R7.3).
 */
export interface UsageMetricsNativeModule {
  /** Current Usage Access permission status (R7.1). */
  getPermissionStatus(): Promise<UsagePermissionStatus>;
  /**
   * Open the system Usage Access settings screen so the user can grant
   * permission. Resolves once the intent has been launched; the caller
   * re-checks status on resume. Android has no in-app grant dialog for this
   * special permission, so this is the only path (R7.1).
   */
  openUsageAccessSettings(): Promise<void>;
  /**
   * Read raw per-app usage for the window via `UsageStatsManager`. Only valid
   * after permission is granted. The result stays on-device for aggregation.
   */
  queryUsage(window: UsageWindow): Promise<AppUsageRecord[]>;
}

/**
 * Resolve the native module. In a React Native runtime this returns the real
 * `NativeModules.UsageMetrics`; in tests or non-RN environments it throws a
 * clear error unless an override is injected via `setUsageMetricsNative`.
 */
let injected: UsageMetricsNativeModule | undefined;

/** Inject a native-module implementation (tests, or a custom host). */
export function setUsageMetricsNative(
  mod: UsageMetricsNativeModule | undefined,
): void {
  injected = mod;
}

/**
 * Get the resolved native module. Prefers an injected implementation, then a
 * React Native `NativeModules.UsageMetrics` if present. Throws otherwise so a
 * missing native module surfaces loudly rather than silently no-opping.
 */
export function getUsageMetricsNative(): UsageMetricsNativeModule {
  if (injected) return injected;

  const rn = tryLoadReactNativeModule();
  if (rn) return rn;

  throw new Error(
    "UsageMetrics native module is unavailable. It is only present on " +
      "Android with the native module linked, or inject one via " +
      "setUsageMetricsNative() for tests.",
  );
}

/**
 * Best-effort lookup of the RN native module without a hard dependency on
 * react-native (which is not installed in this pure package). Uses a global
 * that React Native populates at runtime.
 */
function tryLoadReactNativeModule(): UsageMetricsNativeModule | undefined {
  const g = globalThis as {
    __turboModuleProxy?: unknown;
    nativeModuleProxy?: Record<string, unknown>;
  };
  const candidate = g.nativeModuleProxy?.["UsageMetrics"];
  return (candidate as UsageMetricsNativeModule) ?? undefined;
}
