/**
 * `createForecastProvider`: the `forecasts` option of `NotificationService`
 * (R17.3). For each scheduled future block it combines how often similar
 * blocks were finished, an overlapping meeting, and (for blocks starting
 * within 30 minutes) recent distraction-app use, via the pure `forecastBlock`.
 *
 * Usage is read at most once per call, only when a block starts within the
 * horizon, the distraction list is non-empty and usage access is granted.
 * Raw usage stays inside the call. Any failure is treated as "no
 * distraction"; the provider never throws.
 */
import {
  DEFAULT_MISS_RISK_LOOKBACK_MS,
  effectiveDistractionApps,
  missRiskSignal,
  type AppUsageRecordWithWindow,
  type UsageWindow,
} from "@timeblocker/usage-metrics";
import type { CalendarEvent } from "@timeblocker/calendar-integration";
import type { DeviceBlock } from "../models.js";
import type { Clock, UsageSource } from "../ports.js";
import type { Repositories } from "../repositories.js";
import { forecastBlock, type Forecast, type ForecastHistoryEntry } from "../notifications/forecast.js";
import { weekIdAt } from "../notifications/service.js";
import { USAGE_RISK_HORIZON_MS } from "./usageRisk.js";

export interface ForecastProviderDeps {
  repos: Repositories;
  clock: Clock;
  history: { categoryOutcomes(weekId: string): Promise<ForecastHistoryEntry[]> };
  /** Without it no distraction signal is used. */
  usage?: UsageSource;
  /** Distraction minutes that count as at risk; defaults to usage-metrics' 5. */
  thresholdMin?: number;
}

export type ForecastProvider = (input: {
  blocks: readonly DeviceBlock[];
  events: readonly CalendarEvent[];
  now: number;
}) => Promise<ReadonlyMap<string, Forecast>>;

export function createForecastProvider(deps: ForecastProviderDeps): ForecastProvider {
  const { repos, history, usage } = deps;

  async function readUsage(now: number): Promise<AppUsageRecordWithWindow[] | null> {
    try {
      if (!usage) return null;
      if ((await usage.permission()) !== "granted") return null;
      const window: UsageWindow = { startMs: now - DEFAULT_MISS_RISK_LOOKBACK_MS, endMs: now };
      return (await usage.readUsage(window)).map((r) => ({ ...r, ...window }));
    } catch {
      return null;
    }
  }

  return async ({ blocks, events, now }) => {
    const result = new Map<string, Forecast>();
    try {
      const upcoming = blocks.filter((b) => b.status === "scheduled" && Date.parse(b.start) > now);
      if (upcoming.length === 0) return result;
      const outcomes = await history.categoryOutcomes(weekIdAt(now));

      let records: AppUsageRecordWithWindow[] | null = null;
      let usageRead = false;
      let distractionApps: string[] = [];
      for (const block of upcoming) {
        const startMs = Date.parse(block.start);
        let recentDistraction = false;
        if (startMs <= now + USAGE_RISK_HORIZON_MS) {
          if (!usageRead) {
            usageRead = true;
            records = await readUsage(now);
            if (records) distractionApps = effectiveDistractionApps((await repos.settings.get()).distractionApps);
          }
          if (records) {
            try {
              recentDistraction = missRiskSignal(records, distractionApps, startMs, {
                lookbackMs: startMs - (now - DEFAULT_MISS_RISK_LOOKBACK_MS),
                thresholdMin: deps.thresholdMin,
              }).atRisk;
            } catch {
              recentDistraction = false;
            }
          }
        }
        result.set(
          block.id,
          forecastBlock({ block, history: outcomes, events, recentDistraction }),
        );
      }
      return result;
    } catch {
      return new Map();
    }
  };
}
