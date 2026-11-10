/**
 * `HistoryReader`: past blocks and cached calendar events, flattened for
 * duration/category estimation at intake (R15.3, R15.4) and for the per-block
 * forecast (R17.3).
 *
 * The window is the 26 weeks before the target week plus the target week
 * itself, newest first, so category ties break to the most recent entry. A
 * missing week is empty and one failed read never fails the load.
 */
import { BLOCK_PREFIX } from "@timeblocker/calendar-integration";
import type { HistoryEntry, PlacementHistoryEntry } from "@timeblocker/flows";
import type { Clock } from "../ports.js";
import type { Repositories } from "../repositories.js";
import type { ForecastHistoryEntry } from "../notifications/forecast.js";
import { weekIdAt } from "../notifications/service.js";

/** How many weeks before the target week are read. */
export const HISTORY_WEEKS = 26;

/** Events this long (or longer) are treated as all-day-like and ignored. */
export const HISTORY_MAX_EVENT_MS = 12 * 3_600_000;

const WEEK_MS = 7 * 24 * 3_600_000;

/** What intake estimation reads. */
export interface IntakeHistory {
  blocks: HistoryEntry[];
  events: HistoryEntry[];
}

/** The slice of a history reader that `IntakeService` needs. */
export interface HistorySource {
  load(weekId: string): Promise<IntakeHistory>;
}

/** The slice of a history reader that `PlanningService` needs for R23. */
export interface PlacementHistorySource {
  placementHistory(weekId: string): Promise<PlacementHistoryEntry[]>;
}

/**
 * The `weekId` `weeks` weeks before `weekId` (negative: after). Anchored at
 * noon UTC of the Sunday, which is the same Toronto date in every season.
 */
export function shiftWeekId(weekId: string, weeks: number): string {
  const anchor = Date.parse(`${weekId}T12:00:00Z`);
  if (!Number.isFinite(anchor)) return weekId;
  return weekIdAt(anchor - weeks * WEEK_MS);
}

/** Target week first, then each earlier week, `upToWeeks` of them. */
function windowWeekIds(weekId: string, upToWeeks: number): string[] {
  const ids: string[] = [];
  for (let i = 0; i <= upToWeeks; i++) ids.push(shiftWeekId(weekId, i));
  return ids;
}

function minutesBetween(start: string, end: string): number {
  const ms = Date.parse(end) - Date.parse(start);
  return Number.isFinite(ms) ? Math.round(ms / 60_000) : 0;
}

export interface HistoryReaderDeps {
  repos: Repositories;
  clock: Clock;
}

export class HistoryReader implements HistorySource, PlacementHistorySource {
  constructor(private readonly deps: HistoryReaderDeps) {}

  /** Blocks and non-block events of the target week and the 26 before it, newest first. */
  async load(weekId: string): Promise<IntakeHistory> {
    const { repos } = this.deps;
    const blocks: HistoryEntry[] = [];
    const events: HistoryEntry[] = [];
    for (const id of windowWeekIds(weekId, HISTORY_WEEKS)) {
      try {
        const weekBlocks = [...(await repos.blocks.get(id))].sort(
          (a, b) => Date.parse(b.start) - Date.parse(a.start),
        );
        for (const b of weekBlocks) {
          const title = b.title?.trim() || b.text?.trim() || "";
          if (title.length === 0) continue;
          blocks.push({
            title,
            category: b.category,
            durationMin: minutesBetween(b.start, b.end),
            status: b.status,
          });
        }
      } catch {
        // One unreadable week must not fail the load.
      }
      try {
        const cache = await repos.calendarCache.get(id);
        const weekEvents = [...(cache?.events ?? [])].sort(
          (a, b) => Date.parse(b.start) - Date.parse(a.start),
        );
        for (const e of weekEvents) {
          const title = (e.summary ?? "").trim();
          if (title.length === 0) continue;
          if (e.isBlock === true || title.startsWith(BLOCK_PREFIX)) continue;
          const ms = Date.parse(e.end) - Date.parse(e.start);
          if (!Number.isFinite(ms) || ms <= 0 || ms >= HISTORY_MAX_EVENT_MS) continue;
          events.push({ title, category: "misc", durationMin: Math.round(ms / 60_000) });
        }
      } catch {
        // Same: skip this week's events.
      }
    }
    return { blocks, events };
  }

  /** Category, start and status of every block in the window (R23.1). */
  async placementHistory(weekId: string): Promise<PlacementHistoryEntry[]> {
    const out: PlacementHistoryEntry[] = [];
    for (const id of windowWeekIds(weekId, HISTORY_WEEKS)) {
      try {
        for (const b of await this.deps.repos.blocks.get(id)) {
          out.push({ category: b.category, start: b.start, status: b.status });
        }
      } catch {
        // Skip an unreadable week.
      }
    }
    return out;
  }

  /** Category and status of every block in the window, for forecasts. */
  async categoryOutcomes(weekId: string, upToWeeks = HISTORY_WEEKS): Promise<ForecastHistoryEntry[]> {
    const out: ForecastHistoryEntry[] = [];
    for (const id of windowWeekIds(weekId, upToWeeks)) {
      try {
        for (const b of await this.deps.repos.blocks.get(id)) {
          out.push({ category: b.category, status: b.status });
        }
      } catch {
        // Skip an unreadable week.
      }
    }
    return out;
  }
}
