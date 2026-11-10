/**
 * Notification delivery port and the thin reminder service that drives it.
 *
 * Selection is pure (`select.ts`); the one impure edge — actually pushing a
 * notification to the device — lives behind {@link NotificationPort}, injected
 * so the service stays unit-testable without a push provider. The service
 * selects this tick's reminders (R5.1) and delivers each as an actionable
 * notification (R5.2).
 */

import { selectReminders, type ReminderSources, type SelectOptions } from "./select.js";
import type { ReminderNotification } from "./types.js";

/**
 * Delivers a single already-formed custom notification (push). Production
 * wiring points this at the device push channel that the Android
 * actionable-notification handler renders; tests inject a recording fake.
 */
export interface NotificationPort {
  deliver(notification: ReminderNotification): Promise<void>;
}

/** Outcome of running one reminder tick. */
export interface ReminderRunResult {
  /** Notifications that were selected for this tick. */
  selected: ReminderNotification[];
  /** Ids delivered successfully. */
  delivered: string[];
  /** Per-notification delivery failures (kept non-fatal so one bad push does
   * not block the rest). */
  failures: Array<{ id: string; error: string }>;
}

/**
 * Select this tick's reminders and deliver each through the injected port.
 *
 * Delivery failures are collected rather than thrown so a single failed push
 * does not suppress the remaining reminders on the tick.
 */
export async function runReminderTick(
  sources: ReminderSources,
  port: NotificationPort,
  now: Date,
  options: SelectOptions = {},
): Promise<ReminderRunResult> {
  const selected = selectReminders(sources, now, options);
  const delivered: string[] = [];
  const failures: Array<{ id: string; error: string }> = [];

  for (const notification of selected) {
    try {
      await port.deliver(notification);
      delivered.push(notification.id);
    } catch (err) {
      failures.push({
        id: notification.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { selected, delivered, failures };
}
