/**
 * `buildWeekView`: the pure week-view model (R11.7, R13.9, R14.2, R14.10).
 *
 * - The range is `weekBounds(now)`: Sunday 00:00 to the end of Saturday in
 *   America/Toronto, so DST weeks are 167 or 169 hours long.
 * - It holds exactly the local blocks and the non-🧱 cached events whose
 *   half-open spans overlap that range. Blocks use their category color and
 *   label; other events use {@link CALENDAR_EVENT_STYLE} and "Calendar".
 * - Bell badges come from {@link NotificationIndicators} (only while the
 *   notification permission is denied, R13.9).
 * - A dismissible error banner names the failed sync; it hides once
 *   dismissed or after a later successful sync (R14.10).
 * - "Last synced" shows the last successful sync time in Toronto.
 */
import { BLOCK_PREFIX, type CalendarEvent } from "@timeblocker/calendar-integration";
import type { Category } from "@timeblocker/scheduling-engine";
import { torontoDateKey, weekBounds } from "@timeblocker/scheduling-engine";
import type { CalendarCache, DeviceBlock, DeviceBlockStatus, SyncState } from "../models.js";
import type { NotificationIndicators } from "../notifications/service.js";
import {
  CALENDAR_EVENT_LABEL,
  CALENDAR_EVENT_STYLE,
  CATEGORY_LABELS,
  categoryStyle,
  type ItemStyle,
} from "./colors.js";
import {
  STATUS_LABELS,
  addDaysToKey,
  formatDateKey,
  formatTimeRange,
  formatTorontoDateTime,
} from "./format.js";

/** Banner copy prefix; the message names the failed sync (R14.10). */
export const SYNC_FAILED_PREFIX = "Calendar sync failed";

/** Deep link for a block (also used by notification taps). */
export const blockDeepLink = (blockId: string) => `timeblocker://block/${blockId}`;

export interface WeekViewInput {
  /** epoch ms */
  now: number;
  /** Local blocks (any weeks; only those overlapping the current week are shown). */
  blocks: readonly DeviceBlock[];
  /** The current week's calendar cache from the latest completed sync. */
  cache: CalendarCache | null;
  syncState: SyncState;
  /** Bell badges; omitted or `denied: false` shows none. */
  indicators?: NotificationIndicators;
  /** True while a pull-to-refresh sync runs (R14.2). */
  refreshing?: boolean;
}

interface WeekItemBase {
  id: string;
  title: string;
  /** ISO instants as stored. */
  start: string;
  end: string;
  /** Toronto `YYYY-MM-DD` of the day column (start, clamped into the week). */
  dayKey: string;
  /** e.g. "2:30 PM – 3:30 PM" (Toronto). */
  timeLabel: string;
  /** Text label always shown next to the color (category name or "Calendar"). */
  label: string;
  style: ItemStyle;
  /** Show the bell badge (R13.9). */
  indicator: boolean;
}

export interface WeekBlockItem extends WeekItemBase {
  kind: "block";
  category: Category;
  status: DeviceBlockStatus;
  statusLabel: string;
  /** `timeblocker://block/<id>`: opens block detail (R11.8). */
  deepLink: string;
}

export interface WeekEventItem extends WeekItemBase {
  kind: "calendar";
  /** Has attendees other than the user. */
  withOthers: boolean;
}

export type WeekItem = WeekBlockItem | WeekEventItem;

export interface WeekDay {
  /** Toronto `YYYY-MM-DD`. */
  dateKey: string;
  /** e.g. "Sun, Mar 8". */
  label: string;
  /** True for the day containing `now`. */
  isToday: boolean;
  /** Blocks and events starting this day, by start then id. */
  items: WeekItem[];
}

export interface SyncBanner {
  message: string;
  /** epoch ms of the failure */
  at: number;
  dismissible: true;
}

export interface WeekView {
  /** Sunday `YYYY-MM-DD` (Toronto). */
  weekId: string;
  /** Sunday 00:00 Toronto (ISO). */
  rangeStart: string;
  /** End of Saturday, i.e. next Sunday 00:00 Toronto (ISO, exclusive). */
  rangeEnd: string;
  /** e.g. "Sun, Mar 8 – Sat, Mar 14". */
  rangeLabel: string;
  /** Exactly seven days, Sunday first. */
  days: WeekDay[];
  /** Every shown block, by start then id. */
  blocks: WeekBlockItem[];
  /** Every shown non-🧱 event, by start then id. */
  events: WeekEventItem[];
  banner: SyncBanner | null;
  lastSynced: { at: number; label: string } | null;
  refreshing: boolean;
}

/** Parsed half-open span, or null when either end is invalid or empty. */
function spanMs(start: string, end: string): [number, number] | null {
  const s = Date.parse(start);
  const e = Date.parse(end);
  return Number.isFinite(s) && Number.isFinite(e) && s < e ? [s, e] : null;
}

/** True for a TimeBlocker block event (🧱), even when `isBlock` is unset. */
function isBlockEvent(e: CalendarEvent): boolean {
  return e.isBlock === true || e.summary.trimStart().startsWith(BLOCK_PREFIX);
}

const byStartThenId = <T extends { start: string; id: string }>(a: T, b: T) =>
  Date.parse(a.start) - Date.parse(b.start) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** The sync error banner, or null when there is none to show (R14.10). */
export function syncBanner(state: SyncState): SyncBanner | null {
  const error = state.error;
  if (!error || error.dismissed) return null;
  if (state.lastSuccessAt !== undefined && state.lastSuccessAt > error.at) return null;
  return { message: `${SYNC_FAILED_PREFIX}: ${error.message}`, at: error.at, dismissible: true };
}

/** Build the week view for the Toronto week containing `now`. Pure. */
export function buildWeekView(input: WeekViewInput): WeekView {
  const week = weekBounds(new Date(input.now));
  const startMs = Date.parse(week.sunday);
  const endMs = Date.parse(week.saturday);
  const weekId = torontoDateKey(new Date(startMs));
  const denied = input.indicators?.denied === true;
  const badgedBlocks = new Set(denied ? input.indicators!.blockIds : []);
  const badgedMeetings = new Set(denied ? input.indicators!.meetingIds : []);

  const overlapping = (start: string, end: string): [number, number] | null => {
    const span = spanMs(start, end);
    return span && span[0] < endMs && span[1] > startMs ? span : null;
  };
  const dayKeyOf = (s: number) => torontoDateKey(new Date(Math.max(s, startMs)));

  const blocks: WeekBlockItem[] = [];
  for (const b of input.blocks) {
    const span = overlapping(b.start, b.end);
    if (!span) continue;
    const label = CATEGORY_LABELS[b.category];
    blocks.push({
      kind: "block",
      id: b.id,
      title: b.title,
      start: b.start,
      end: b.end,
      dayKey: dayKeyOf(span[0]),
      timeLabel: formatTimeRange(b.start, b.end),
      label,
      style: categoryStyle(b.category),
      indicator: badgedBlocks.has(b.id),
      category: b.category,
      status: b.status,
      statusLabel: STATUS_LABELS[b.status],
      deepLink: blockDeepLink(b.id),
    });
  }

  const events: WeekEventItem[] = [];
  for (const e of input.cache?.events ?? []) {
    if (isBlockEvent(e)) continue;
    const span = overlapping(e.start, e.end);
    if (!span) continue;
    events.push({
      kind: "calendar",
      id: e.id,
      title: e.summary,
      start: e.start,
      end: e.end,
      dayKey: dayKeyOf(span[0]),
      timeLabel: formatTimeRange(e.start, e.end),
      label: CALENDAR_EVENT_LABEL,
      style: { ...CALENDAR_EVENT_STYLE },
      indicator: badgedMeetings.has(e.id),
      withOthers: e.withOthers,
    });
  }
  blocks.sort(byStartThenId);
  events.sort(byStartThenId);

  const todayKey = torontoDateKey(new Date(input.now));
  const days: WeekDay[] = Array.from({ length: 7 }, (_, i) => {
    const dateKey = addDaysToKey(weekId, i);
    return { dateKey, label: formatDateKey(dateKey), isToday: dateKey === todayKey, items: [] };
  });
  const dayIndex = new Map(days.map((d, i) => [d.dateKey, i]));
  for (const item of [...blocks, ...events].sort(byStartThenId)) {
    days[dayIndex.get(item.dayKey) ?? 0]!.items.push(item);
  }

  const lastSuccessAt = input.syncState.lastSuccessAt;
  return {
    weekId,
    rangeStart: week.sunday,
    rangeEnd: week.saturday,
    rangeLabel: `${days[0]!.label} – ${days[6]!.label}`,
    days,
    blocks,
    events,
    banner: syncBanner(input.syncState),
    lastSynced:
      lastSuccessAt === undefined
        ? null
        : { at: lastSuccessAt, label: `Last synced ${formatTorontoDateTime(lastSuccessAt)}` },
    refreshing: input.refreshing === true,
  };
}
