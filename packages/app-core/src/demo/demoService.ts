/**
 * `DemoDataService` and the demo-aware port wrappers (R24).
 *
 * Loading writes only to past weeks (never the current one), never enqueues
 * outbox entries (demo blocks are already marked in sync), and never
 * overwrites a real sleep score. Everything demo-made is recognisable: block
 * ids start with `demo-`, sleep scores carry `demo: true`, and the `demoMode`
 * document records what was added so removal is exact.
 */
import type { AppUsageRecord, UsageWindow } from "@timeblocker/usage-metrics";
import type { DemoMode, DeviceBlock, SleepScoreMap } from "../models.js";
import { weekIdAt } from "../notifications/service.js";
import type {
  Clock,
  SleepAvailability,
  SleepPermission,
  SleepSession,
  SleepSource,
  UsagePermission,
  UsageSource,
} from "../ports.js";
import type { DocWrite, Repositories } from "../repositories.js";
import {
  DEMO_DISTRACTION_APPS,
  DEMO_ID_PREFIX,
  demoSleepScores,
  demoSleepSessions,
  demoUsageRecords,
  generateDemoBlocks,
} from "./demoData.js";

export interface DemoDataServiceDeps {
  repos: Repositories;
  clock: Clock;
}

export interface DemoLoadResult {
  /** Demo blocks written. */
  blocks: number;
  /** Demo sleep scores written. */
  nights: number;
  /** Past weeks that received demo blocks. */
  weeks: number;
}

export interface DemoRemoveResult {
  blocks: number;
  nights: number;
}

const isDemoBlock = (b: DeviceBlock) => b.id.startsWith(DEMO_ID_PREFIX);

export class DemoDataService {
  constructor(private readonly deps: DemoDataServiceDeps) {}

  /**
   * Load about 8 past weeks of blocks, 14 nights of sleep scores, and (when
   * the list is empty) the demo distraction apps. Idempotent: demo blocks and
   * demo scores from an earlier load are replaced, real ones are kept.
   */
  async load(): Promise<DemoLoadResult> {
    const { repos, clock } = this.deps;
    const now = clock.now();
    const currentWeek = weekIdAt(now);
    const previous = await repos.demoMode.get();

    // Group generated blocks by week; the current week and later are never written.
    const byWeek = new Map<string, DeviceBlock[]>();
    for (const b of generateDemoBlocks(now)) {
      if (b.weekId >= currentWeek) continue;
      byWeek.set(b.weekId, [...(byWeek.get(b.weekId) ?? []), b]);
    }

    const writes: DocWrite[] = [];
    let blocks = 0;

    // Weeks that held demo blocks before but are no longer part of the set.
    for (const weekId of previous?.blockWeeks ?? []) {
      if (byWeek.has(weekId) || weekId >= currentWeek) continue;
      const existing = await repos.blocks.get(weekId);
      const kept = existing.filter((b) => !isDemoBlock(b));
      if (kept.length !== existing.length) writes.push(repos.blocks.write(weekId, kept));
    }
    for (const [weekId, demo] of byWeek) {
      const existing = await repos.blocks.get(weekId);
      writes.push(repos.blocks.write(weekId, [...existing.filter((b) => !isDemoBlock(b)), ...demo]));
      blocks += demo.length;
    }

    // Sleep scores: replace earlier demo scores, never overwrite a real night.
    const stored = await repos.sleepScores.get();
    const scores: SleepScoreMap = {};
    for (const [k, v] of Object.entries(stored)) if (!v.demo) scores[k] = v;
    let nights = 0;
    for (const s of demoSleepScores(now)) {
      if (scores[s.dateKey]) continue;
      scores[s.dateKey] = s;
      nights += 1;
    }
    writes.push(repos.sleepScores.write(scores));

    // Distraction apps: only when none are set (or we added them in an earlier load).
    const settings = await repos.settings.get();
    let addedDistractionApps = previous?.addedDistractionApps === true && settings.distractionApps.length > 0;
    if (settings.distractionApps.length === 0) {
      writes.push(repos.settings.write({ ...settings, distractionApps: [...DEMO_DISTRACTION_APPS] }));
      addedDistractionApps = true;
    }

    const doc: DemoMode = {
      loadedAt: now,
      blockWeeks: [...byWeek.keys()],
      demoUsage: previous?.demoUsage ?? false,
      addedDistractionApps,
    };
    writes.push(repos.demoMode.write(doc));

    await repos.commit(writes);
    return { blocks, nights, weeks: byWeek.size };
  }

  /**
   * Delete every demo block (in the recorded weeks) and demo sleep score,
   * take back the distraction apps this service added, turn the demo-usage
   * switch off, and clear the bookkeeping. Real data is left unchanged.
   */
  async remove(): Promise<DemoRemoveResult> {
    const { repos } = this.deps;
    const doc = await repos.demoMode.get();
    const writes: DocWrite[] = [];
    let blocks = 0;
    let nights = 0;

    for (const weekId of doc?.blockWeeks ?? []) {
      const existing = await repos.blocks.get(weekId);
      const kept = existing.filter((b) => !isDemoBlock(b));
      if (kept.length !== existing.length) {
        blocks += existing.length - kept.length;
        writes.push(repos.blocks.write(weekId, kept));
      }
    }

    const stored = await repos.sleepScores.get();
    const scores: SleepScoreMap = {};
    for (const [k, v] of Object.entries(stored)) {
      if (v.demo) nights += 1;
      else scores[k] = v;
    }
    if (nights > 0) writes.push(repos.sleepScores.write(scores));

    if (doc?.addedDistractionApps) {
      const settings = await repos.settings.get();
      const apps = settings.distractionApps.filter((a) => !DEMO_DISTRACTION_APPS.includes(a));
      if (apps.length !== settings.distractionApps.length) {
        writes.push(repos.settings.write({ ...settings, distractionApps: apps }));
      }
    }

    if (doc !== null) writes.push(repos.demoMode.write(null));
    await repos.commit(writes);
    return { blocks, nights };
  }

  /** The "Use demo screen usage" switch (R24.3). Persisted in the demo document. */
  async setDemoUsage(enabled: boolean): Promise<void> {
    const { repos, clock } = this.deps;
    const doc = await repos.demoMode.get();
    if (!doc) {
      if (!enabled) return;
      await repos.demoMode.save({
        loadedAt: clock.now(),
        blockWeeks: [],
        demoUsage: true,
        addedDistractionApps: false,
      });
      return;
    }
    if (doc.demoUsage === enabled) return;
    const next: DemoMode = { ...doc, demoUsage: enabled };
    // A document that only carried the switch has nothing left once it is off.
    const empty = !enabled && next.blockWeeks.length === 0 && !next.addedDistractionApps;
    await repos.demoMode.save(empty ? null : next);
  }

  async isDemoUsageEnabled(): Promise<boolean> {
    return (await this.deps.repos.demoMode.get())?.demoUsage === true;
  }
}

async function demoUsageOn(repos: Repositories): Promise<boolean> {
  try {
    return (await repos.demoMode.get())?.demoUsage === true;
  } catch {
    return false;
  }
}

/**
 * A {@link UsageSource} that answers with deterministic synthetic usage and
 * reports access as granted while "Use demo screen usage" is on; otherwise it
 * delegates to the real source (R24.3).
 */
export class DemoUsageSource implements UsageSource {
  constructor(
    private readonly real: UsageSource,
    private readonly repos: Repositories,
  ) {}

  async permission(): Promise<UsagePermission> {
    return (await demoUsageOn(this.repos)) ? "granted" : this.real.permission();
  }

  async readUsage(window: UsageWindow): Promise<AppUsageRecord[]> {
    return (await demoUsageOn(this.repos)) ? demoUsageRecords(window) : this.real.readUsage(window);
  }
}

/** Nights to generate for a read window (one extra each side). */
function nightsIn(window: UsageWindow): number {
  return Math.min(120, Math.ceil(Math.max(0, window.endMs - window.startMs) / 86_400_000) + 2);
}

/**
 * A {@link SleepSource} serving demo sessions while the demo-usage switch is
 * on AND the real source's permission is not granted, so the whole health
 * path can be exercised without Health Connect. Otherwise it delegates.
 * Sessions are a pure function of the night, so any window yields the same
 * sessions as {@link demoSleepSessions}.
 */
export class DemoSleepSource implements SleepSource {
  constructor(
    private readonly real: SleepSource,
    private readonly repos: Repositories,
  ) {}

  private async useDemo(): Promise<boolean> {
    if (!(await demoUsageOn(this.repos))) return false;
    try {
      return (await this.real.permission()) !== "granted";
    } catch {
      return true;
    }
  }

  async availability(): Promise<SleepAvailability> {
    return (await this.useDemo()) ? "available" : this.real.availability();
  }

  async permission(): Promise<SleepPermission> {
    return (await this.useDemo()) ? "granted" : this.real.permission();
  }

  async requestPermission(): Promise<SleepPermission> {
    return this.real.requestPermission();
  }

  async readSessions(window: UsageWindow): Promise<SleepSession[]> {
    if (!(await this.useDemo())) return this.real.readSessions(window);
    return demoSleepSessions(window.endMs, nightsIn(window)).filter(
      (s) => s.endMs > window.startMs && s.startMs < window.endMs,
    );
  }
}
