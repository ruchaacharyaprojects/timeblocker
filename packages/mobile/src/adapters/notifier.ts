/**
 * `Notifier` over the TimeBlockerAlarms native module (R13, design D7).
 *
 * Scheduling, posting, cancelling and the permission/exact-alarm reports go
 * straight through `NativeModules.TimeBlockerAlarms` (`TimeBlockerAlarmsModule.kt`).
 * The module cannot show the POST_NOTIFICATIONS dialog, so `requestPermission`
 * uses React Native's `PermissionsAndroid` (R13.8).
 *
 * On API 33+ the native report is "undetermined" both before the first ask and
 * after a permanent denial. `permission()` therefore reports "denied" once the
 * injected `wasRequested()` (backed by `permissionState.notificationsRequested`)
 * is true, so the app never shows a second dialog (R13.8, R13.9).
 */
import { NativeModules, PermissionsAndroid, Platform } from 'react-native';
import type {
  NotificationPayload,
  NotificationPermission,
  Notifier,
} from '@timeblocker/app-core';
import {
  getTimeBlockerAlarmsNative,
  type TimeBlockerAlarmsNativeModule,
} from '@timeblocker/reminders';

/** First Android API level with the runtime POST_NOTIFICATIONS permission. */
export const POST_NOTIFICATIONS_API = 33;

/** `NativeModules.TimeBlockerAlarms` when linked, else the package's resolver (which throws). */
export function resolveTimeBlockerAlarmsNative(): TimeBlockerAlarmsNativeModule {
  const linked = (NativeModules as Record<string, unknown>).TimeBlockerAlarms as
    | TimeBlockerAlarmsNativeModule
    | undefined;
  return linked ?? getTimeBlockerAlarmsNative();
}

export interface NativeNotifierOptions {
  /** True once the app has asked for POST_NOTIFICATIONS (`permissionState.notificationsRequested`). */
  wasRequested: () => Promise<boolean>;
  /** Native module resolver; defaults to `NativeModules.TimeBlockerAlarms`. */
  resolve?: () => TimeBlockerAlarmsNativeModule;
  /** Android API level; defaults to `Platform.Version`. */
  apiLevel?: number;
}

export class NativeNotifier implements Notifier {
  private readonly wasRequested: () => Promise<boolean>;
  private readonly resolve: () => TimeBlockerAlarmsNativeModule;
  private readonly apiLevel: number;

  constructor(options: NativeNotifierOptions) {
    this.wasRequested = options.wasRequested;
    this.resolve = options.resolve ?? resolveTimeBlockerAlarmsNative;
    this.apiLevel = options.apiLevel ?? Number(Platform.Version);
  }

  schedule(notification: NotificationPayload, fireAtMs: number, exact: boolean): Promise<void> {
    return this.resolve().schedule(notification, fireAtMs, exact);
  }

  showNow(notification: NotificationPayload): Promise<void> {
    return this.resolve().showNow(notification);
  }

  cancel(id: string): Promise<void> {
    return this.resolve().cancel(id);
  }

  async listPending(): Promise<string[]> {
    const ids: unknown = await this.resolve().listPending();
    return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string') : [];
  }

  async permission(): Promise<NotificationPermission> {
    const status = normalize(await this.resolve().notificationPermission());
    if (status !== 'undetermined') return status;
    if (this.apiLevel < POST_NOTIFICATIONS_API) return 'denied';
    return (await this.wasRequested()) ? 'denied' : 'undetermined';
  }

  /**
   * Shows the system dialog on API 33+ unless already granted. The caller
   * (`NotificationService.ensurePermissionOnce`) decides whether to ask and
   * persists `notificationsRequested` before calling, so this does not
   * consult the flag. Below API 33 there is no dialog; returns the current state.
   */
  async requestPermission(): Promise<NotificationPermission> {
    const current = normalize(await this.resolve().notificationPermission());
    if (current === 'granted') return 'granted';
    if (this.apiLevel < POST_NOTIFICATIONS_API) return 'denied';
    const result = await PermissionsAndroid.request(
      PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS,
    );
    return result === PermissionsAndroid.RESULTS.GRANTED ? 'granted' : 'denied';
  }

  async canScheduleExact(): Promise<boolean> {
    return (await this.resolve().canScheduleExactAlarms()) === true;
  }
}

function normalize(value: unknown): NotificationPermission {
  return value === 'granted' || value === 'undetermined' ? value : 'denied';
}
