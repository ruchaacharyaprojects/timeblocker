/**
 * `ReviewService`: the on-device Saturday review (R8.1, R9.1-R9.4, R11.10,
 * R12.6, R12.9).
 *
 * One `build(weekId?)` pass:
 * 1. resolves the Sunday-Saturday week (America/Toronto) — the current one by
 *    default;
 * 2. composes the week's `UsageSummary` on device: reads raw usage for the
 *    week window (Sunday 00:00 up to now, capped at the week's end) through
 *    the {@link UsageSource} port and collapses it with usage-metrics'
 *    `aggregateUsage` against the user's distraction list. Raw records never
 *    leave this function and are never persisted (R12.9). Without usage
 *    permission the summary is `null` and the review shows zero screen time;
 * 3. classifies the local blocks with flows' pure `buildWeeklyReview`
 *    (finished / partial / missed, moved-to-next-week with reasons, and the
 *    paste/type prompt; R9.1-R9.4);
 * 4. persists every un-happened workout as `missed` so it stays in its own
 *    week and never rolls into next Sunday (R8.1), together with the review
 *    under `reviews:<weekId>`, in one atomic `setMany`.
 *
 * The block status change touches no Google Calendar field, so no outbox
 * write is needed. Everything runs locally (R12.6).
 */
import { buildWeeklyReview, type WeeklyReview } from "@timeblocker/flows";
import type { Week } from "@timeblocker/scheduling-engine";
import {
  aggregateUsage,
  effectiveDistractionApps,
  type UsageSummary,
  type UsageWindow,
} from "@timeblocker/usage-metrics";
import type { DeviceBlock } from "../models.js";
import { weekIdAt } from "../notifications/service.js";
import type { Clock, UsageSource } from "../ports.js";
import type { Repositories } from "../repositories.js";
import { weekOfId } from "./planning.js";

export interface ReviewServiceDeps {
  repos: Repositories;
  clock: Clock;
  usage: UsageSource;
}

/** Whether the on-device usage summary could be read for the review. */
export type ReviewUsageOutcome = "ok" | "permission-denied";

export interface ReviewResult {
  weekId: string;
  review: WeeklyReview;
  /** `permission-denied` when usage access is not granted (screen time shows 0). */
  usage: ReviewUsageOutcome;
  /** Workouts newly persisted as `missed` by this pass (R8.1). */
  fitnessMissed: DeviceBlock[];
}

/**
 * The usage window for a week's review: from the week's Sunday up to `nowMs`,
 * capped at the week's end. A week that hasn't started yet yields an empty
 * window.
 */
export function reviewUsageWindow(week: Week, nowMs: number): UsageWindow {
  const startMs = Date.parse(week.sunday);
  const endMs = Math.max(startMs, Math.min(Date.parse(week.saturday), nowMs));
  return { startMs, endMs };
}

export class ReviewService {
  constructor(private readonly deps: ReviewServiceDeps) {}

  /** The current Toronto week id (YYYY-MM-DD of its Sunday). */
  currentWeekId(): string {
    return weekIdAt(this.deps.clock.now());
  }

  /**
   * Compose the week's usage summary on device from the {@link UsageSource}
   * port and `aggregateUsage`. Returns `null` without usage permission.
   */
  async usageSummary(week: Week, nowMs: number): Promise<UsageSummary | null> {
    const { repos, usage } = this.deps;
    if ((await usage.permission()) !== "granted") return null;
    const window = reviewUsageWindow(week, nowMs);
    const [records, settings] = await Promise.all([
      usage.readUsage(window),
      repos.settings.get(),
    ]);
    return aggregateUsage(records, window, effectiveDistractionApps(settings.distractionApps));
  }

  /** Build, persist, and return the Saturday review for `weekId` (default: current week). */
  async build(weekId: string = this.currentWeekId()): Promise<ReviewResult> {
    const { repos, clock } = this.deps;
    const nowMs = clock.now();
    const week = weekOfId(weekId);

    const [blocks, summary] = await Promise.all([
      repos.blocks.get(weekId),
      this.usageSummary(week, nowMs),
    ]);

    const { review, fitnessMissed } = buildWeeklyReview(
      weekId,
      blocks,
      summary,
      new Date(nowMs),
    );

    // Persist un-happened workouts as missed (R8.1); keep every other block as is.
    const missedIds = new Set(fitnessMissed.map((b) => b.id));
    const newlyMissed: DeviceBlock[] = [];
    const nextBlocks = blocks.map((b) => {
      if (!missedIds.has(b.id)) return b;
      const missed: DeviceBlock = { ...b, status: "missed", updatedAt: nowMs };
      newlyMissed.push(missed);
      return missed;
    });

    await repos.commit([
      ...(newlyMissed.length > 0 ? [repos.blocks.write(weekId, nextBlocks)] : []),
      repos.reviews.write(weekId, review),
    ]);

    return {
      weekId,
      review,
      usage: summary === null ? "permission-denied" : "ok",
      fitnessMissed: newlyMissed,
    };
  }

  /** The stored review for `weekId`, or `null` if none was built yet. */
  get(weekId: string): Promise<WeeklyReview | null> {
    return this.deps.repos.reviews.get(weekId);
  }
}
