import { NativeModules } from 'react-native';
import {
  HealthConnectSleepSource,
  HealthDemoWriter,
  resolveHealthSleepNative,
  type HealthSleepNativeModule,
} from './healthSleep';

const window = { startMs: 1_000, endMs: 2_000_000 };

function fake(over: Partial<HealthSleepNativeModule> = {}): jest.Mocked<HealthSleepNativeModule> {
  return {
    availability: jest.fn(async () => 'available'),
    permission: jest.fn(async () => 'granted'),
    requestPermission: jest.fn(async () => 'granted'),
    readSessions: jest.fn(async () => []),
    requestDemoWritePermission: jest.fn(async () => 'granted'),
    writeDemoSessions: jest.fn(async (s: unknown[]) => s.length),
    deleteDemoSessions: jest.fn(async () => 2),
    ...over,
  } as jest.Mocked<HealthSleepNativeModule>;
}

afterEach(() => {
  delete (NativeModules as Record<string, unknown>).HealthSleep;
});

describe('HealthConnectSleepSource', () => {
  it('maps availability and falls back to unsupported', async () => {
    for (const v of ['available', 'needs-install'] as const) {
      expect(await new HealthConnectSleepSource(() => fake({ availability: async () => v })).availability()).toBe(v);
    }
    expect(await new HealthConnectSleepSource(() => fake({ availability: async () => 'weird' })).availability()).toBe('unsupported');
    expect(await new HealthConnectSleepSource(() => fake({ availability: async () => { throw new Error('x'); } })).availability()).toBe('unsupported');
  });

  it('maps permission and request outcomes; errors mean denied', async () => {
    const granted = new HealthConnectSleepSource(() => fake());
    expect(await granted.permission()).toBe('granted');
    expect(await granted.requestPermission()).toBe('granted');
    const denied = new HealthConnectSleepSource(() =>
      fake({ permission: async () => 'denied', requestPermission: async () => 'nope' }),
    );
    expect(await denied.permission()).toBe('denied');
    expect(await denied.requestPermission()).toBe('denied');
    const failing = new HealthConnectSleepSource(() =>
      fake({
        permission: async () => { throw new Error('x'); },
        requestPermission: async () => { throw { code: 'REQUEST_IN_PROGRESS' }; },
      }),
    );
    expect(await failing.permission()).toBe('denied');
    expect(await failing.requestPermission()).toBe('denied');
  });

  it('request flow: calls requestPermission once and passes the outcome through', async () => {
    const mod = fake({ permission: async () => 'denied' });
    const src = new HealthConnectSleepSource(() => mod);
    expect(await src.permission()).toBe('denied');
    expect(await src.requestPermission()).toBe('granted');
    expect(mod.requestPermission).toHaveBeenCalledTimes(1);
  });

  it('reads, validates and sorts sessions', async () => {
    const mod = fake({
      readSessions: jest.fn(async () => [
        { startMs: 300, endMs: 900, asleepMin: 8 },
        { startMs: 100, endMs: 200, asleepMin: 1 },
        { startMs: NaN, endMs: 5, asleepMin: 1 },
        { startMs: 1, endMs: 5, asleepMin: '3' },
        { startMs: 10, endMs: 5, asleepMin: 1 },
        { startMs: 1, endMs: 5, asleepMin: -1 },
        null,
        'x',
      ]),
    });
    const out = await new HealthConnectSleepSource(() => mod).readSessions(window);
    expect(out).toEqual([
      { startMs: 100, endMs: 200, asleepMin: 1 },
      { startMs: 300, endMs: 900, asleepMin: 8 },
    ]);
    expect(mod.readSessions).toHaveBeenCalledWith(window);
  });

  it('returns [] for non-arrays and native errors', async () => {
    expect(await new HealthConnectSleepSource(() => fake({ readSessions: async () => ({}) })).readSessions(window)).toEqual([]);
    expect(await new HealthConnectSleepSource(() => fake({ readSessions: async () => { throw new Error('x'); } })).readSessions(window)).toEqual([]);
  });

  it('is unsupported/denied/empty when the module is missing', async () => {
    const src = new HealthConnectSleepSource();
    expect(await src.availability()).toBe('unsupported');
    expect(await src.permission()).toBe('denied');
    expect(await src.requestPermission()).toBe('denied');
    expect(await src.readSessions(window)).toEqual([]);
  });

  it('resolves NativeModules.HealthSleep by default', async () => {
    const mod = fake();
    (NativeModules as Record<string, unknown>).HealthSleep = mod;
    expect(resolveHealthSleepNative()).toBe(mod);
    expect(await new HealthConnectSleepSource().permission()).toBe('granted');
  });
});

describe('HealthDemoWriter', () => {
  const sessions = [{ startMs: 1, endMs: 2, awakeMin: 3 }];

  it('requests write permission then writes', async () => {
    const mod = fake();
    expect(await new HealthDemoWriter(() => mod).writeDemoSessions(sessions)).toBe(1);
    expect(mod.requestDemoWritePermission).toHaveBeenCalled();
    expect(mod.writeDemoSessions).toHaveBeenCalledWith(sessions);
  });

  it('returns false when permission is not granted', async () => {
    const mod = fake({ requestDemoWritePermission: async () => 'denied' });
    expect(await new HealthDemoWriter(() => mod).writeDemoSessions(sessions)).toBe(false);
    expect(mod.writeDemoSessions).not.toHaveBeenCalled();
  });

  it('returns false on DEMO_UNAVAILABLE and PERMISSION_DENIED, rethrows others', async () => {
    const unavailable = fake({
      requestDemoWritePermission: async () => { throw { code: 'DEMO_UNAVAILABLE' }; },
      deleteDemoSessions: async () => { throw { code: 'DEMO_UNAVAILABLE' }; },
    });
    const w = new HealthDemoWriter(() => unavailable);
    expect(await w.writeDemoSessions(sessions)).toBe(false);
    expect(await w.deleteDemoSessions()).toBe(false);
    const denied = fake({ writeDemoSessions: async () => { throw { code: 'PERMISSION_DENIED' }; } });
    expect(await new HealthDemoWriter(() => denied).writeDemoSessions(sessions)).toBe(false);
    const broken = fake({ deleteDemoSessions: async () => { throw new Error('boom'); } });
    await expect(new HealthDemoWriter(() => broken).deleteDemoSessions()).rejects.toThrow('boom');
  });

  it('deletes demo sessions and tolerates a missing module', async () => {
    expect(await new HealthDemoWriter(() => fake()).deleteDemoSessions()).toBe(2);
    const none = new HealthDemoWriter();
    expect(await none.writeDemoSessions(sessions)).toBe(false);
    expect(await none.deleteDemoSessions()).toBe(false);
  });
});
