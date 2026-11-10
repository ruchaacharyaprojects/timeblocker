/**
 * Headless JS tasks registered in `index.js` (task 25.2; R13.4, R14.3).
 *
 * - `TimeBlockerNotificationAction`: `NotificationActionTaskService.kt` runs
 *   it with `{ notificationId, kind, sourceId, weekId?, actionId }` when an
 *   action button is tapped. The handler parses the payload, routes it to
 *   `BlockActionService`, and always resolves (well inside the native 4.5 s
 *   timeout) so the service finishes and dismisses the notification.
 * - Background fetch: the headless handler for a terminated app runs one
 *   `"background"` sync and then `BackgroundFetch.finish(taskId)`.
 *
 * Both handlers take the runtime lazily (`getRuntime()` inside the task), so a
 * headless start without the UI still composes the service graph, and the UI
 * and headless tasks share one runtime per process.
 */
import type { HeadlessEvent } from 'react-native-background-fetch';
import type { AppRuntime } from './bootstrap';
import { createHeadlessSyncTask } from './adapters/backgroundJobs';
import { parseNotificationActionTask, type NotificationActionEvent } from './adapters/notificationAction';

/** The block-action calls a notification tap can make. */
export type HeadlessBlockActions = Pick<AppRuntime['blockActions'], 'imIn' | 'skip' | 'moveIt' | 'answerPrompt' | 'undo'>;

/** What the headless tasks need from the runtime. */
export interface HeadlessRuntime {
  blockActions: HeadlessBlockActions;
  backgroundSync: AppRuntime['backgroundSync'];
}

/** Receives short diagnostics; never payload values beyond kind/action, never tokens. */
export type HeadlessLogger = (message: string) => void;

export interface NotificationActionTaskOptions {
  /** Resolve after this long even if the action is still running. Default {@link NOTIFICATION_ACTION_TIMEOUT_MS}. */
  timeoutMs?: number;
  log?: HeadlessLogger;
}

/** Below the native 4.5 s `TASK_TIMEOUT_MS`, so JS resolves first. */
export const NOTIFICATION_ACTION_TIMEOUT_MS = 4_000;

const defaultLog: HeadlessLogger = message => console.warn(`[TimeBlocker] ${message}`);

/** Error class name only: messages could echo stored data. */
const errorName = (error: unknown): string => (error instanceof Error ? error.name : typeof error);

/** Call the `BlockActionService` method for one parsed notification action. */
export function routeNotificationAction(
  actions: HeadlessBlockActions,
  event: NotificationActionEvent,
): Promise<unknown> {
  const { notificationId } = event;
  switch (event.type) {
    case 'block-reminder': {
      // Reminders always carry weekId; an empty hint makes the service look the block up.
      const ref = { blockId: event.sourceId, weekId: event.weekId ?? '' };
      if (event.action === 'im-in') return actions.imIn(ref, { notificationId });
      if (event.action === 'skip') return actions.skip(ref, { notificationId });
      return actions.moveIt(ref, { notificationId });
    }
    case 'miss-prompt':
      return actions.answerPrompt({
        promptId: notificationId,
        answer: event.answer,
        ...(event.weekId ? { weekId: event.weekId } : {}),
      });
    case 'undo':
      return actions.undo({ blockId: event.sourceId, notificationId });
  }
}

/**
 * The `AppRegistry.registerHeadlessTask` handler. Invalid payloads are ignored;
 * failures and timeouts are logged; the returned promise always resolves.
 */
export function createNotificationActionTask(
  getRuntime: () => Pick<HeadlessRuntime, 'blockActions'>,
  options: NotificationActionTaskOptions = {},
): (data: unknown) => Promise<void> {
  const timeoutMs = options.timeoutMs ?? NOTIFICATION_ACTION_TIMEOUT_MS;
  const log = options.log ?? defaultLog;

  return async data => {
    const parsed = parseNotificationActionTask(data);
    if (!parsed.ok) {
      log(`notification action ignored: ${parsed.reason}`);
      return;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<'timeout'>(resolve => {
      timer = setTimeout(() => resolve('timeout'), timeoutMs);
    });
    try {
      const work = Promise.resolve().then(() => routeNotificationAction(getRuntime().blockActions, parsed.event));
      const outcome = await Promise.race([work.then(() => 'done' as const), timedOut]);
      if (outcome === 'timeout') {
        log(`notification action ${parsed.event.type} did not finish within ${timeoutMs} ms`);
        // Keep a late rejection from surfacing as unhandled.
        work.catch(() => undefined);
      }
    } catch (error) {
      log(`notification action ${parsed.event.type} failed (${errorName(error)})`);
    } finally {
      clearTimeout(timer);
    }
  };
}

/**
 * The `BackgroundFetch.registerHeadlessTask` handler: one `"background"` sync,
 * then `finish(taskId)` (also on failure, timeout, or a runtime that fails to build).
 */
export function createBackgroundSyncTask(
  getRuntime: () => Pick<HeadlessRuntime, 'backgroundSync'>,
): (event: HeadlessEvent) => Promise<void> {
  return createHeadlessSyncTask(() => getRuntime().backgroundSync());
}
