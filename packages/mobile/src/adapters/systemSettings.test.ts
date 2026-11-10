import { Linking } from 'react-native';
import { ANDROID_SETTINGS, LinkingSystemSettings } from './systemSettings';

let sendIntent: jest.SpyInstance;
let openSettings: jest.SpyInstance;

beforeEach(() => {
  sendIntent = jest.spyOn(Linking, 'sendIntent').mockResolvedValue(undefined);
  openSettings = jest.spyOn(Linking, 'openSettings').mockResolvedValue(undefined);
});
afterEach(() => jest.restoreAllMocks());

describe('LinkingSystemSettings', () => {
  it('opens the Usage Access screen', async () => {
    await new LinkingSystemSettings().openUsageAccess();
    expect(sendIntent).toHaveBeenCalledWith('android.settings.USAGE_ACCESS_SETTINGS', undefined);
  });

  it("opens this app's notification settings", async () => {
    await new LinkingSystemSettings().openNotificationSettings();
    expect(sendIntent).toHaveBeenCalledWith('android.settings.APP_NOTIFICATION_SETTINGS', [
      { key: 'android.provider.extra.APP_PACKAGE', value: 'com.timeblocker.app' },
    ]);
  });

  it('opens the exact-alarm (Alarms & reminders) screen', async () => {
    await new LinkingSystemSettings().openExactAlarmSettings();
    expect(sendIntent).toHaveBeenCalledWith(ANDROID_SETTINGS.exactAlarm, undefined);
    expect(openSettings).not.toHaveBeenCalled();
  });

  it('falls back to the app details screen when the intent cannot be resolved', async () => {
    sendIntent.mockRejectedValueOnce(new Error('No Activity found'));
    await new LinkingSystemSettings().openExactAlarmSettings();
    expect(openSettings).toHaveBeenCalledTimes(1);
  });
});
