# @timeblocker/usage-metrics

Android usage metrics for TimeBlocker (R7): the `UsageStatsManager` permission
flow, on-device aggregation into summary signals, and the user-editable
distraction app list.

**Privacy (R7.3):** raw per-app usage is read on the device and is only ever an
input to aggregation. It is never part of any exported result type — only
`UsageSummary` / `MissRiskSignal` values are meant to leave the device. Raw app
history is never uploaded.

## Layers

- **Pure TS (testable, no I/O)**
  - `distractionList.ts` — editable distraction list operations (R7.2).
  - `aggregate.ts` — collapse raw usage into a `UsageSummary` and a near-term
    `MissRiskSignal` (R7.1, R7.3).
- **React Native bridge**
  - `nativeModule.ts` — typed contract for the Android native module, with an
    injection seam (`setUsageMetricsNative`) for tests/hosts.
  - `permission.ts` — the permission flow and the collect-then-aggregate
    pipeline (R7.1).
- **Android native module (Kotlin)** — `android/`
  - `UsageMetricsModule.kt` — permission check, Usage Access settings intent,
    and `UsageStatsManager` event reconstruction for per-app foreground time.
  - `UsageMetricsPackage.kt` — RN package registration.
  - `AndroidManifest-snippet.xml` — the `PACKAGE_USAGE_STATS` declaration.

## Permission flow (R7.1)

Usage Access is a special permission granted from a system settings screen, not
a runtime dialog:

```ts
import {
  requestUsagePermission,
  checkUsagePermission,
  collectUsageSummary,
  DEFAULT_DISTRACTION_APPS,
} from "@timeblocker/usage-metrics";

// 1. send the user to settings if needed
await requestUsagePermission();
// 2. after the app resumes, re-check
if ((await checkUsagePermission()) === "granted") {
  // 3. read + aggregate on-device; only the summary leaves the device
  const result = await collectUsageSummary(
    { startMs, endMs },
    { distractionApps: DEFAULT_DISTRACTION_APPS },
  );
}
```

When permission is denied the flow degrades gracefully: `collectUsageSummary`
returns `{ ok: false, reason: "permission-denied" }` and usage-based signals are
simply disabled (calendar-overlap detection still works).

## Android host wiring

1. Add the `PACKAGE_USAGE_STATS` permission from `AndroidManifest-snippet.xml`
   to the app manifest.
2. Register `UsageMetricsPackage` in the host app's `getPackages()`.
3. Copy the Kotlin sources under the app's
   `com.timeblocker.usagemetrics` package (or adjust the package name).

## Commands

```bash
npm install      # once
npm test         # run the unit test suite (vitest)
npm run build    # compile to dist/
npm run typecheck
```
