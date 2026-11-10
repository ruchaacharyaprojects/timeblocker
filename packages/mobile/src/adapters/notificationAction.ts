/**
 * Parser for the headless notification-action task (R13.4, R13.6, R13.12).
 *
 * `NotificationActionTaskService.kt` runs the JS task registered under
 * `TimeBlockerNotificationAction` with the Bundle
 * `{ notificationId, kind, sourceId, weekId?, actionId }`. This turns that
 * untrusted data into a typed event the composition root (25.x) routes to
 * `BlockActionService`. Unknown actions or action/kind mismatches are
 * rejected rather than guessed.
 */
import { TIMEBLOCKER_ALARMS_HEADLESS_TASK_KEY } from '@timeblocker/reminders';

export const NOTIFICATION_ACTION_TASK_KEY = TIMEBLOCKER_ALARMS_HEADLESS_TASK_KEY;

/**
 * New reminders offer "I'll be there" (`im-in`) and "Move to later this week"
 * (`move-it`) only (R17.4). `skip` stays parseable so the Skip button on a
 * notification armed by an older build still routes to `skip`.
 */
export type ReminderActionId = 'im-in' | 'skip' | 'move-it';
export type PromptAnswerId = 'yes' | 'no';

interface EventBase {
  notificationId: string;
  /** The block id. */
  sourceId: string;
  weekId?: string;
}

/** A routable notification action. */
export type NotificationActionEvent =
  /** "I'll be there" / "Move to later this week" (and a legacy "Skip") on a block reminder. */
  | (EventBase & { type: 'block-reminder'; action: ReminderActionId })
  /** "Yes" / "No" on a miss prompt; `notificationId` is the prompt id. */
  | (EventBase & { type: 'miss-prompt'; answer: PromptAnswerId })
  /** "Undo" on the "Moved to …" status notification. */
  | (EventBase & { type: 'undo' });

export type NotificationActionParseResult =
  | { ok: true; event: NotificationActionEvent }
  | { ok: false; reason: string };

const REMINDER_ACTIONS: readonly string[] = ['im-in', 'skip', 'move-it'];
const PROMPT_ANSWERS: readonly string[] = ['yes', 'no'];

const nonEmpty = (v: unknown): v is string => typeof v === 'string' && v.length > 0;

export function parseNotificationActionTask(data: unknown): NotificationActionParseResult {
  if (typeof data !== 'object' || data === null) {
    return { ok: false, reason: 'task data is not an object' };
  }
  const d = data as Record<string, unknown>;
  for (const field of ['notificationId', 'kind', 'sourceId', 'actionId'] as const) {
    if (!nonEmpty(d[field])) return { ok: false, reason: `missing ${field}` };
  }
  const notificationId = d.notificationId as string;
  const kind = d.kind as string;
  const actionId = d.actionId as string;
  const base: EventBase = { notificationId, sourceId: d.sourceId as string };
  if (nonEmpty(d.weekId)) base.weekId = d.weekId;

  if (kind === 'block-reminder' && REMINDER_ACTIONS.includes(actionId)) {
    return { ok: true, event: { ...base, type: 'block-reminder', action: actionId as ReminderActionId } };
  }
  if (kind === 'miss-prompt' && PROMPT_ANSWERS.includes(actionId)) {
    return { ok: true, event: { ...base, type: 'miss-prompt', answer: actionId as PromptAnswerId } };
  }
  if (kind === 'status' && actionId === 'undo') {
    return { ok: true, event: { ...base, type: 'undo' } };
  }
  return { ok: false, reason: `unsupported action "${actionId}" for kind "${kind}"` };
}
