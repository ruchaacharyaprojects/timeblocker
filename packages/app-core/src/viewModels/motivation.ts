/**
 * Dashboard motivation message (R18.3, D18). Pure, on-device, no network.
 *
 * The week's progress falls into one of six buckets. Each bucket has seven
 * fixed, warm, plain messages (no emojis, at most one exclamation mark, never
 * shaming). The message is picked by the day, so it stays the same all day and
 * changes from day to day: consecutive days always differ.
 */

export type Progress =
  | "none"
  | "just-started"
  | "going-well"
  | "nearly-done"
  | "all-done"
  | "behind";

export interface ProgressInput {
  /** Blocks of the week, excluding those rolled to next week. */
  total: number;
  /** Blocks with status "done". */
  done: number;
  /** Blocks that ended without being done (missed or skipped, or past their end and not done). */
  endedUnfinished: number;
  /** 0 = Sunday .. 6 = Saturday. Accepted for the caller's convenience; buckets do not depend on it. */
  weekday?: number;
}

/**
 * Bucket the week's progress. Order matters: none, all-done, nearly-done
 * (done/total >= 0.8), behind (endedUnfinished/total >= 0.4), going-well
 * (done/total >= 0.4), otherwise just-started.
 */
export function progressBucket(input: ProgressInput): Progress {
  const { total, done, endedUnfinished } = input;
  if (!(total > 0)) return "none";
  if (done >= total) return "all-done";
  if (done / total >= 0.8) return "nearly-done";
  if (endedUnfinished / total >= 0.4) return "behind";
  if (done / total >= 0.4) return "going-well";
  return "just-started";
}

export const MOTIVATION_MESSAGES: Readonly<Record<Progress, readonly string[]>> = {
  none: [
    "A fresh week is a good place to start. Add your tasks when you are ready.",
    "Nothing planned yet. A short list is enough to begin.",
    "Your week is open. Add a few tasks and let the plan take shape.",
    "Start small. Three tasks on the list is a fine beginning.",
    "A clear calendar gives you room to choose what matters this week.",
    "Whenever you are ready, add this week's tasks and we will find the time.",
    "An empty week is a blank page. Write down what you want to get done.",
  ],
  "just-started": [
    "You have begun, and that is the hardest part.",
    "One block at a time is plenty. The next one is the one to focus on.",
    "The week is young. Steady steps will get you there.",
    "A slow start still counts. Pick the next block and give it your time.",
    "Every finished block makes the next one easier.",
    "You have room to catch your stride. Take the next block when you can.",
    "Small progress adds up. Keep going at your own pace.",
  ],
  "going-well": [
    "You are making steady progress. Keep that rhythm.",
    "Good momentum this week. The next block is waiting.",
    "You are well on your way. Keep going at this pace.",
    "Nice work so far. Your plan is coming together.",
    "Things are moving along well. Stay with it.",
    "You are building a good week, one block at a time.",
    "Solid progress. A little more and you will be close.",
  ],
  "nearly-done": [
    "Almost there. Just a few blocks left.",
    "You are close to the finish. Keep it up.",
    "The end of the list is in sight. Well done so far.",
    "Only a little left to do. You have earned the home stretch.",
    "Great pace this week. A few more blocks and you are done.",
    "You have done most of it. One more push finishes the week.",
    "So close now. Take the next block and keep going.",
  ],
  "all-done": [
    "Everything on your list is done. Enjoy the rest of your week.",
    "All tasks complete. That is worth a proper break.",
    "You finished everything you planned. Well done.",
    "A full list, fully done. Rest well.",
    "Nothing left on the plan this week. Take some time for yourself.",
    "You did what you set out to do. Be proud of that.",
    "Week complete. Use the time left however you like.",
  ],
  behind: [
    "Some blocks slipped, and that is okay. Pick one and begin again.",
    "Plans change. Choose the next block and start from there.",
    "The week is not over. One block now makes a real difference.",
    "A rough patch happens to everyone. Move what you need and carry on.",
    "You can still turn this week around. Start with something small.",
    "Missed blocks can be moved. Choose one that fits today.",
    "It is fine to reset. Take the next block and see how it goes.",
  ],
};

const DAY_MS = 86_400_000;

/** Whole days since 1970-01-01 for a `YYYY-MM-DD` key, or `undefined` if malformed. */
function epochDay(dateKey: string): number | undefined {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateKey);
  if (!m) return undefined;
  return Math.floor(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) / DAY_MS);
}

/**
 * The message for a progress bucket. The index comes from `dateKey` (days
 * since the epoch, so it rotates every day) when given and valid, otherwise
 * from `weekday` (0 = Sunday .. 6 = Saturday).
 */
export function motivationMessage(input: {
  progress: Progress;
  weekday: number;
  dateKey?: string;
}): string {
  const list = MOTIVATION_MESSAGES[input.progress];
  const day = input.dateKey === undefined ? undefined : epochDay(input.dateKey);
  const basis = day ?? (Number.isFinite(input.weekday) ? Math.trunc(input.weekday) : 0);
  const index = ((basis % list.length) + list.length) % list.length;
  return list[index]!;
}
