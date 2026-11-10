/**
 * TimeBlocker custom reminders (R5).
 *
 * Fires a custom notification ~15 minutes before each block and before
 * meetings that include other people (R5.1), each carrying the "I'm in" /
 * "Skip" / "Move it" actionable buttons (R5.2).
 *
 * Selection is pure and deterministic (`select.ts`); the one impure edge —
 * delivering a push — is behind the injected {@link NotificationPort}
 * (`notify.ts`). The Android actionable-notification contract lives in
 * `nativeModule.ts` with the Kotlin implementation under `android/`.
 */

export * from "./types.js";
export {
  DEFAULT_LEAD_MINUTES,
  DEFAULT_TICK_MINUTES,
  reminderWindow,
  selectReminders,
  type SelectOptions,
  type ReminderSources,
} from "./select.js";
export {
  runReminderTick,
  type NotificationPort,
  type ReminderRunResult,
} from "./notify.js";
export {
  setRemindersNative,
  getRemindersNative,
  type RemindersNativeModule,
  type NativeReminderNotification,
  type ReminderActionEvent,
  type ReminderSubscription,
  setTimeBlockerAlarmsNative,
  getTimeBlockerAlarmsNative,
  TIMEBLOCKER_ALARMS_HEADLESS_TASK_KEY,
  type TimeBlockerAlarmsNativeModule,
  type AlarmPayload,
  type AlarmAction,
  type AlarmChannel,
  type AlarmNotificationPermission,
  type NotificationActionTaskData,
} from "./nativeModule.js";
