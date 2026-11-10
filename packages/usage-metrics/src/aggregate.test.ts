import { describe, it, expect } from "vitest";
import {
  aggregateUsage,
  classifyDistraction,
  missRiskSignal,
  DEFAULT_THRESHOLDS,
  type AppUsageRecordWithWindow,
} from "./aggregate.js";
import type { AppUsageRecord, UsageWindow } from "./types.js";

const MIN = 60_000;
const WINDOW: UsageWindow = { startMs: 0, endMs: 24 * 60 * MIN };
const DISTRACTIONS = ["com.instagram.android", "com.tiktok"];

describe("classifyDistraction", () => {
  it("maps ratios to coarse levels with default thresholds", () => {
    expect(classifyDistraction(0)).toBe("low");
    expect(classifyDistraction(0.1)).toBe("low");
    expect(classifyDistraction(0.2)).toBe("moderate");
    expect(classifyDistraction(0.39)).toBe("moderate");
    expect(classifyDistraction(0.4)).toBe("high");
    expect(classifyDistraction(1)).toBe("high");
  });

  it("respects custom thresholds", () => {
    expect(classifyDistraction(0.5, { moderate: 0.6, high: 0.9 })).toBe("low");
  });
});

describe("aggregateUsage (R7.3 on-device summary)", () => {
  it("sums total screen time and distraction time in minutes", () => {
    const records: AppUsageRecord[] = [
      { packageName: "com.instagram.android", foregroundTimeMs: 30 * MIN },
      { packageName: "com.timeblocker", foregroundTimeMs: 60 * MIN },
      { packageName: "com.tiktok", foregroundTimeMs: 10 * MIN },
    ];
    const s = aggregateUsage(records, WINDOW, DISTRACTIONS);
    expect(s.totalScreenTimeMin).toBe(100);
    expect(s.distractionTimeMin).toBe(40);
    expect(s.distractionAppCount).toBe(2);
    expect(s.distractionRatio).toBeCloseTo(0.4, 5);
    expect(s.distractionLevel).toBe("high");
  });

  it("returns zeroed, low summary for no usage", () => {
    const s = aggregateUsage([], WINDOW, DISTRACTIONS);
    expect(s.totalScreenTimeMin).toBe(0);
    expect(s.distractionTimeMin).toBe(0);
    expect(s.distractionRatio).toBe(0);
    expect(s.distractionLevel).toBe("low");
    expect(s.distractionAppCount).toBe(0);
  });

  it("clamps negative durations and ignores zero-time records", () => {
    const records: AppUsageRecord[] = [
      { packageName: "com.instagram.android", foregroundTimeMs: -5 * MIN },
      { packageName: "com.tiktok", foregroundTimeMs: 0 },
      { packageName: "com.timeblocker", foregroundTimeMs: 20 * MIN },
    ];
    const s = aggregateUsage(records, WINDOW, DISTRACTIONS);
    expect(s.totalScreenTimeMin).toBe(20);
    expect(s.distractionTimeMin).toBe(0);
    expect(s.distractionAppCount).toBe(0);
  });

  it("the summary carries no raw per-app data (privacy boundary, R7.3)", () => {
    const records: AppUsageRecord[] = [
      { packageName: "com.instagram.android", foregroundTimeMs: 15 * MIN },
    ];
    const s = aggregateUsage(records, WINDOW, DISTRACTIONS);
    const keys = Object.keys(s).sort();
    expect(keys).toEqual(
      [
        "distractionAppCount",
        "distractionLevel",
        "distractionRatio",
        "distractionTimeMin",
        "totalScreenTimeMin",
        "window",
      ].sort(),
    );
    // No field exposes package names.
    expect(JSON.stringify(s)).not.toContain("com.instagram.android");
  });

  it("honors custom thresholds", () => {
    const records: AppUsageRecord[] = [
      { packageName: "com.instagram.android", foregroundTimeMs: 25 * MIN },
      { packageName: "com.timeblocker", foregroundTimeMs: 75 * MIN },
    ];
    const s = aggregateUsage(records, WINDOW, DISTRACTIONS, {
      moderate: 0.3,
      high: 0.5,
    });
    // ratio 0.25 -> below custom moderate 0.3
    expect(s.distractionLevel).toBe("low");
    // same data with default thresholds crosses moderate (0.2)
    expect(
      aggregateUsage(records, WINDOW, DISTRACTIONS, DEFAULT_THRESHOLDS)
        .distractionLevel,
    ).toBe("moderate");
  });
});

describe("missRiskSignal (R6.1 near-term signal)", () => {
  const blockStart = 100 * MIN;

  it("flags risk when recent distraction crosses the threshold", () => {
    const records: AppUsageRecordWithWindow[] = [
      {
        packageName: "com.instagram.android",
        foregroundTimeMs: 8 * MIN,
        startMs: 92 * MIN,
        endMs: 100 * MIN,
      },
    ];
    const sig = missRiskSignal(records, DISTRACTIONS, blockStart, {
      lookbackMs: 10 * MIN,
      thresholdMin: 5,
    });
    expect(sig.recentDistractionMin).toBe(8);
    expect(sig.atRisk).toBe(true);
  });

  it("does not flag when below the threshold", () => {
    const records: AppUsageRecordWithWindow[] = [
      {
        packageName: "com.instagram.android",
        foregroundTimeMs: 2 * MIN,
        startMs: 95 * MIN,
        endMs: 100 * MIN,
      },
    ];
    const sig = missRiskSignal(records, DISTRACTIONS, blockStart);
    expect(sig.atRisk).toBe(false);
  });

  it("ignores non-distraction apps and usage outside the lookback", () => {
    const records: AppUsageRecordWithWindow[] = [
      // non-distraction, ignored
      {
        packageName: "com.timeblocker",
        foregroundTimeMs: 20 * MIN,
        startMs: 92 * MIN,
        endMs: 100 * MIN,
      },
      // distraction but entirely before the lookback window
      {
        packageName: "com.tiktok",
        foregroundTimeMs: 30 * MIN,
        startMs: 0,
        endMs: 60 * MIN,
      },
    ];
    const sig = missRiskSignal(records, DISTRACTIONS, blockStart, {
      lookbackMs: 10 * MIN,
      thresholdMin: 5,
    });
    expect(sig.recentDistractionMin).toBe(0);
    expect(sig.atRisk).toBe(false);
  });

  it("weights usage by the fraction overlapping the lookback", () => {
    // app ran 90..100 (10 min span) with 10 min foreground; lookback is
    // 95..100, so half (5 min) counts.
    const records: AppUsageRecordWithWindow[] = [
      {
        packageName: "com.tiktok",
        foregroundTimeMs: 10 * MIN,
        startMs: 90 * MIN,
        endMs: 100 * MIN,
      },
    ];
    const sig = missRiskSignal(records, DISTRACTIONS, blockStart, {
      lookbackMs: 5 * MIN,
      thresholdMin: 4,
    });
    expect(sig.recentDistractionMin).toBe(5);
    expect(sig.atRisk).toBe(true);
  });
});
