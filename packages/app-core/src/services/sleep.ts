/**
 * `SleepService`: nightly sleep score from phone use (R19, D16).
 *
 * `recordRecentNights` scores each of the last 3 fully ended nights that has
 * no stored score yet, with one `UsageSource.readUsage(window)` per night.
 * With a granted `SleepSource` a night is scored from its Health Connect
 * session plus phone use inside it (R25); otherwise from phone use alone.
 * Only `{dateKey, usageMin, asleepMin?, score, scoredAt, source}` is stored (R19.3, R25.4); raw records
 * stay inside this function. A denied permission or a failed read writes
 * nothing for that night, and the night is retried on a later run while it is
 * still among the last 3 (R19.4). The method never throws.
 */
import {
  healthReadWindow,
  healthSleepScore,
  nightWindow,
  nightsEndedBefore,
  selectNightSession,
  sleepScore,
  sleepUsageMin,
} from "@timeblocker/usage-metrics";
import type { SleepScore, SleepScoreMap } from "../models.js";
import type { Clock, SleepSource, UsageSource } from "../ports.js";
import type { Repositories } from "../repositories.js";

export type { SleepScore } from "../models.js";

/** How many recent nights are scored per run (Android keeps usage events briefly). */
export const SLEEP_SCORED_NIGHTS = 3;
/** Scores older than this are pruned (R19.3 keeps at least 26 weeks). */
export const SLEEP_RETENTION_DAYS = 26 * 7 + 1;

export interface SleepServiceDeps {
  repos: Repositories;
  usage: UsageSource;
  clock: Clock;
  /**
   * Health Connect sleep sessions (R25). When present and its permission is
   * granted, nights are scored from the session plus phone use inside it;
   * otherwise (or when a night has no qualifying session) the fixed
   * 22:00-06:30 phone-use-only score is used.
   */
  sleepSource?: SleepSource;
}

export interface RecordNightsResult {
  /** dateKeys scored in this run, newest first. */
  recorded: string[];
  /** `permission-denied`: usage access missing; `none`: nothing to score; otherwise undefined. */
  skipped: "permission-denied" | "none" | undefined;
}

const DAY_MS = 86_400_000;

function addDays(dateKey: string, days: number): string {
  const [y, m, d] = dateKey.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d) + days * DAY_MS).toISOString().slice(0, 10);
}

export class SleepService {
  constructor(private readonly deps: SleepServiceDeps) {}

  async recordRecentNights(): Promise<RecordNightsResult> {
    try {
      return await this.record();
    } catch {
      return { recorded: [], skipped: undefined };
    }
  }

  private async record(): Promise<RecordNightsResult> {
    const { repos, usage, clock } = this.deps;
    const usageGranted = (await usage.permission()) === "granted";
    const healthOn = await this.healthReady();
    // Health scoring works without usage access (phone minutes count as 0).
    if (!usageGranted && !healthOn) {
      return { recorded: [], skipped: "permission-denied" };
    }

    const now = clock.now();
    const stored = await repos.sleepScores.get();
    const missing = nightsEndedBefore(now, SLEEP_SCORED_NIGHTS).filter((k) => !stored[k]);

    const added: SleepScore[] = [];
    for (const dateKey of missing) {
      try {
        if (healthOn) {
          const scored = await this.scoreFromHealth(dateKey, usageGranted, now);
          if (scored) {
            added.push(scored);
            continue;
          }
        }
        if (!usageGranted) continue;
        const records = await usage.readUsage(nightWindow(dateKey));
        const usageMin = sleepUsageMin(records);
        added.push({ dateKey, usageMin, score: sleepScore(usageMin), scoredAt: now, source: "usage" });
      } catch {
        // Leave this night unscored; it is retried on a later run.
      }
    }

    const cutoff = addDays(new Date(now).toISOString().slice(0, 10), -SLEEP_RETENTION_DAYS);
    const next: SleepScoreMap = {};
    let pruned = false;
    for (const [k, v] of Object.entries(stored)) {
      if (k < cutoff) pruned = true;
      else next[k] = v;
    }
    for (const s of added) next[s.dateKey] = s;

    if (added.length > 0 || pruned) {
      try {
        await repos.sleepScores.save(next);
      } catch {
        return { recorded: [], skipped: undefined };
      }
    }
    return {
      recorded: added.map((s) => s.dateKey),
      skipped: missing.length === 0 ? "none" : undefined,
    };
  }

  /** True when a sleep source exists, is available, and permission is granted. */
  private async healthReady(): Promise<boolean> {
    const source = this.deps.sleepSource;
    if (!source) return false;
    try {
      return (await source.availability()) === "available" && (await source.permission()) === "granted";
    } catch {
      return false;
    }
  }

  /**
   * Score one night from its Health Connect session (R25.2, R25.3). Phone
   * minutes are read for [session.start, session.end); when usage access is
   * denied they count as 0 and the score comes from sleep duration alone.
   * Returns `undefined` when the health read fails or no session qualifies,
   * so the caller falls back to the phone-use-only score. A usage read that
   * fails after a session was found also returns `undefined`.
   */
  private async scoreFromHealth(
    dateKey: string,
    usageGranted: boolean,
    now: number,
  ): Promise<SleepScore | undefined> {
    const source = this.deps.sleepSource!;
    try {
      const sessions = await source.readSessions(healthReadWindow(dateKey));
      const session = selectNightSession(dateKey, sessions);
      if (!session) return undefined;
      let phoneMin = 0;
      if (usageGranted) {
        const records = await this.deps.usage.readUsage({
          startMs: session.startMs,
          endMs: session.endMs,
        });
        phoneMin = sleepUsageMin(records);
      }
      const asleepMin = Math.max(0, Math.round(session.asleepMin));
      return {
        dateKey,
        usageMin: phoneMin,
        asleepMin,
        score: healthSleepScore({ asleepMin, phoneMin }),
        scoredAt: now,
        source: "health+usage",
      };
    } catch {
      return undefined;
    }
  }

  /**
   * Stored scores for nights that start in the week's Sunday..Saturday
   * (a Saturday night belongs to that week), oldest first.
   */
  async scoresForWeek(weekId: string): Promise<SleepScore[]> {
    const stored = await this.deps.repos.sleepScores.get();
    const out: SleepScore[] = [];
    for (let i = 0; i < 7; i++) {
      const s = stored[addDays(weekId, i)];
      if (s) out.push(s);
    }
    return out;
  }
}
