/**
 * `buildWeekGrid`: the pure time-grid model for the week view (R16, design D13).
 *
 * - Positions are minutes from the local (America/Toronto) midnight of the
 *   day column, using the same wall-clock helper as the other view models.
 *   On DST days the wall clock skips or repeats an hour, so a day still spans
 *   0..1440 wall minutes; every value is clamped into that range.
 * - `WeekView` buckets items only by their start day, so this builder splits
 *   multi-day items itself: the first segment keeps the item id and each later
 *   day gets a clipped segment with id `<id>#cont`. Nothing is dropped.
 * - Overlap lanes use greedy interval partitioning on the displayed
 *   (minimum-height-padded) intervals. Touching intervals do not overlap.
 */
import { torontoDateKey, torontoInstant, torontoMinutesOfDay } from "@timeblocker/scheduling-engine";
import type { Category } from "@timeblocker/scheduling-engine";
import type { DeviceBlockStatus } from "../models.js";
import type { ItemStyle } from "./colors.js";
import { addDaysToKey, formatTorontoTime } from "./format.js";
import type { WeekItem, WeekView } from "./weekView.js";

export const GRID_HOUR_COUNT = 24;
/** Smallest displayed height so short items stay tappable. */
export const GRID_MIN_HEIGHT_MIN = 15;
/** Earliest initial scroll position (07:00). */
export const GRID_DEFAULT_SCROLL_MIN = 7 * 60;

export interface GridItem {
  /** Item id; `<id>#cont` for the continuation of an item from the previous day. */
  id: string;
  kind: "block" | "calendar";
  title: string;
  /** Minutes from local midnight, 0..1440. */
  topMin: number;
  /** Displayed height in minutes, at least 15; `topMin + heightMin <= 1440`. */
  heightMin: number;
  /** 0-based lane within its overlap cluster. */
  lane: number;
  /** Number of lanes used by the item's overlap cluster. */
  laneCount: number;
  style: ItemStyle;
  category?: Category;
  status?: DeviceBlockStatus;
  statusLabel?: string;
  indicator?: boolean;
  deepLink?: string;
  timeLabel: string;
  a11yLabel: string;
}

export interface GridDay {
  dateKey: string;
  label: string;
  /** e.g. "Sun" */
  weekday: string;
  dayOfMonth: number;
  isToday: boolean;
  /** Sorted by start time. */
  items: GridItem[];
}

export interface WeekGrid {
  weekId: string;
  hourCount: 24;
  days: GridDay[];
  nowLine?: { dayKey: string; topMin: number };
  initialScrollMin: number;
}

const DAY_MIN = 1440;
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

/** Local midnight (epoch ms) at the start of a `YYYY-MM-DD` Toronto date. */
function localMidnightMs(key: string): number {
  const [y, m, d] = key.split("-").map(Number);
  return torontoInstant(y!, m!, d!, 0, 0).getTime();
}

interface Segment {
  item: WeekItem;
  id: string;
  top: number;
  height: number;
  startMs: number;
  endMs: number;
}

/** Assign lanes and cluster lane counts; `segs` must be sorted already. */
function assignLanes(segs: Segment[]): { lane: number; laneCount: number }[] {
  const out: { lane: number; laneCount: number }[] = new Array(segs.length);
  let laneEnds: number[] = [];
  let clusterStart = 0;
  let clusterEnd = -1;
  const finish = (to: number) => {
    for (let i = clusterStart; i < to; i++) out[i]!.laneCount = laneEnds.length;
  };
  segs.forEach((s, i) => {
    if (i > 0 && s.top >= clusterEnd) {
      finish(i);
      laneEnds = [];
      clusterStart = i;
      clusterEnd = -1;
    }
    let lane = laneEnds.findIndex((end) => end <= s.top);
    if (lane === -1) lane = laneEnds.length;
    laneEnds[lane] = s.top + s.height;
    clusterEnd = Math.max(clusterEnd, s.top + s.height);
    out[i] = { lane, laneCount: 0 };
  });
  finish(segs.length);
  return out;
}

/** Build the time grid for a week view. Pure. */
export function buildWeekGrid(view: WeekView, now: number | Date): WeekGrid {
  const nowDate = typeof now === "number" ? new Date(now) : now;
  const items: WeekItem[] = [...view.blocks, ...view.events];

  const nowKey = torontoDateKey(nowDate);
  const todayKey = view.days.find((d) => d.dateKey === nowKey)?.dateKey ?? null;

  const days: GridDay[] = view.days.map((day, di) => {
    const dayStart = localMidnightMs(day.dateKey);
    const dayEnd = localMidnightMs(addDaysToKey(day.dateKey, 1));
    const [weekday = "", monthDay = ""] = day.label.split(", ");
    const dayOfMonth = Number(day.dateKey.slice(8, 10));

    const segs: Segment[] = [];
    for (const item of items) {
      const s = Date.parse(item.start);
      const e = Date.parse(item.end);
      if (!(s < dayEnd && e > dayStart)) continue;
      // Items before the week start are shown from the first column's midnight.
      const segStart = Math.max(s, dayStart);
      const segEnd = Math.min(e, dayEnd);
      const top0 = segStart <= dayStart ? 0 : torontoMinutesOfDay(new Date(segStart));
      const end0 = segEnd >= dayEnd ? DAY_MIN : torontoMinutesOfDay(new Date(segEnd));
      const height = clamp(Math.max(end0 - top0, GRID_MIN_HEIGHT_MIN), GRID_MIN_HEIGHT_MIN, DAY_MIN);
      const top = clamp(top0, 0, DAY_MIN - height);
      const continued = s < dayStart && di > 0;
      segs.push({
        item,
        id: continued ? `${item.id}#cont` : item.id,
        top,
        height,
        startMs: segStart,
        endMs: segEnd,
      });
    }
    segs.sort(
      (a, b) =>
        a.top - b.top ||
        b.top + b.height - (a.top + a.height) ||
        (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    );
    const lanes = assignLanes(segs);

    const gridItems: GridItem[] = segs.map((seg, i) => {
      const it = seg.item;
      const timeLabel = it.timeLabel;
      const kindLabel = it.kind === "block" ? it.label : "Calendar event";
      const parts = [
        it.title,
        `${weekday} ${monthDay}`,
        `${formatTorontoTime(it.start)} to ${formatTorontoTime(it.end)}`,
        kindLabel,
      ];
      if (it.kind === "block") parts.push(it.statusLabel);
      const base = {
        id: seg.id,
        kind: it.kind,
        title: it.title,
        topMin: seg.top,
        heightMin: seg.height,
        lane: lanes[i]!.lane,
        laneCount: lanes[i]!.laneCount,
        style: it.style,
        indicator: it.indicator,
        timeLabel,
        a11yLabel: parts.join(", "),
      };
      return it.kind === "block"
        ? {
            ...base,
            category: it.category,
            status: it.status,
            statusLabel: it.statusLabel,
            deepLink: it.deepLink,
          }
        : base;
    });

    return {
      dateKey: day.dateKey,
      label: day.label,
      weekday,
      dayOfMonth,
      isToday: day.dateKey === todayKey,
      items: gridItems,
    };
  });

  const nowMin = torontoMinutesOfDay(nowDate);
  const grid: WeekGrid = {
    weekId: view.weekId,
    hourCount: GRID_HOUR_COUNT,
    days,
    initialScrollMin: GRID_DEFAULT_SCROLL_MIN,
  };
  if (todayKey !== null) {
    grid.nowLine = { dayKey: todayKey, topMin: clamp(nowMin, 0, DAY_MIN) };
    grid.initialScrollMin =
      nowMin < GRID_DEFAULT_SCROLL_MIN ? GRID_DEFAULT_SCROLL_MIN : Math.max(0, Math.floor((nowMin - 60) / 60) * 60);
  }
  return grid;
}
