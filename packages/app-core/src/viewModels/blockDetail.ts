/**
 * `buildBlockDetail`: the pure block-detail model (R11.8, R11.9).
 *
 * Title, category (name and color), start, end, and status in Toronto time,
 * with the three actions "I'm in", "Skip", and "Move it". The Undo snackbar is
 * visible only while the block's {@link UndoToken} is live: `now < expiresAt`
 * and the block is still at the moved-to slot.
 */
import type { Category } from "@timeblocker/scheduling-engine";
import type { DeviceBlock, DeviceBlockStatus, OpenPrompt, UndoToken } from "../models.js";
import { isLengthEditable, spanMinutes } from "../services/blockActions.js";
import { CATEGORY_LABELS, categoryHex } from "./colors.js";
import {
  STATUS_LABELS,
  formatTimeRange,
  formatTorontoDate,
  formatTorontoDateTime,
} from "./format.js";

export type BlockActionId = "im-in" | "skip" | "move";

export interface BlockAction {
  id: BlockActionId;
  label: string;
}

/** The three block-detail actions, in display order (R11.8). */
export const BLOCK_DETAIL_ACTIONS: readonly BlockAction[] = [
  { id: "im-in", label: "I'm in" },
  { id: "skip", label: "Skip" },
  { id: "move", label: "Move it" },
];

export interface BlockDetailInput {
  block: DeviceBlock;
  /** epoch ms */
  now: number;
  /** The single active Undo, if any (may belong to another block). */
  undo?: UndoToken | null;
  /** Open "Will you miss this block?" prompts. */
  openPrompts?: readonly OpenPrompt[];
}

export interface BlockDetail {
  id: string;
  title: string;
  category: Category;
  categoryLabel: string;
  /** Category `#RRGGBB`. */
  color: string;
  status: DeviceBlockStatus;
  statusLabel: string;
  start: string;
  end: string;
  /** e.g. "Mon, Mar 9, 2:30 PM" (Toronto). */
  startLabel: string;
  endLabel: string;
  /** e.g. "Mon, Mar 9" (Toronto). */
  dateLabel: string;
  /** e.g. "2:30 PM – 3:30 PM" (Toronto). */
  timeLabel: string;
  actions: readonly BlockAction[];
  /** Present while Undo is available (R11.9). */
  undo: { remainingMs: number; label: "Undo" } | null;
  /** Why it moved, when it did. */
  moveReason?: string;
  /** True while a miss prompt for this block is unanswered. */
  hasOpenPrompt: boolean;
  /** Current length in minutes. */
  durationMin: number;
  /** e.g. "45 min", "1 h", "1 h 30 min". */
  durationLabel: string;
  /** True only for `scheduled` blocks that have not started (R15.9). */
  lengthEditable: boolean;
  /** Why "Change length" is disabled; null when editable. */
  lengthDisabledReason: string | null;
}

/** "45 min", "1 h", "1 h 30 min". */
export function formatDurationMin(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m} min`;
  return m === 0 ? `${h} h` : `${h} h ${m} min`;
}

const sameInstant = (a: string, b: string) => Date.parse(a) === Date.parse(b);

/** Whether `undo` can still restore `block` at `now`. */
export function undoAvailable(block: DeviceBlock, undo: UndoToken | null | undefined, now: number): boolean {
  return (
    !!undo &&
    undo.blockId === block.id &&
    now < undo.expiresAt &&
    sameInstant(block.start, undo.movedTo.start) &&
    sameInstant(block.end, undo.movedTo.end)
  );
}

/** Build the block detail model. Pure. */
export function buildBlockDetail(input: BlockDetailInput): BlockDetail {
  const { block, now, undo } = input;
  const durationMin = spanMinutes(block);
  const lengthEditable = isLengthEditable(block, now);
  const detail: BlockDetail = {
    id: block.id,
    title: block.title,
    category: block.category,
    categoryLabel: CATEGORY_LABELS[block.category],
    color: categoryHex(block.category),
    status: block.status,
    statusLabel: STATUS_LABELS[block.status],
    start: block.start,
    end: block.end,
    startLabel: formatTorontoDateTime(block.start),
    endLabel: formatTorontoDateTime(block.end),
    dateLabel: formatTorontoDate(block.start),
    timeLabel: formatTimeRange(block.start, block.end),
    actions: BLOCK_DETAIL_ACTIONS,
    undo: undoAvailable(block, undo, now) ? { remainingMs: undo!.expiresAt - now, label: "Undo" } : null,
    hasOpenPrompt: (input.openPrompts ?? []).some((p) => p.blockId === block.id),
    durationMin,
    durationLabel: formatDurationMin(durationMin),
    lengthEditable,
    lengthDisabledReason: lengthEditable
      ? null
      : block.status === "scheduled"
        ? "Length can't change after the block has started."
        : "Length can only change for scheduled blocks.",
  };
  if (block.moveReason) detail.moveReason = block.moveReason;
  return detail;
}
