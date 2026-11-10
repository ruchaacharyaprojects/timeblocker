/**
 * "Important deadlines" rows for the dashboard (R27.2, R27.3, D23). Pure.
 *
 * Candidates are scheduled / in-progress / missed blocks that carry a `dueAt`,
 * plus confirmed items with a `dueAt` that have no block (they did not fit).
 * Only deadlines in [now - 30 days, now + 21 days] show; the three soonest
 * (overdue first) become rows and the rest are counted in `moreCount`.
 */
import type { IntakeItem } from "@timeblocker/flows";
import { torontoDateKey } from "@timeblocker/scheduling-engine";
import type { DeviceBlock, DeviceBlockStatus } from "../models.js";
import { addDaysToKey, formatTorontoDate, formatTorontoTime } from "./format.js";
import type { ImportantRow } from "./dashboard.js";

export const IMPORTANT_MAX_ROWS = 3;
export const IMPORTANT_LOOKBACK_MS = 30 * 86_400_000;
export const IMPORTANT_LOOKAHEAD_MS = 21 * 86_400_000;
const SOON_MS = 24 * 3_600_000;

/** Statuses whose deadline is still open. */
const OPEN_STATUSES: readonly DeviceBlockStatus[] = ["scheduled", "in-progress", "missed"];

export interface ImportantTasksInput {
  /** epoch ms */
  now: number;
  blocks: readonly DeviceBlock[];
  items: readonly IntakeItem[];
}

/** "Overdue", "Due today 5:00 PM", "Due tomorrow 5:00 PM", "Due Fri 5:00 PM", "Due Nov 20, 5:00 PM". */
export function dueLabel(dueMs: number, now: number): string {
  if (dueMs <= now) return "Overdue";
  const time = formatTorontoTime(dueMs);
  const dueKey = torontoDateKey(new Date(dueMs));
  const todayKey = torontoDateKey(new Date(now));
  if (dueKey === todayKey) return `Due today ${time}`;
  if (dueKey === addDaysToKey(todayKey, 1)) return `Due tomorrow ${time}`;
  // Within the next 6 calendar days a weekday is unambiguous.
  for (let d = 2; d <= 6; d++) {
    if (dueKey === addDaysToKey(todayKey, d)) {
      return `Due ${formatTorontoDate(dueMs).split(",")[0]} ${time}`;
    }
  }
  // "Mon, Nov 20" -> "Nov 20"
  const monthDay = formatTorontoDate(dueMs).split(", ").slice(1).join(", ");
  return `Due ${monthDay}, ${time}`;
}

export function buildImportantTasks(input: ImportantTasksInput): {
  rows: ImportantRow[];
  moreCount: number;
} {
  const { now, blocks, items } = input;
  const inWindow = (dueMs: number) =>
    Number.isFinite(dueMs) && dueMs >= now - IMPORTANT_LOOKBACK_MS && dueMs <= now + IMPORTANT_LOOKAHEAD_MS;

  const all: Array<{ dueMs: number; row: ImportantRow }> = [];
  const make = (
    id: string,
    title: string,
    dueAt: string,
    dueMs: number,
    target: ImportantRow["target"],
  ): { dueMs: number; row: ImportantRow } => ({
    dueMs,
    row: {
      id,
      title,
      dueAt,
      dueLabel: dueLabel(dueMs, now),
      urgency: dueMs <= now ? "overdue" : dueMs - now <= SOON_MS ? "soon" : "normal",
      target,
    },
  });

  const blockedItems = new Set<string>();
  for (const b of blocks) {
    blockedItems.add(b.itemId);
    if (b.dueAt === undefined || !OPEN_STATUSES.includes(b.status)) continue;
    const dueMs = Date.parse(b.dueAt);
    if (!inWindow(dueMs)) continue;
    all.push(make(b.id, b.title, b.dueAt, dueMs, { kind: "block", blockId: b.id, weekId: b.weekId }));
  }
  const seen = new Set<string>();
  for (const i of items) {
    if (!i.confirmed || i.dueAt === undefined || blockedItems.has(i.id) || seen.has(i.id)) continue;
    seen.add(i.id);
    const dueMs = Date.parse(i.dueAt);
    if (!inWindow(dueMs)) continue;
    all.push(make(i.id, i.text, i.dueAt, dueMs, { kind: "summary", weekId: i.weekId, itemId: i.id }));
  }

  all.sort((a, b) => a.dueMs - b.dueMs || (a.row.id < b.row.id ? -1 : a.row.id > b.row.id ? 1 : 0));
  return {
    rows: all.slice(0, IMPORTANT_MAX_ROWS).map((e) => e.row),
    moreCount: Math.max(0, all.length - IMPORTANT_MAX_ROWS),
  };
}
