/**
 * Test-only in-memory fakes for the injected reminder ports. Not part of the
 * public surface. They let the reminder service be exercised end to end
 * without a push provider.
 */

import type { NotificationPort } from "./notify.js";
import type { ReminderNotification } from "./types.js";

/** Recording notification port; optionally fails for specific ids. */
export class RecordingNotificationPort implements NotificationPort {
  delivered: ReminderNotification[] = [];

  constructor(private readonly failIds: ReadonlySet<string> = new Set()) {}

  async deliver(notification: ReminderNotification): Promise<void> {
    if (this.failIds.has(notification.id)) {
      throw new Error(`delivery failed for ${notification.id}`);
    }
    this.delivered.push(notification);
  }
}
