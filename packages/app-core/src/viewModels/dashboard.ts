/**
 * Dashboard view model (R18, D18). Pure: no I/O, no clock reads.
 *
 * Four widgets for one Sunday-Saturday week, in a fixed order: tasks, sleep,
 * fitness, moved. Each carries one `a11yLabel` so a screen reader reads the
 * card as a single item.
 */
import { torontoDateKey, torontoWeekday } from "@timeblocker/scheduling-engine";
import type { DeviceBlock, SleepScore } from "../models.js";
import type { IntakeItem } from "@timeblocker/flows";
import { buildImportantTasks } from "./importantTasks.js";
import { motivationMessage, progressBucket, type Progress } from "./motivation.js";

export type WidgetId = "tasks" | "sleep" | "fitness" | "moved";

export type WidgetIcon = "check" | "moon" | "run" | "double-arrow";

export interface Widget {
  id: WidgetId;
  label: string;
  value: string;
  caption: string;
  /** Optional smaller line under the caption (sleep sources). Also in `a11yLabel`. */
  sourceLine?: string;
  icon: WidgetIcon;
  /** Great progress (R26.4): tasks >= 75%, fitness >= 75%, sleep >= 8.0 of 10. Never for moved. */
  great: boolean;
  a11yLabel: string;
}

/** One row of the "Important deadlines" block (R27.2). */
export interface ImportantRow {
  id: string;
  title: string;
  /** ISO instant of the deadline. */
  dueAt: string;
  /** "Due today 5:00 PM", "Due Fri 5:00 PM", "Overdue". */
  dueLabel: string;
  urgency: "overdue" | "soon" | "normal";
  target:
    | { kind: "block"; blockId: string; weekId: string }
    | { kind: "summary"; weekId: string; itemId: string };
}

export const GREAT_TASKS_PERCENT = 75;
export const GREAT_FITNESS_PERCENT = 75;
/** On the stored 0-100 scale (8.0 of 10). */
export const GREAT_SLEEP_SCORE = 80;

export interface DashboardView {
  greeting: string;
  /** False when `greeting` is the "Hi there!" fallback (no name known). */
  hasName: boolean;
  message: string;
  progress: Progress;
  /** Always four, in the order tasks, sleep, fitness, moved. */
  widgets: Widget[];
  /** Up to 3 rows plus how many more there are (R27.2). */
  important: { rows: ImportantRow[]; moreCount: number };
}

export interface DashboardInput {
  /** epoch ms */
  now: number;
  weekId: string;
  blocks: readonly DeviceBlock[];
  sleepScores: readonly SleepScore[];
  usageStatus: "granted" | "denied" | "unknown";
  givenName?: string | null;
  /** Blocks of the current and next 3 weeks for the deadline list; defaults to `blocks`. */
  deadlineBlocks?: readonly DeviceBlock[];
  /** Items of the current and next 3 weeks for the deadline list. */
  deadlineItems?: readonly IntakeItem[];
}

const EM_DASH = "—";

function percent(done: number, total: number): number {
  return Math.min(100, Math.max(0, Math.round((100 * done) / total)));
}

const ICONS: Readonly<Record<WidgetId, WidgetIcon>> = {
  tasks: "check",
  sleep: "moon",
  fitness: "run",
  moved: "double-arrow",
};

function widget(
  id: WidgetId,
  label: string,
  value: string,
  caption: string,
  great = false,
  sourceLine?: string,
): Widget {
  const tail = sourceLine ? `. ${sourceLine}` : "";
  return {
    id,
    label,
    value,
    caption,
    ...(sourceLine ? { sourceLine } : {}),
    icon: ICONS[id],
    great,
    a11yLabel: `${label}: ${value}. ${caption}${tail}`,
  };
}

function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
}

/** `Hi <name>!` for a non-blank name (trimmed), otherwise `Hi there!`. */
export function greeting(givenName?: string | null): string {
  const name = givenName?.trim();
  return name ? `Hi ${name}!` : "Hi there!";
}

export function buildDashboard(input: DashboardInput): DashboardView {
  const { now, blocks, sleepScores, usageStatus } = input;
  const counted = blocks.filter((b) => b.status !== "rolled");
  const total = counted.length;
  const done = counted.filter((b) => b.status === "done").length;

  // Tasks completed
  const tasks =
    total === 0
      ? widget("tasks", "Tasks completed", EM_DASH, "No tasks planned yet")
      : widget("tasks", "Tasks completed", `${percent(done, total)}%`, `${done} of ${total} done`, percent(done, total) >= GREAT_TASKS_PERCENT);

  // Sleep score
  let sleep: Widget;
  if (sleepScores.length === 0) {
    sleep = widget(
      "sleep",
      "Sleep score",
      EM_DASH,
      usageStatus === "denied" ? "Allow usage access to see this" : "No nights recorded yet",
    );
  } else {
    const avg = sleepScores.reduce((sum, s) => sum + s.score, 0) / sleepScores.length;
    const n = sleepScores.length;
    const avg100 = Math.min(100, Math.max(0, Math.round(avg)));
    sleep = widget(
      "sleep",
      "Sleep score",
      (avg100 / 10).toFixed(1),
      `Average of ${n} ${plural(n, "night", "nights")}`,
      avg100 >= GREAT_SLEEP_SCORE,
      sleepScores.some((s) => s.source === "health+usage")
        ? "Samsung Health + phone use"
        : "Phone use only",
    );
  }

  // Fitness score
  const fitness = counted.filter((b) => b.category === "fitness");
  const fitnessDone = fitness.filter((b) => b.status === "done").length;
  const fitnessWidget =
    fitness.length === 0
      ? widget("fitness", "Fitness score", EM_DASH, "No fitness tasks this week")
      : widget(
          "fitness",
          "Fitness score",
          `${percent(fitnessDone, fitness.length)}%`,
          `${fitnessDone} of ${fitness.length} fitness ${plural(fitness.length, "task", "tasks")}`,
          percent(fitnessDone, fitness.length) >= GREAT_FITNESS_PERCENT,
        );

  // Moved tasks: a previous slot recorded, or rolled to next week (counted once).
  const moved = blocks.filter((b) => b.movedFrom !== undefined || b.status === "rolled").length;
  const movedWidget = widget(
    "moved",
    "Moved tasks",
    String(moved),
    moved === 1 ? "moved to a new slot" : "moved to new slots",
  );

  // Progress and message
  const endedUnfinished = counted.filter((b) => {
    if (b.status === "missed" || b.status === "skipped") return true;
    if (b.status === "scheduled" || b.status === "in-progress") {
      const end = Date.parse(b.end);
      return Number.isFinite(end) && end < now;
    }
    return false;
  }).length;
  const instant = new Date(now);
  const weekday = torontoWeekday(instant);
  const progress = progressBucket({ total, done, endedUnfinished, weekday });

  return {
    greeting: greeting(input.givenName),
    hasName: Boolean(input.givenName?.trim()),
    message: motivationMessage({ progress, weekday, dateKey: torontoDateKey(instant) }),
    progress,
    widgets: [tasks, sleep, fitnessWidget, movedWidget],
    important: buildImportantTasks({
      now,
      blocks: input.deadlineBlocks ?? blocks,
      items: input.deadlineItems ?? [],
    }),
  };
}
