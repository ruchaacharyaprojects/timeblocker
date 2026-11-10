/**
 * Settings screen tests (R7.2, R11.11, R11.12, R13.10): the planning-mode
 * radio group, Appearance radios, the read-only Holidays row, distraction-app
 * add/remove with validation,
 * permission rows with "Open settings", the "Reminder timing may vary" note,
 * the AppState refresh after returning from Android settings, and sign out.
 * Rendered through the real `RootNavigator` (signed in), opened at
 * `timeblocker://settings`.
 */
import React from 'react';
import { Alert, AppState, type AppStateStatus } from 'react-native';
import { act, fireEvent, render, screen, within } from '@testing-library/react-native';
import { REMINDER_TIMING_MAY_VARY } from '@timeblocker/app-core';
import { RootNavigator } from '../navigation/RootNavigator';
import { PLACEHOLDER_SCREENS } from '../navigation/placeholders';
import { LINKING } from '../navigation/linking';
import { AppServicesProvider } from '../services/AppServices';
import { ThemeProvider } from '../theme';
import { createTestServices, type TestState } from '../services/testServices';
import {
  DEMO_FAILED_MESSAGE,
  DEMO_WARNING,
  HOLIDAYS_FALLBACK,
  INVALID_APP_MESSAGE, OPEN_EXACT_ALARM_LABEL,
  REMOVE_DEMO_CONFIRM_TITLE,
  SLEEP_PRIVACY_HINT,
  SettingsScreen,
} from './SettingsScreen';

jest.mock('react-native-safe-area-context', () => require('react-native-safe-area-context/jest/mock').default);

const linking = { ...LINKING, getInitialURL: () => Promise.resolve('timeblocker://settings') };
const screens = { ...PLACEHOLDER_SCREENS, Settings: SettingsScreen };

async function renderSettings(seed: Partial<TestState> = {}) {
  const services = createTestServices({ authState: { status: 'signed-in' }, ...seed });
  jest.spyOn(services.authState, 'refresh');
  await render(
    <AppServicesProvider services={services}>
      <ThemeProvider>
        <RootNavigator authState={services.authState} screens={screens} linking={linking} />
      </ThemeProvider>
    </AppServicesProvider>,
  );
  await screen.findByTestId('planning-mode');
  return services;
}

/** Simulate the app returning to the foreground (e.g. back from Android settings). */
async function foreground() {
  const listeners = (AppState.addEventListener as jest.Mock).mock.calls
    .filter(([type]) => type === 'change')
    .map(([, listener]) => listener as (state: AppStateStatus) => void);
  await act(async () => {
    listeners.forEach((listener) => listener('active'));
  });
}

const radio = (name: string) => screen.getByRole('radio', { name });

describe('SettingsScreen', () => {
  beforeEach(() => {
    (AppState.addEventListener as jest.Mock).mockClear();
  });

  it('defaults the planning mode to "Spread across days" and switches it (R11.11, R30.1)', async () => {
    const services = await renderSettings();
    // 3 appearance radios + 2 planning radios.
    expect(within(screen.getByTestId('planning-mode')).getAllByRole('radio')).toHaveLength(2);
    expect(radio('Spread across days')).toBeChecked();
    expect(radio('Earliest free time')).not.toBeChecked();

    await fireEvent.press(radio('Earliest free time'));
    expect(services.settings.setPlanningMode).toHaveBeenCalledWith('earliest-fit');
    expect(services.state.settings.planningMode).toBe('earliest-fit');
    expect(services.state.settings.planningModeSetByUser).toBe(true);
    expect(radio('Earliest free time')).toBeChecked();
    expect(radio('Spread across days')).not.toBeChecked();
    const group = within(screen.getByTestId('planning-mode')).getAllByRole('radio');
    expect(group.filter((r) => r.props.accessibilityState?.checked)).toHaveLength(1);
  });

  it('has an Appearance section first with Match phone / Light / Dark radios that apply immediately (R26.2)', async () => {
    const services = await renderSettings();
    const appearance = within(screen.getByTestId('appearance'));
    expect(appearance.getAllByRole('radio').map((r) => r.props.accessibilityLabel)).toEqual([
      'Match phone',
      'Light',
      'Dark',
    ]);
    const headers = screen.getAllByRole('header').map((h) => h.props.children);
    expect(headers[0]).toBe('Appearance');
    expect(appearance.getByRole('radio', { name: 'Match phone' })).toBeChecked();

    await fireEvent.press(appearance.getByRole('radio', { name: 'Dark' }));
    expect(appearance.getByRole('radio', { name: 'Dark' })).toBeChecked();
    expect(appearance.getByRole('radio', { name: 'Match phone' })).not.toBeChecked();
    expect(services.settings.setThemeMode).toHaveBeenCalledWith('dark');
    expect(services.state.settings.themeMode).toBe('dark');
    // The screen itself is now dark.
    expect(screen.getByTestId('screen-Settings')).toHaveStyle({ backgroundColor: '#101814' });

    await fireEvent.press(appearance.getByRole('radio', { name: 'Light' }));
    expect(services.state.settings.themeMode).toBe('light');
    expect(screen.getByTestId('screen-Settings')).toHaveStyle({ backgroundColor: '#D9ECD6' });
  });

  it('shows the stored appearance as selected', async () => {
    await renderSettings({
      settings: { planningMode: 'spread', holidays: [], distractionApps: [], themeMode: 'light' },
    });
    expect(within(screen.getByTestId('appearance')).getByRole('radio', { name: 'Light' })).toBeChecked();
  });

  it('shows a read-only Holidays row with the country and the next holiday (R30.2)', async () => {
    await renderSettings({
      holidaySummary: { country: 'Canada', next: { name: 'Remembrance Day', date: '2025-11-11' } },
    });
    expect(screen.getByTestId('holidays-row')).toHaveTextContent('Holidays: Canada. Next: Remembrance Day, Nov 11.');
  });

  it('shows the country alone when there is no next holiday, (R30.2)', async () => {
    await renderSettings({ holidaySummary: { country: 'Canada' } });
    expect(screen.getByTestId('holidays-row')).toHaveTextContent('Holidays: Canada.');
  });

  it('shows the fallback text when no holiday summary is available', async () => {
    await renderSettings();
    expect(screen.getByTestId('holidays-row')).toHaveTextContent(HOLIDAYS_FALLBACK);
  });

  it('offers no way to add or remove holidays', async () => {
    await renderSettings({ holidaySummary: { country: 'Canada' } });
    expect(screen.queryByLabelText('Holiday date (YYYY-MM-DD)')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Add holiday' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Remove holiday/ })).toBeNull();
  });

  it('adds and removes distraction apps, rejecting a blank package name (R11.11)', async () => {
    const services = await renderSettings({
      settings: { planningMode: 'earliest-fit', holidays: [], distractionApps: ['com.instagram.android'] },
    });
    expect(screen.getByTestId('app-com.instagram.android')).toBeTruthy();

    await fireEvent.changeText(screen.getByLabelText('App package name'), '   ');
    await fireEvent.press(screen.getByRole('button', { name: 'Add app' }));
    expect(screen.getByRole('alert')).toHaveTextContent(INVALID_APP_MESSAGE);

    await fireEvent.changeText(screen.getByLabelText('App package name'), 'com.zhiliaoapp.musically');
    await fireEvent.press(screen.getByRole('button', { name: 'Add app' }));
    expect(services.state.settings.distractionApps).toEqual(['com.instagram.android', 'com.zhiliaoapp.musically']);
    expect(screen.getByTestId('app-com.zhiliaoapp.musically')).toBeTruthy();

    await fireEvent.press(screen.getByRole('button', { name: 'Remove com.instagram.android' }));
    expect(services.settings.removeDistractionApp).toHaveBeenCalledWith('com.instagram.android');
    expect(screen.queryByTestId('app-com.instagram.android')).toBeNull();
  });

  it('shows permission statuses as text with "Open settings" actions for each Android screen (R11.12)', async () => {
    const services = await renderSettings({ usagePermission: 'denied', notificationPermission: 'granted' });
    expect(screen.getByTestId('permission-status-usage-access')).toHaveTextContent('Not granted');
    expect(screen.getByTestId('permission-status-notifications')).toHaveTextContent('Granted');
    expect(screen.getByLabelText('Usage access: Not granted')).toBeTruthy();

    await fireEvent.press(screen.getByRole('button', { name: 'Open settings for Usage access' }));
    expect(services.systemSettings.openUsageAccess).toHaveBeenCalledTimes(1);
    await fireEvent.press(screen.getByRole('button', { name: 'Open settings for Notifications' }));
    expect(services.systemSettings.openNotificationSettings).toHaveBeenCalledTimes(1);
  });

  it('re-reads permission statuses when the app returns to the foreground (R11.12)', async () => {
    const services = await renderSettings({ usagePermission: 'denied', notificationPermission: 'denied' });
    expect(screen.getByTestId('permission-status-usage-access')).toHaveTextContent('Not granted');
    expect(screen.getByTestId('permission-status-notifications')).toHaveTextContent('Not granted');

    // The user grants both in Android settings and comes back.
    services.state.usagePermission = 'granted';
    services.state.notificationPermission = 'granted';
    await foreground();
    expect(screen.getByTestId('permission-status-usage-access')).toHaveTextContent('Granted');
    expect(screen.getByTestId('permission-status-usage-access')).not.toHaveTextContent('Not granted');
    expect(screen.getByTestId('permission-status-notifications')).toHaveTextContent('Granted');
    expect(services.usage.permission.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('shows "Reminder timing may vary" with an exact-alarm settings button while exact alarms are unavailable (R13.10)', async () => {
    const services = await renderSettings({
      permissionState: { notificationsRequested: true, exactAlarmsAvailable: false },
    });
    expect(screen.getByText(REMINDER_TIMING_MAY_VARY)).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: OPEN_EXACT_ALARM_LABEL }));
    expect(services.systemSettings.openExactAlarmSettings).toHaveBeenCalledTimes(1);

    // Exact alarms become available; the note clears on return.
    services.state.permissionState = { ...services.state.permissionState, exactAlarmsAvailable: true };
    await foreground();
    expect(services.notifications.refreshExactAlarmState).toHaveBeenCalled();
    expect(screen.queryByTestId('reminder-timing-note')).toBeNull();
  });

  it('hides the note when exact alarms are available', async () => {
    await renderSettings({ permissionState: { notificationsRequested: true, exactAlarmsAvailable: true } });
    expect(screen.queryByText(REMINDER_TIMING_MAY_VARY)).toBeNull();
    expect(screen.queryByRole('button', { name: OPEN_EXACT_ALARM_LABEL })).toBeNull();
  });

  it('signs out, refreshes the auth state, and returns to SignIn', async () => {
    const services = await renderSettings();
    await fireEvent.press(screen.getByRole('button', { name: 'Sign out' }));
    expect(services.auth.signOut).toHaveBeenCalledTimes(1);
    expect(services.authState.refresh).toHaveBeenCalledTimes(1);
    expect(await screen.findByTestId('screen-SignIn')).toBeTruthy();
    expect(screen.queryByTestId('screen-Settings')).toBeNull();
  });
});

describe('SettingsScreen sleep data', () => {
  beforeEach(() => {
    (AppState.addEventListener as jest.Mock).mockClear();
  });

  it('shows Connected when permission is granted, without a connect button', async () => {
    await renderSettings({ sleepPermission: 'granted' });
    expect(screen.getByText('Samsung Health sleep')).toBeTruthy();
    expect(screen.getByTestId('sleep-data-status')).toHaveTextContent('Connected');
    expect(screen.queryByRole('button', { name: 'Connect Samsung Health sleep' })).toBeNull();
    expect(screen.getByText(SLEEP_PRIVACY_HINT)).toBeTruthy();
  });

  it('shows Not connected with a connect button, then re-reads status after connecting', async () => {
    const services = await renderSettings({ sleepPermission: 'denied' });
    expect(screen.getByTestId('sleep-data-status')).toHaveTextContent('Not connected');
    services.sleepData.connect.mockImplementation(async () => {
      services.state.sleepPermission = 'granted';
      return 'granted';
    });
    await fireEvent.press(screen.getByRole('button', { name: 'Connect Samsung Health sleep' }));
    expect(services.sleepData.connect).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('sleep-data-status')).toHaveTextContent('Connected');
    expect(screen.queryByRole('button', { name: 'Connect Samsung Health sleep' })).toBeNull();
  });

  it('stays Not connected when the user declines', async () => {
    const services = await renderSettings({ sleepPermission: 'denied' });
    await fireEvent.press(screen.getByRole('button', { name: 'Connect Samsung Health sleep' }));
    expect(services.sleepData.status.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(screen.getByTestId('sleep-data-status')).toHaveTextContent('Not connected');
  });

  it('asks to install or update Health Connect when it needs an update', async () => {
    await renderSettings({ sleepAvailability: 'needs-install' });
    expect(screen.getByTestId('sleep-data-status')).toHaveTextContent('Health Connect needs an update');
    expect(screen.getByTestId('sleep-data-hint')).toHaveTextContent(
      'Install or update Health Connect, then reopen this screen',
    );
    expect(screen.queryByRole('button', { name: 'Connect Samsung Health sleep' })).toBeNull();
  });

  it("says Health Connect isn't available when unsupported", async () => {
    await renderSettings({ sleepAvailability: 'unsupported' });
    expect(screen.getByTestId('sleep-data-status')).toHaveTextContent("Health Connect isn't available on this phone");
    expect(screen.queryByRole('button', { name: 'Connect Samsung Health sleep' })).toBeNull();
  });

  it('re-reads the status when the app returns to the foreground', async () => {
    const services = await renderSettings({ sleepAvailability: 'needs-install' });
    services.state.sleepAvailability = 'available';
    services.state.sleepPermission = 'granted';
    await foreground();
    expect(screen.getByTestId('sleep-data-status')).toHaveTextContent('Connected');
  });
});

describe('SettingsScreen demo data', () => {
  type AlertButtons = NonNullable<Parameters<typeof Alert.alert>[2]>;
  const alertSpy = () => jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  const confirmRemove = async (spy: jest.SpyInstance) => {
    const buttons = spy.mock.calls[spy.mock.calls.length - 1]![2] as AlertButtons;
    await act(async () => {
      buttons.find((b) => b.style === 'destructive')!.onPress?.();
    });
  };
  beforeEach(() => {
    (AppState.addEventListener as jest.Mock).mockClear();
  });
  afterEach(() => jest.restoreAllMocks());

  it('is absent in release builds (no demo port)', async () => {
    await renderSettings({ demoEnabled: false });
    expect(screen.queryByTestId('demo-section')).toBeNull();
    expect(screen.queryByText('Demo data')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Load demo data' })).toBeNull();
  });

  it('shows the warning and all controls in debug builds', async () => {
    await renderSettings();
    expect(screen.getByText('Demo data')).toBeTruthy();
    expect(screen.getByText(DEMO_WARNING)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Load demo data' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Remove demo data' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Write demo sleep to Health Connect' })).toBeTruthy();
    expect(screen.getByLabelText('Use demo screen usage')).toBeTruthy();
  });

  it('loads demo data and shows the result', async () => {
    const services = await renderSettings();
    await fireEvent.press(screen.getByRole('button', { name: 'Load demo data' }));
    expect(services.demo!.load).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('demo-result')).toHaveTextContent('Loaded 112 blocks and 14 nights.');
  });

  it('shows a busy state while an action runs and blocks other actions', async () => {
    const services = await renderSettings();
    let finish!: (v: { blocks: number; nights: number; weeks: number }) => void;
    services.demo!.load.mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)));
    await fireEvent.press(screen.getByRole('button', { name: 'Load demo data' }));
    expect(screen.getByRole('button', { name: 'Load demo data' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Write demo sleep to Health Connect' })).toBeDisabled();
    expect(screen.getByText('Loading…')).toBeTruthy();
    await act(async () => finish({ blocks: 1, nights: 2, weeks: 1 }));
    expect(screen.getByTestId('demo-result')).toHaveTextContent('Loaded 1 blocks and 2 nights.');
    expect(screen.getByRole('button', { name: 'Load demo data' })).toBeEnabled();
  });

  it('confirms before removing; Cancel does nothing', async () => {
    const services = await renderSettings();
    const spy = alertSpy();
    await fireEvent.press(screen.getByRole('button', { name: 'Remove demo data' }));
    expect(spy.mock.calls[0]![0]).toBe(REMOVE_DEMO_CONFIRM_TITLE);
    const buttons = spy.mock.calls[0]![2] as AlertButtons;
    expect(buttons.map((b) => [b.text, b.style])).toEqual([
      ['Cancel', 'cancel'],
      ['Remove', 'destructive'],
    ]);
    expect(services.demo!.remove).not.toHaveBeenCalled();
    expect(screen.queryByTestId('demo-result')).toBeNull();
  });

  it('removes demo data after confirming and reports Health Connect sessions', async () => {
    const services = await renderSettings();
    const spy = alertSpy();
    await fireEvent.press(screen.getByRole('button', { name: 'Remove demo data' }));
    await confirmRemove(spy);
    expect(services.demo!.remove).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('demo-result')).toHaveTextContent(
      'Removed 112 blocks and 14 nights. Removed 14 sleep sessions from Health Connect.',
    );
  });

  it('omits the Health Connect part when nothing could be removed there', async () => {
    const services = await renderSettings();
    services.demo!.remove.mockResolvedValueOnce({ blocks: 3, nights: 2, healthRemoved: false });
    const spy = alertSpy();
    await fireEvent.press(screen.getByRole('button', { name: 'Remove demo data' }));
    await confirmRemove(spy);
    expect(screen.getByTestId('demo-result')).toHaveTextContent('Removed 3 blocks and 2 nights.');
    expect(screen.getByTestId('demo-result')).not.toHaveTextContent('Health Connect');
  });

  it('writes demo sleep to Health Connect, or says it is not available', async () => {
    const services = await renderSettings();
    await fireEvent.press(screen.getByRole('button', { name: 'Write demo sleep to Health Connect' }));
    expect(services.demo!.writeHealthSleep).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('demo-result')).toHaveTextContent('Wrote 14 sleep sessions to Health Connect.');

    services.demo!.writeHealthSleep.mockResolvedValueOnce(false);
    await fireEvent.press(screen.getByRole('button', { name: 'Write demo sleep to Health Connect' }));
    expect(screen.getByTestId('demo-result')).toHaveTextContent("Health Connect write isn't available.");
  });

  it('toggles demo screen usage and reflects the stored value', async () => {
    const services = await renderSettings({ demoUsage: true });
    expect(screen.getByLabelText('Use demo screen usage').props.value).toBe(true);
    await fireEvent(screen.getByLabelText('Use demo screen usage'), 'valueChange', false);
    expect(services.demo!.setUsage).toHaveBeenCalledWith(false);
    expect(screen.getByLabelText('Use demo screen usage').props.value).toBe(false);
    expect(screen.getByTestId('demo-result')).toHaveTextContent('Demo screen usage is off.');
  });

  it('shows a friendly error when an action fails', async () => {
    const services = await renderSettings();
    services.demo!.load.mockRejectedValueOnce(new Error('boom'));
    await fireEvent.press(screen.getByRole('button', { name: 'Load demo data' }));
    expect(screen.getByTestId('demo-error')).toHaveTextContent(DEMO_FAILED_MESSAGE);
    expect(screen.queryByTestId('demo-result')).toBeNull();

    services.demo!.setUsage.mockRejectedValueOnce(new Error('boom'));
    await fireEvent(screen.getByLabelText('Use demo screen usage'), 'valueChange', true);
    expect(screen.getByTestId('demo-error')).toHaveTextContent(DEMO_FAILED_MESSAGE);
    expect(screen.getByLabelText('Use demo screen usage').props.value).toBe(false);
  });
});
