/**
 * TypeScript contract for the Android actionable-notification native module
 * (R5.2).
 *
 * The backend selects and delivers custom reminders (R5.1); on the device, the
 * Android native module (see `android/RemindersModule.kt`) renders each push as
 * a notification with the "I'm in" / "Skip" / "Move it" action buttons and
 * emits an event back to JS when the user taps one. This mirrors the
 * usage-metrics native-module pattern: a small injectable surface rather than a
 * hard dependency on React Native's global `NativeModules`, so the RN layer and
 * tests can depend on an interface.
 */

import type {
  ReminderAction,
  ReminderActionId,
  ReminderKind,
} from "./types.js";

/** The payload the native side needs to render an actionable notification. */
export interface NativeReminderNotification {
  id: string;
  kind: ReminderKind;
  sourceId: string;
  title: string;
  body: string;
  actions: readonly ReminderAction[];
}

/** The event emitted to JS when the user taps one of the action buttons. */
export interface ReminderActionEvent {
  notificationId: string;
  kind: ReminderKind;
  sourceId: string;
  actionId: ReminderActionId;
}

/** Unsubscribe handle returned by {@link RemindersNativeModule.addActionListener}. */
export interface ReminderSubscription {
  remove(): void;
}

/**
 * The methods the Android native module exposes to JS. Presenting and
 * cancelling are async because they cross the native bridge; the action
 * listener is a synchronous subscribe that returns an unsubscribe handle.
 */
export interface RemindersNativeModule {
  /** Render an actionable notification with the three buttons (R5.2). */
  presentReminder(notification: NativeReminderNotification): Promise<void>;
  /** Cancel a previously-presented notification by id. */
  cancelReminder(notificationId: string): Promise<void>;
  /** Subscribe to action-button taps ("I'm in" / "Skip" / "Move it"). */
  addActionListener(
    listener: (event: ReminderActionEvent) => void,
  ): ReminderSubscription;
}

let injected: RemindersNativeModule | undefined;

/** Inject a native-module implementation (tests, or a custom host). */
export function setRemindersNative(
  mod: RemindersNativeModule | undefined,
): void {
  injected = mod;
}

/**
 * Get the resolved native module. Prefers an injected implementation, then a
 * React Native `NativeModules.Reminders` if present. Throws otherwise so a
 * missing native module surfaces loudly rather than silently no-opping.
 */
export function getRemindersNative(): RemindersNativeModule {
  if (injected) return injected;

  const rn = tryLoadReactNativeModule();
  if (rn) return rn;

  throw new Error(
    "Reminders native module is unavailable. It is only present on Android " +
      "with the native module linked, or inject one via setRemindersNative() " +
      "for tests.",
  );
}

/**
 * Best-effort lookup of the RN native module without a hard dependency on
 * react-native (not installed in this pure package). Uses the global that
 * React Native populates at runtime.
 */
function tryLoadReactNativeModule(): RemindersNativeModule | undefined {
  const g = globalThis as {
    nativeModuleProxy?: Record<string, unknown>;
  };
  const candidate = g.nativeModuleProxy?.["Reminders"];
  return (candidate as RemindersNativeModule) ?? undefined;
}

// --- TimeBlockerAlarms (on-device local notifications, R13, design D7) --------
//
// Additive contract for `NativeModules.TimeBlockerAlarms`
// (`android/TimeBlockerAlarmsModule.kt`). The Reminders contract above is
// unchanged. These types mirror `NotificationPayload` / `NotificationPermission`
// in `@timeblocker/app-core` structurally (this package cannot depend on
// app-core), so an app-core payload is assignable to `AlarmPayload`.

/** Android notification channels created by TimeBlockerAlarms. */
export type AlarmChannel = "reminders" | "prompts" | "status" | "nudges";

/** One action button; mirrors `AlarmAction` in `AlarmStore.kt`. */
export interface AlarmAction {
  id: string;
  label: string;
}

/** Everything the native side needs to post a notification with no JS at fire time. */
export interface AlarmPayload {
  id: string;
  kind: string;
  channel: AlarmChannel;
  title: string;
  body: string;
  actions: readonly AlarmAction[];
  sourceId: string;
  weekId?: string;
  deepLink?: string;
  timeoutMs?: number;
}

/**
 * Native permission report. On API 33+ "undetermined" covers both "never
 * asked" and "permanently denied"; callers disambiguate with their own
 * "already requested" flag.
 */
export type AlarmNotificationPermission = "granted" | "denied" | "undetermined";

/** The methods `TimeBlockerAlarmsModule.kt` exposes to JS. */
export interface TimeBlockerAlarmsNativeModule {
  /** Persist and arm; exact downgrades to inexact natively when unavailable. Same id replaces. */
  schedule(payload: AlarmPayload, fireAtMs: number, exact: boolean): Promise<void>;
  /** Post immediately. */
  showNow(payload: AlarmPayload): Promise<void>;
  /** Cancel both the alarm and any posted notification for `id`. */
  cancel(id: string): Promise<void>;
  /** Ids of armed alarms that have not fired yet. */
  listPending(): Promise<string[]>;
  /** False on Android 12+ when exact-alarm access is unavailable. */
  canScheduleExactAlarms(): Promise<boolean>;
  notificationPermission(): Promise<AlarmNotificationPermission>;
}

/** Headless JS task key (`NotificationActionTaskService.HEADLESS_TASK_KEY`). */
export const TIMEBLOCKER_ALARMS_HEADLESS_TASK_KEY = "TimeBlockerNotificationAction";

/** Raw data the headless action task receives (strings from an Android Bundle). */
export interface NotificationActionTaskData {
  notificationId: string;
  kind: string;
  sourceId: string;
  weekId?: string;
  actionId: string;
}

let injectedAlarms: TimeBlockerAlarmsNativeModule | undefined;

/** Inject a TimeBlockerAlarms implementation (tests, or a custom host). */
export function setTimeBlockerAlarmsNative(
  mod: TimeBlockerAlarmsNativeModule | undefined,
): void {
  injectedAlarms = mod;
}

/**
 * The injected module, else the RN global `TimeBlockerAlarms`. Throws when
 * neither exists so a missing native module surfaces loudly.
 */
export function getTimeBlockerAlarmsNative(): TimeBlockerAlarmsNativeModule {
  if (injectedAlarms) return injectedAlarms;
  const g = globalThis as { nativeModuleProxy?: Record<string, unknown> };
  const candidate = g.nativeModuleProxy?.["TimeBlockerAlarms"];
  if (candidate) return candidate as TimeBlockerAlarmsNativeModule;
  throw new Error(
    "TimeBlockerAlarms native module is unavailable. It is only present on " +
      "Android with the native module linked, or inject one via " +
      "setTimeBlockerAlarmsNative() for tests.",
  );
}
