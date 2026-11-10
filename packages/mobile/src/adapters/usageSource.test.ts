import { NativeModules } from 'react-native';
import type { AppUsageRecord, UsageMetricsNativeModule, UsageWindow } from '@timeblocker/usage-metrics';
import { NativeUsageSource, resolveUsageMetricsNative } from './usageSource';

const window: UsageWindow = { startMs: 1_000, endMs: 2_000 };
const records: AppUsageRecord[] = [{ packageName: 'com.instagram.android', foregroundTimeMs: 60_000 }];

function fakeModule(status: 'granted' | 'denied'): jest.Mocked<UsageMetricsNativeModule> {
  return {
    getPermissionStatus: jest.fn(async () => status),
    openUsageAccessSettings: jest.fn(async () => {}),
    queryUsage: jest.fn(async (_w: UsageWindow) => records),
  };
}

afterEach(() => {
  delete (NativeModules as Record<string, unknown>).UsageMetrics;
});

describe('NativeUsageSource', () => {
  it('reports permission from the native module', async () => {
    expect(await new NativeUsageSource(() => fakeModule('granted')).permission()).toBe('granted');
    expect(await new NativeUsageSource(() => fakeModule('denied')).permission()).toBe('denied');
  });

  it('reads usage for the window through queryUsage', async () => {
    const mod = fakeModule('granted');
    expect(await new NativeUsageSource(() => mod).readUsage(window)).toEqual(records);
    expect(mod.queryUsage).toHaveBeenCalledWith(window);
  });

  it('resolves NativeModules.UsageMetrics by default', async () => {
    const mod = fakeModule('granted');
    (NativeModules as Record<string, unknown>).UsageMetrics = mod;
    expect(resolveUsageMetricsNative()).toBe(mod);
    expect(await new NativeUsageSource().permission()).toBe('granted');
  });

  it('rejects clearly when the native module is not linked', async () => {
    await expect(new NativeUsageSource().permission()).rejects.toThrow(/UsageMetrics native module is unavailable/);
  });
});
