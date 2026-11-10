/**
 * `buildReviewView`: the pure Saturday review model (R9.1-R9.4, R11.10).
 *
 * Renders a flows {@link WeeklyReview} (as persisted in `reviews:<weekId>`):
 * finished, partly finished, and missed blocks; screen time and distraction
 * level; what moved to next week and why; and the prompt to paste or type
 * next week's list. Times are shown in Toronto.
 */
import {
  NEXT_WEEK_LIST_PROMPT,
  type MovedEntry,
  type ReviewEntry,
  type WeeklyReview,
} from "@timeblocker/flows";
import type { Category } from "@timeblocker/scheduling-engine";
import type { DistractionLevel } from "@timeblocker/usage-metrics";
import { CATEGORY_LABELS, categoryHex } from "./colors.js";
import { addDaysToKey, formatDateKey, formatMinutes, formatTimeRange, formatTorontoDate } from "./format.js";

export const DISTRACTION_LEVEL_LABELS: Readonly<Record<DistractionLevel, string>> = {
  low: "Low",
  moderate: "Moderate",
  high: "High",
};

export interface ReviewItem {
  blockId: string;
  title: string;
  category: Category;
  categoryLabel: string;
  /** Category `#RRGGBB`. */
  color: string;
  /** e.g. "Tue, Mar 10 · 2:30 PM – 3:30 PM" (Toronto). */
  whenLabel: string;
}

export interface MovedReviewItem extends ReviewItem {
  reason: string;
}

export type ReviewSectionId = "finished" | "partial" | "missed";

export interface ReviewSection {
  id: ReviewSectionId;
  title: string;
  items: ReviewItem[];
}

export interface ReviewView {
  weekId: string;
  /** e.g. "Sun, Mar 8 – Sat, Mar 14". */
  weekLabel: string;
  /** False when no review was compiled for the week yet. */
  available: boolean;
  /** Finished, Partly finished, Missed, in that order (R9.1). */
  sections: ReviewSection[];
  screenTime: { minutes: number; label: string } | null;
  distractionLevel: { level: DistractionLevel; label: string } | null;
  /** What moved to next week and why (R9.3). */
  moved: MovedReviewItem[];
  fitnessMissedCount: number;
  /** "Paste or type next week's to-do list"; opens intake (R9.4). */
  nextWeekPrompt: string;
}

export const REVIEW_SECTION_TITLES: Readonly<Record<ReviewSectionId, string>> = {
  finished: "Finished",
  partial: "Partly finished",
  missed: "Missed",
};

const byStart = (a: ReviewEntry, b: ReviewEntry) =>
  Date.parse(a.start) - Date.parse(b.start) || (a.blockId < b.blockId ? -1 : a.blockId > b.blockId ? 1 : 0);

function reviewItem(e: ReviewEntry): ReviewItem {
  return {
    blockId: e.blockId,
    title: e.title,
    category: e.category,
    categoryLabel: CATEGORY_LABELS[e.category],
    color: categoryHex(e.category),
    whenLabel: `${formatTorontoDate(e.start)} · ${formatTimeRange(e.start, e.end)}`,
  };
}

const movedItem = (e: MovedEntry): MovedReviewItem => ({ ...reviewItem(e), reason: e.reason });

/**
 * Build the review view for `weekId`. `review` is null when none was compiled
 * yet; the view then has empty sections and still offers the next-week prompt.
 */
export function buildReviewView(weekId: string, review: WeeklyReview | null): ReviewView {
  const weekLabel = `${formatDateKey(weekId)} – ${formatDateKey(addDaysToKey(weekId, 6))}`;
  const section = (id: ReviewSectionId, entries: readonly ReviewEntry[]): ReviewSection => ({
    id,
    title: REVIEW_SECTION_TITLES[id],
    items: [...entries].sort(byStart).map(reviewItem),
  });
  if (!review) {
    return {
      weekId,
      weekLabel,
      available: false,
      sections: [section("finished", []), section("partial", []), section("missed", [])],
      screenTime: null,
      distractionLevel: null,
      moved: [],
      fitnessMissedCount: 0,
      nextWeekPrompt: NEXT_WEEK_LIST_PROMPT,
    };
  }
  return {
    weekId,
    weekLabel,
    available: true,
    sections: [
      section("finished", review.finished),
      section("partial", review.partial),
      section("missed", review.missed),
    ],
    screenTime: { minutes: review.screenTimeMin, label: formatMinutes(review.screenTimeMin) },
    distractionLevel: {
      level: review.distractionLevel,
      label: DISTRACTION_LEVEL_LABELS[review.distractionLevel],
    },
    moved: [...review.movedToNextWeek].sort(byStart).map(movedItem),
    fitnessMissedCount: review.fitnessMissedCount,
    nextWeekPrompt: review.photoPrompt || NEXT_WEEK_LIST_PROMPT,
  };
}
