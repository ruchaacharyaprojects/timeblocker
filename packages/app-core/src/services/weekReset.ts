/**
 * `WeekResetService`: "Clear this week's tasks" (R21.5).
 *
 * Removes the unplaced confirmed items and every `scheduled` block that has
 * not started yet (with its item). Everything else stays as history: done,
 * partial, missed, skipped, in-progress, rolled, and scheduled blocks that
 * already started. A `delete` outbox op is queued for each removed block's
 * calendar event (coalesced, so a pending upsert is replaced and no phantom
 * create runs; the flusher treats 404/410 as success). The draft, a matching
 * undo token and the blocks' open prompts are cleared in the same atomic
 * commit; reminders are reconciled and the outbox flushed afterwards.
 */
import type { Clock } from "../ports.js";
import { coalesceOutbox, type DocWrite, type Repositories } from "../repositories.js";
import type { PlanningFlusher, PlanningNotifications } from "./planning.js";

export interface WeekResetServiceDeps {
  repos: Repositories;
  clock: Clock;
  notifications: PlanningNotifications;
  flusher?: PlanningFlusher;
}

export interface WeekResetResult {
  removedTasks: number;
  keptAsHistory: number;
}

export class WeekResetService {
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private readonly deps: WeekResetServiceDeps) {}

  clear(weekId: string): Promise<WeekResetResult> {
    const run = this.chain.then(() => this.clearOnce(weekId));
    this.chain = run.catch(() => undefined);
    return run;
  }

  private async clearOnce(weekId: string): Promise<WeekResetResult> {
    const { repos, clock, notifications, flusher } = this.deps;
    const now = clock.now();
    const [items, blocks, outbox, undo, prompts] = await Promise.all([
      repos.items.get(weekId),
      repos.blocks.get(weekId),
      repos.outbox.get(),
      repos.undo.get(),
      repos.openPrompts.get(),
    ]);

    const isRemovable = (b: (typeof blocks)[number]) =>
      b.status === "scheduled" && Date.parse(b.start) > now;
    const removedBlocks = blocks.filter(isRemovable);
    const keptBlocks = blocks.filter((b) => !isRemovable(b));

    // Items with any block stay unless all that item's blocks are removed.
    const keptItemIds = new Set(keptBlocks.map((b) => b.itemId));
    const removedItemIds = new Set(
      removedBlocks.map((b) => b.itemId).filter((id) => !keptItemIds.has(id)),
    );
    const blockedItemIds = new Set(blocks.map((b) => b.itemId));
    const unplaced = items.filter((i) => i.confirmed && !blockedItemIds.has(i.id));
    for (const i of unplaced) removedItemIds.add(i.id);

    const removedTasks = unplaced.length + removedBlocks.length;
    if (removedTasks === 0 && keptBlocks.length === 0) {
      return { removedTasks: 0, keptAsHistory: 0 };
    }

    const writes: DocWrite[] = [];
    if (removedBlocks.length > 0) {
      writes.push(repos.blocks.write(weekId, keptBlocks));
      const nextOutbox = removedBlocks.reduce(
        (acc, b) =>
          coalesceOutbox(acc, {
            blockId: b.id,
            calendarEventId: b.calendarEventId,
            op: "delete",
            enqueuedAt: now,
          }),
        outbox,
      );
      writes.push(repos.outbox.write(nextOutbox));
      const removedIds = new Set(removedBlocks.map((b) => b.id));
      if (undo && removedIds.has(undo.blockId)) writes.push(repos.undo.write(null));
      const remainingPrompts = prompts.filter((p) => !removedIds.has(p.blockId));
      if (remainingPrompts.length !== prompts.length) {
        writes.push(repos.openPrompts.write(remainingPrompts));
      }
    }
    if (removedItemIds.size > 0) {
      writes.push(repos.items.write(weekId, items.filter((i) => !removedItemIds.has(i.id))));
    }
    writes.push(repos.intakeDraft.write(null));
    await repos.commit(writes);

    try {
      await notifications.reconcile();
    } catch {
      // The data is already saved; reminders catch up on the next reconcile.
    }
    if (removedBlocks.length > 0) flusher?.flush().catch(() => undefined);
    return { removedTasks, keptAsHistory: keptBlocks.length };
  }
}
