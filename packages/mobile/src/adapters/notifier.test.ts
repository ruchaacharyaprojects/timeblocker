import { NativeModules, PermissionsAndroid } from 'react-native';
import type { NotificationPayload } from '@timeblocker/app-core';
import type { TimeBlockerAlarmsNativeModule } from '@timeblocker/reminders';
import { NativeNotifier, resolveTimeBlockerAlarmsNative } from './notifier';

const payload: NotificationPayload = {
  id: 'rem:block:b1@1000',
  kind: 'block-reminder',
  channel: 'reminders',
  title: 'Deep work',
  body: 'Starts at 9:00 AM',
  actions: [{ id: 'im-in', label: "I'm in" }],
  sourceId: 'b1',
  weekId: '2026-W10',
  deepLink: 'timeblocker://block/b1',
};

function mockModule(
  overrides: Partial<TimeBlockerAlarmsNativeModule> = {},
): jest.Mocked<TimeBlockerAlarmsNativeModule> {
  return {
    schedule: jest.fn(async () => {}),
    showNow: jest.fn(async () => {}),
    cancel: jest.fn(async () => {}),
    listPending: jest.fn(async () => ['a', 'b']),
    canScheduleExactAlarms: jest.fn(async () => true),
    notificationPermission: jest.fn(async () => 'granted' as const),
    ...overrides,
  } as jest.Mocked<TimeBlockerAlarmsNativeModule>;
}

let requestSpy: jest.SpyInstance;

beforeEach(() => {
  requestSpy = jest.spyOn(PermissionsAndroid, 'request').mockResolvedValue('granted');
});

afterEach(() => {
  requestSpy.mockRestore();
  delete (NativeModules as Record<string, unknown>).TimeBlockerAlarms;
});

const make = (mod: TimeBlockerAlarmsNativeModule, requested = false, apiLevel = 34) =>
  new NativeNotifier({ resolve: () => mod, wasRequested: async () => requested, apiLevel });

describe('NativeNotifier pass-through', () => {
  it('forwards schedule/showNow/cancel/listPending/canScheduleExact to the module', async () => {
    const mod = mockModule();
    const n = make(mod);
    await n.schedule(payload, 1_000, true);
    await n.showNow(payload);
    await n.cancel('x');
    expect(mod.schedule).toHaveBeenCalledWith(payload, 1_000, true);
    expect(mod.showNow).toHaveBeenCalledWith(payload);
    expect(mod.cancel).toHaveBeenCalledWith('x');
    expect(await n.listPending()).toEqual(['a', 'b']);
    expect(await n.canScheduleExact()).toBe(true);
  });

  it('propagates native rejections', async () => {
    const mod = mockModule({ schedule: jest.fn(async () => Promise.reject(new Error('SCHEDULE_FAILED'))) });
    await expect(make(mod).schedule(payload, 1, false)).rejects.toThrow('SCHEDULE_FAILED');
  });

  it('treats a non-array listPending result as empty', async () => {
    const mod = mockModule({ listPending: jest.fn(async () => null as unknown as string[]) });
    expect(await make(mod).listPending()).toEqual([]);
  });

  it('resolves NativeModules.TimeBlockerAlarms by default', async () => {
    const mod = mockModule();
    (NativeModules as Record<string, unknown>).TimeBlockerAlarms = mod;
    expect(resolveTimeBlockerAlarmsNative()).toBe(mod);
    await new NativeNotifier({ wasRequested: async () => false, apiLevel: 34 }).cancel('y');
    expect(mod.cancel).toHaveBeenCalledWith('y');
  });

  it('throws when the module is not linked', () => {
    expect(() => resolveTimeBlockerAlarmsNative()).toThrow(/TimeBlockerAlarms/);
  });
});

describe('NativeNotifier.permission', () => {
  it('reports granted and denied as-is', async () => {
    expect(await make(mockModule()).permission()).toBe('granted');
    const denied = mockModule({ notificationPermission: jest.fn(async () => 'denied' as const) });
    expect(await make(denied, false).permission()).toBe('denied');
  });

  it('keeps "undetermined" before the first request', async () => {
    const mod = mockModule({ notificationPermission: jest.fn(async () => 'undetermined' as const) });
    expect(await make(mod, false).permission()).toBe('undetermined');
  });

  it('reads "undetermined" as "denied" once notificationsRequested is true', async () => {
    const mod = mockModule({ notificationPermission: jest.fn(async () => 'undetermined' as const) });
    expect(await make(mod, true).permission()).toBe('denied');
  });

  it('maps unknown native values to "denied"', async () => {
    const mod = mockModule({ notificationPermission: jest.fn(async () => 'weird' as never) });
    expect(await make(mod).permission()).toBe('denied');
  });
});

describe('NativeNotifier.requestPermission', () => {
  const undetermined = () =>
    mockModule({ notificationPermission: jest.fn(async () => 'undetermined' as const) });

  it('asks for POST_NOTIFICATIONS via PermissionsAndroid on API 33+', async () => {
    // The flag is already true here: NotificationService sets it before asking.
    expect(await make(undetermined(), true).requestPermission()).toBe('granted');
    expect(requestSpy).toHaveBeenCalledWith(PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS);
  });

  it('maps denied and never_ask_again to "denied"', async () => {
    requestSpy.mockResolvedValueOnce('denied');
    expect(await make(undetermined(), true).requestPermission()).toBe('denied');
    requestSpy.mockResolvedValueOnce('never_ask_again');
    expect(await make(undetermined(), true).requestPermission()).toBe('denied');
  });

  it('does not show a dialog when already granted', async () => {
    expect(await make(mockModule()).requestPermission()).toBe('granted');
    expect(requestSpy).not.toHaveBeenCalled();
  });

  it('does not show a dialog below API 33', async () => {
    const denied = mockModule({ notificationPermission: jest.fn(async () => 'denied' as const) });
    expect(await make(denied, false, 31).requestPermission()).toBe('denied');
    expect(requestSpy).not.toHaveBeenCalled();
  });
});
