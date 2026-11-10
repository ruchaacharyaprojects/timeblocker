/**
 * Pure per-block forecast shown in the reminder body (R17.3).
 *
 * `forecastBlock` combines three signals about a block that is about to
 * start: a meeting that overlaps it, recent time on distraction apps, and how
 * often similar blocks (same category) were finished before. The result is a
 * verdict plus a one-line reason. No I/O, no clock reads.
 */
import type { CalendarEvent } from "@timeblocker/calendar-integration";
import type { DeviceBlockStatus } from "../models.js";

/** One past block, reduced to what the forecast needs. */
export interface ForecastHistoryEntry {
  category: string;
  status: DeviceBlockStatus;
}

export type ForecastVerdict = "likely" | "unlikely" | "unknown";

export interface Forecast {
  verdict: ForecastVerdict;
  /** Plain reason without a prefix, e.g. "You finished 4 of 5 similar blocks". */
  reason: string;
  /** The reminder body line; empty when the verdict is `unknown`. */
  line: string;
}

/** History needs at least this many counted blocks in the category (R17.3). */
export const FORECAST_MIN_SAMPLES = 3;

/** Completion share below this is "unlikely". */
export const FORECAST_MIN_SHARE = 0.5;

export interface ForecastInput {
  block: { start: string; end: string; category: string };
  history: readonly ForecastHistoryEntry[];
  events: readonly CalendarEvent[];
  /** True when recent usage shows time on the user's distraction apps. */
  recentDistraction?: boolean;
}

const FINISHED: ReadonlySet<DeviceBlockStatus> = new Set(["done", "partial"]);
const NOT_FINISHED: ReadonlySet<DeviceBlockStatus> = new Set(["missed", "skipped"]);

function build(verdict: ForecastVerdict, reason: string): Forecast {
  if (verdict === "likely") return { verdict, reason, line: `Likely to happen: ${reason}` };
  if (verdict === "unlikely") return { verdict, reason, line: `May not happen: ${reason}` };
  return { verdict, reason, line: "" };
}

/** The first qualifying meeting (by start) that overlaps `[start, end)`, if any. */
function overlappingMeeting(startMs: number, endMs: number, events: readonly CalendarEvent[]): CalendarEvent | null {
  let found: { event: CalendarEvent; start: number } | null = null;
  for (const e of events) {
    if (!e.withOthers || e.isBlock) continue;
    const s = Date.parse(e.start);
    const t = Date.parse(e.end);
    if (!Number.isFinite(s) || !Number.isFinite(t)) continue;
    if (s < endMs && startMs < t && (!found || s < found.start)) found = { event: e, start: s };
  }
  return found?.event ?? null;
}

/**
 * The forecast for one block. Priority among negative reasons: meeting
 * overlap, then distraction, then low completion (R17.3).
 */
export function forecastBlock(input: ForecastInput): Forecast {
  const startMs = Date.parse(input.block.start);
  const endMs = Date.parse(input.block.end);

  let finished = 0;
  let counted = 0;
  for (const h of input.history) {
    if (h.category !== input.block.category) continue;
    if (FINISHED.has(h.status)) {
      finished++;
      counted++;
    } else if (NOT_FINISHED.has(h.status)) {
      counted++;
    }
  }
  const enough = counted >= FORECAST_MIN_SAMPLES;
  const share = enough ? finished / counted : null;

  if (Number.isFinite(startMs) && Number.isFinite(endMs)) {
    const meeting = overlappingMeeting(startMs, endMs, input.events);
    if (meeting) return build("unlikely", `Overlaps ${meeting.summary || "a meeting"}`);
  }
  if (input.recentDistraction) return build("unlikely", "You've been on your distraction apps");

  if (share === null) return build("unknown", "");
  const reason = `You finished ${finished} of ${counted} similar blocks`;
  return build(share < FORECAST_MIN_SHARE ? "unlikely" : "likely", reason);
}
