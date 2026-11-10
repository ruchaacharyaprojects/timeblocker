import { describe, it, expect, vi } from "vitest";
import {
  checkUsagePermission,
  requestUsagePermission,
  collectUsageSummary,
} from "./permission.js";
import type {
  UsageMetricsNativeModule,
  UsagePermissionStatus,
} from "./nativeModule.js";
import type { AppUsageRecord, UsageWindow } from "./types.js";

const MIN = 60_000;
const WINDOW: UsageWindow = { startMs: 0, endMs: 24 * 60 * MIN };
const DISTRACTIONS = ["com.instagram.android"];

/** A controllable fake of the Android native module for tests. */
function fakeNative(
  status: UsagePermissionStatus,
  records: AppUsageRecord[] = [],
): UsageMetricsNativeModule & {
  openUsageAccessSettings: ReturnType<typeof vi.fn>;
  queryUsage: ReturnType<typeof vi.fn>;
} {
  return {
    getPermissionStatus: vi.fn(async () => status),
    openUsageAccessSettings: vi.fn(async () => undefined),
    queryUsage: vi.fn(async () => records),
  };
}

describe("permission flow (R7.1)", () => {
  it("reports the current status", async () => {
    await expect(checkUsagePermission(fakeNative("granted"))).resolves.toBe(
      "granted",
    );
    await expect(checkUsagePermission(fakeNative("denied"))).resolves.toBe(
      "denied",
    );
  });

  it("resolves immediately when already granted, without opening settings", async () => {
    const native = fakeNative("granted");
    const status = await requestUsagePermission(native);
    expect(status).toBe("granted");
    expect(native.openUsageAccessSettings).not.toHaveBeenCalled();
  });

  it("opens the Usage Access settings when denied", async () => {
    const native = fakeNative("denied");
    const status = await requestUsagePermission(native);
    expect(status).toBe("denied");
    expect(native.openUsageAccessSettings).toHaveBeenCalledOnce();
  });
});

describe("collectUsageSummary (R7.1, R7.3)", () => {
  it("degrades gracefully when permission is denied", async () => {
    const native = fakeNative("denied");
    const result = await collectUsageSummary(WINDOW, {
      distractionApps: DISTRACTIONS,
      native,
    });
    expect(result).toEqual({ ok: false, reason: "permission-denied" });
    // never reads raw usage without permission
    expect(native.queryUsage).not.toHaveBeenCalled();
  });

  it("reads raw usage and returns only an aggregate summary when granted", async () => {
    const native = fakeNative("granted", [
      { packageName: "com.instagram.android", foregroundTimeMs: 30 * MIN },
      { packageName: "com.timeblocker", foregroundTimeMs: 30 * MIN },
    ]);
    const result = await collectUsageSummary(WINDOW, {
      distractionApps: DISTRACTIONS,
      native,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.summary.totalScreenTimeMin).toBe(60);
    expect(result.summary.distractionTimeMin).toBe(30);
    expect(result.summary.distractionLevel).toBe("high");
    // the raw package name must not survive into the returned summary (R7.3)
    expect(JSON.stringify(result.summary)).not.toContain(
      "com.instagram.android",
    );
  });
});
