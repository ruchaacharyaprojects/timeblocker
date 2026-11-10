/**
 * `SystemSettings` over React Native `Linking` (R11.12, R13.10).
 *
 * Opens Android settings screens with `Linking.sendIntent`. If an intent
 * cannot be resolved on this device, falls back to the app's own details
 * screen (`Linking.openSettings()`), where every permission is reachable.
 */
import { Linking } from 'react-native';
import type { SystemSettings } from '@timeblocker/app-core';
import { APPLICATION_ID } from '../config';

export const ANDROID_SETTINGS = Object.freeze({
  usageAccess: 'android.settings.USAGE_ACCESS_SETTINGS',
  appNotifications: 'android.settings.APP_NOTIFICATION_SETTINGS',
  exactAlarm: 'android.settings.REQUEST_SCHEDULE_EXACT_ALARM',
  extraAppPackage: 'android.provider.extra.APP_PACKAGE',
});

type IntentExtras = Array<{ key: string; value: string | number | boolean }>;

async function openIntent(action: string, extras?: IntentExtras): Promise<void> {
  try {
    await Linking.sendIntent(action, extras);
  } catch {
    await Linking.openSettings();
  }
}

export class LinkingSystemSettings implements SystemSettings {
  constructor(private readonly packageName: string = APPLICATION_ID) {}

  openUsageAccess(): Promise<void> {
    return openIntent(ANDROID_SETTINGS.usageAccess);
  }

  openNotificationSettings(): Promise<void> {
    return openIntent(ANDROID_SETTINGS.appNotifications, [
      { key: ANDROID_SETTINGS.extraAppPackage, value: this.packageName },
    ]);
  }

  openExactAlarmSettings(): Promise<void> {
    // `sendIntent` cannot set a `package:` data URI, so Android shows the
    // "Alarms & reminders" app list; the user picks TimeBlocker there.
    return openIntent(ANDROID_SETTINGS.exactAlarm);
  }
}
