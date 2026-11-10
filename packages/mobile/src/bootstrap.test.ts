/**
 * Composition root tests (R12.6, R14.1): bootstrap builds the whole graph
 * with every native module mocked, the runtime is memoized per process, and
 * the cross-service wiring (background job → sync, session end → SignIn,
 * notifier permission flag, planning's foreground sync) is in place.
 */
import { NativeModules } from 'react-native';
import BackgroundFetch from 'react-native-background-fetch';
import {
  DEFAULT_PERMISSION_STATE,
  shiftWeekId,
  weekIdAt,
  type AuthState,
  type DeviceBlock,
  type DeviceBlockStatus,
} from '@timeblocker/app-core';
import {
  FakeHttpTransport,
  FakeNotifier,
  FakeTokenVault,
  FakeUsageSource,
  FakeSleepSource,
  MemoryKeyValueStore,
  ScriptableAuthClient,
  FakeClock,
  FakeBackgroundJobs,
  makeGrant,
  makeTokens,
} from '@timeblocker/app-core/dist/testkit';
import type { NativeNotifierOptions } from './adapters';
import { RandomIdGenerator, createRuntimeId } from './adapters/ids';
import type { SyncHandler } from './adapters/backgroundJobs';
import { AI_HOST_SUFFIX } from './config';
import { createAppRuntime, getAppRuntime, resetAppRuntimeForTests, type AppRuntimeDeps } from './bootstrap';

jest.mock('@react-native-async-storage/async-storage', () => require('@react-native-async-storage/async-storage/jest'));
jest.mock('react-native-keychain', () => ({
  __esModule: true,
  STORAGE_TYPE: { AES_GCM_NO_AUTH: 'KeystoreAESGCM_NoAuth' },
  setGenericPassword: jest.fn(async () => ({ service: 'x', storage: 'KeystoreAESGCM_NoAuth' })),
  getGenericPassword: jest.fn(async () => false),
  resetGenericPassword: jest.fn(async () => true),
}));
jest.mock('react-native-background-fetch', () => ({
  __esModule: true,
  default: {
    STATUS_AVAILABLE: 2,
    configure: jest.fn(async () => 2),
    stop: jest.fn(async () => true),
    finish: jest.fn(),
  },
}));
jest.mock('react-native-app-auth', () => ({
  __esModule: true,
  authorize: jest.fn(),
  refresh: jest.fn(),
  revoke: jest.fn(),
}));

const NOW = Date.UTC(2025, 0, 8, 15, 0, 0);

/** Native modules the notifier and usage source resolve lazily. */
function mockNatives() {
  const alarms = {
    schedule: jest.fn(async () => {}),
    showNow: jest.fn(async () => {}),
    cancel: jest.fn(async () => {}),
    listPending: jest.fn(async () => []),
    canScheduleExactAlarms: jest.fn(async () => true),
    notificationPermission: jest.fn(async () => 'granted'),
  };
  const usage = {
    getPermissionStatus: jest.fn(async () => 'denied'),
    queryUsage: jest.fn(async () => []),
  };
  const modules = NativeModules as Record<string, unknown>;
  modules.TimeBlockerAlarms = alarms;
  modules.UsageMetrics = usage;
  return { alarms, usage };
}

/** The real service graph over app-core's in-memory fakes. */
function fakeDeps(overrides: Partial<AppRuntimeDeps> = {}) {
  const kv = new MemoryKeyValueStore();
  const jobs = new FakeBackgroundJobs();
  const notifier = new FakeNotifier();
  let onSync: SyncHandler | undefined;
  let notifierOptions: NativeNotifierOptions | undefined;
  const deps: AppRuntimeDeps = {
    kv,
    vault: new FakeTokenVault(),
    authClient: new ScriptableAuthClient(),
    transport: new FakeHttpTransport(),
    jobs: (handler) => {
      onSync = handler;
      return jobs;
    },
    notifier: (options) => {
      notifierOptions = options;
      return notifier;
    },
    usage: new FakeUsageSource(),
    systemSettings: { openUsageAccess: jest.fn(), openNotificationSettings: jest.fn(), openExactAlarmSettings: jest.fn() },
    clock: new FakeClock(NOW),
    runtimeId: 'rt-test',
    apiLevel: 34,
    ...overrides,
  };
  return { deps, kv, jobs, notifier, onSync: () => onSync, notifierOptions: () => notifierOptions };
}

afterEach(() => {
  resetAppRuntimeForTests();
  jest.clearAllMocks();
});

describe('createAppRuntime with every native module mocked', () => {
  it('constructs all adapters and services and exposes the screen services', async () => {
    mockNatives();
    const runtime = createAppRuntime();
    const keys: Array<keyof typeof runtime.services> = [
      'auth', 'authState', 'intake', 'planning', 'weekReset', 'sync', 'notifications', 'blockActions',
      'review', 'dashboard', 'settings', 'holidays', 'repos', 'systemSettings', 'usage', 'notificationPermission', 'clock',
    ];
    for (const key of keys) expect(runtime.services[key]).toBeDefined();
    // No holidays cached yet.
    await expect(runtime.services.holidays.summary()).resolves.toBeNull();
    // Screens get the real instances unchanged.
    expect(runtime.services.sync).toBe(runtime.sync);
    expect(runtime.services.blockActions).toBe(runtime.blockActions);
    expect(runtime.services.notificationPermission).toBe(runtime.notifier);
    expect(runtime.runtimeId).toMatch(/^rt-/);

    // Fresh install over the mocked AsyncStorage: signed out, defaults readable.
    expect(await runtime.services.authState.current()).toEqual({ status: 'signed-out' });
    expect(await runtime.repos.permissionState.get()).toEqual(DEFAULT_PERMISSION_STATE);
    expect(await runtime.services.usage.permission()).toBe('denied');
    expect(await runtime.services.notificationPermission.permission()).toBe('granted');
  });

  it('onLaunch while signed out stops the background job and does not sync', async () => {
    mockNatives();
    const runtime = createAppRuntime();
    const sync = jest.spyOn(runtime.sync, 'sync');
    const result = await runtime.lifecycle.onLaunch();
    expect(result.signedIn).toBe(false);
    expect(BackgroundFetch.stop).toHaveBeenCalled();
    expect(sync).not.toHaveBeenCalled();
  });

  it('getAppRuntime memoizes one instance per process', () => {
    mockNatives();
    const first = getAppRuntime();
    expect(getAppRuntime()).toBe(first);
    resetAppRuntimeForTests();
    expect(getAppRuntime()).not.toBe(first);
  });
});

describe('composition wiring', () => {
  it('runs a "background" sync from the background job handler', async () => {
    const f = fakeDeps();
    const runtime = createAppRuntime(f.deps);
    expect(f.onSync()).toBe(runtime.backgroundSync);
    const sync = jest.spyOn(runtime.sync, 'sync');
    await runtime.backgroundSync().catch(() => undefined);
    expect(sync).toHaveBeenCalledWith('background');
  });

  it('reads notificationsRequested for the notifier and passes the API level', async () => {
    const f = fakeDeps();
    const runtime = createAppRuntime(f.deps);
    const options = f.notifierOptions();
    expect(options?.apiLevel).toBe(34);
    expect(await options?.wasRequested()).toBe(false);
    await runtime.repos.permissionState.save({ ...DEFAULT_PERMISSION_STATE, notificationsRequested: true });
    expect(await options?.wasRequested()).toBe(true);
  });

  it('a session end during a sync marks it ended, stops background sync, and notifies the navigator', async () => {
    const f = fakeDeps();
    const runtime = createAppRuntime(f.deps);
    // Signed in, but the vault is empty: the calendar read throws SessionEnded("missing").
    await runtime.repos.authState.save({ status: 'signed-in' });
    const seen: AuthState[] = [];
    runtime.services.authState.subscribe((s) => seen.push(s));

    const result = await runtime.lifecycle.onLaunch();

    expect(result.sync).toEqual({ status: 'session-ended', reason: 'missing' });
    expect(await runtime.services.auth.state()).toEqual({ status: 'session-ended', reason: 'missing' });
    expect(seen).toContainEqual({ status: 'session-ended', reason: 'missing' });
    expect(f.jobs.running).toBe(false);
  });

  it('a network failure refreshing the token on launch keeps the user signed in', async () => {
    const vault = new FakeTokenVault(makeTokens({ expiryDate: 0 }));
    const authClient = new ScriptableAuthClient();
    authClient.nextRefresh({ kind: 'transport-error', message: 'offline' });
    const f = fakeDeps({ vault, authClient });
    const runtime = createAppRuntime(f.deps);
    await runtime.repos.authState.save({ status: 'signed-in' });
    const result = await runtime.lifecycle.onLaunch();
    await runtime.services.authState.refresh();
    expect(result.sync?.status).not.toBe('session-ended');
    expect(await runtime.services.auth.state()).toEqual({ status: 'signed-in' });
    expect(vault.current).not.toBeNull();
    expect(f.jobs.running).toBe(true);
  });
  it('launch restores a legacy transport-ended session when tokens remain', async () => {
    const vault = new FakeTokenVault(makeTokens({ expiryDate: 0 }));
    const authClient = new ScriptableAuthClient();
    authClient.nextRefresh({ kind: 'transport-error', message: 'offline' });
    const f = fakeDeps({ vault, authClient });
    const runtime = createAppRuntime(f.deps);
    await runtime.repos.authState.save({ status: 'session-ended', reason: 'transport' });
    await runtime.lifecycle.onLaunch();
    const state = await runtime.services.authState.refresh();
    expect(state).toEqual({ status: 'signed-in' });
    expect(f.jobs.running).toBe(true);
  });
  it('planning runs a foreground sync first through SyncService', async () => {
    const f = fakeDeps();
    const runtime = createAppRuntime(f.deps);
    const sync = jest.spyOn(runtime.sync, 'sync');
    await runtime.services.planning.plan(weekIdAt(NOW));
    expect(sync).toHaveBeenCalledWith('foreground');
  });

  it('planning.rollToNextWeek and dropUnplaced work over the in-memory fakes', async () => {
    const f = fakeDeps();
    const runtime = createAppRuntime(f.deps);
    const weekId = weekIdAt(NOW);
    const mk = (id: string) => ({ id, text: id, durationMin: 60, priority: 2, category: 'work' as const, confirmed: true, weekId });
    await runtime.repos.items.save(weekId, [mk('a'), mk('b')]);
    const dropped = await runtime.services.planning.dropUnplaced(weekId, ['b']);
    expect(dropped).toEqual({ removed: 1 });
    const result = await runtime.services.planning.rollToNextWeek(weekId, ['a']);
    expect(result.weekId).not.toBe(weekId);
    expect((await runtime.repos.items.get(weekId)).length).toBe(0);
    expect((await runtime.repos.items.get(result.weekId)).map((i) => i.id)).toEqual(['a']);
  });
  it('weekReset.clear removes unplaced tasks and reports counts', async () => {
    const f = fakeDeps();
    const runtime = createAppRuntime(f.deps);
    const weekId = weekIdAt(NOW);
    await runtime.repos.items.save(weekId, [
      { id: 'a', text: 'a', durationMin: 60, priority: 2, category: 'work', confirmed: true, weekId },
    ]);
    expect(await runtime.services.weekReset.clear(weekId)).toEqual({ removedTasks: 1, keptAsHistory: 0 });
    expect(await runtime.repos.items.get(weekId)).toEqual([]);
  });
  it('intake.submit validates with history, plans, and puts a forecast line in the reminder', async () => {
    const f = fakeDeps();
    const runtime = createAppRuntime(f.deps);
    const weekId = weekIdAt(NOW);
    const prevWeek = shiftWeekId(weekId, 1);
    const past = (id: string, status: DeviceBlockStatus, day: number): DeviceBlock => ({
      id,
      itemId: `i-${id}`,
      title: 'Write report',
      start: new Date(Date.UTC(2025, 0, day, 15, 0)).toISOString(),
      end: new Date(Date.UTC(2025, 0, day, 16, 15)).toISOString(),
      category: 'work',
      status,
      weekId: prevWeek,
      calendarEventId: `tb${id}`,
      calendarSynced: true,
      promptedMeetingIds: [],
      usagePrompted: false,
      updatedAt: 0,
    });
    await runtime.repos.blocks.save(prevWeek, [
      past('p1', 'done', 1),
      past('p2', 'missed', 2),
      past('p3', 'missed', 3),
      past('p4', 'skipped', 4),
    ]);

    const result = await runtime.services.intake.submit('Write report', weekId);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Median of the past (non-skipped) 75-minute blocks.
    expect(result.confirmed[0]).toMatchObject({ text: 'Write report', durationMin: 75, category: 'work' });
    expect(result.plan.placed.length).toBe(1);
    expect((await runtime.repos.blocks.get(weekId)).length).toBe(1);

    const bodies = [...f.notifier.pending.values()].map((p) => p.notification.body);
    expect(bodies.some((b) => b.includes('May not happen: You finished 1 of 4 similar blocks'))).toBe(true);
  });

  it('intake.submit rejects invalid input without planning', async () => {
    const runtime = createAppRuntime(fakeDeps().deps);
    expect(await runtime.services.intake.submit('', weekIdAt(NOW))).toEqual({
      ok: false,
      error: 'rejected',
      reason: 'empty',
    });
  });

  it('gives each runtime its own id by default', () => {
    const a = createAppRuntime(fakeDeps({ runtimeId: undefined }).deps);
    const b = createAppRuntime(fakeDeps({ runtimeId: undefined }).deps);
    expect(a.runtimeId).not.toBe(b.runtimeId);
  });
});

describe('sleep scoring wiring (R19.1)', () => {
  it('scores recent nights after launch, after foreground, and after a background sync', async () => {
    const f = fakeDeps();
    const runtime = createAppRuntime(f.deps);
    const record = jest.spyOn(runtime.sleep, 'recordRecentNights');
    const sync = jest.spyOn(runtime.sync, 'sync');

    await runtime.lifecycle.onLaunch();
    expect(record).toHaveBeenCalledTimes(1);

    await runtime.lifecycle.onForeground();
    expect(record).toHaveBeenCalledTimes(2);

    await runtime.backgroundSync().catch(() => undefined);
    expect(sync).toHaveBeenCalledWith('background');
    expect(record).toHaveBeenCalledTimes(3);
  });

  it('runs after the main lifecycle work and returns its result', async () => {
    const f = fakeDeps();
    const runtime = createAppRuntime(f.deps);
    const order: string[] = [];
    jest.spyOn(runtime.sleep, 'recordRecentNights').mockImplementation(async () => {
      order.push('sleep');
      return { recorded: [], skipped: undefined };
    });
    jest.spyOn(runtime.sync, 'sync').mockImplementation(async () => {
      order.push('sync');
      return { status: 'ok' } as never;
    });
    const result = await runtime.lifecycle.onLaunch();
    expect(result.signedIn).toBe(false);
    await runtime.backgroundSync();
    expect(order).toEqual(['sleep', 'sync', 'sleep']);
  });

  it('swallows sleep failures so the lifecycle and background sync still succeed', async () => {
    const f = fakeDeps();
    const runtime = createAppRuntime(f.deps);
    jest.spyOn(runtime.sleep, 'recordRecentNights').mockRejectedValue(new Error('boom'));
    jest.spyOn(runtime.sync, 'sync').mockResolvedValue({ status: 'ok' } as never);
    await expect(runtime.lifecycle.onLaunch()).resolves.toBeDefined();
    await expect(runtime.lifecycle.onForeground()).resolves.toBeDefined();
    await expect(runtime.backgroundSync()).resolves.toBeUndefined();
  });

  it('still scores when the background sync fails, and surfaces the sync error', async () => {
    const f = fakeDeps();
    const runtime = createAppRuntime(f.deps);
    const record = jest.spyOn(runtime.sleep, 'recordRecentNights');
    jest.spyOn(runtime.sync, 'sync').mockRejectedValue(new Error('sync down'));
    await expect(runtime.backgroundSync()).rejects.toThrow('sync down');
    expect(record).toHaveBeenCalledTimes(1);
  });

  it('stores a score for an ended night when usage access is granted', async () => {
    const usage = new FakeUsageSource([{ packageName: 'com.x', foregroundTimeMs: 20 * 60_000 }]);
    const f = fakeDeps({ usage });
    const runtime = createAppRuntime(f.deps);
    await runtime.lifecycle.onLaunch();
    const scores = await runtime.repos.sleepScores.get();
    expect(Object.keys(scores)).toHaveLength(3);
    expect(Object.values(scores)[0]).toMatchObject({ usageMin: 20, score: 70 });
  });
});

describe('dashboard port (R18)', () => {
  const WEEK = weekIdAt(NOW);
  const block = (id: string, status: DeviceBlockStatus, category: DeviceBlock['category'] = 'work'): DeviceBlock => ({
    id,
    itemId: `i-${id}`,
    title: id,
    start: '2025-01-08T15:00:00-05:00',
    end: '2025-01-08T16:00:00-05:00',
    category,
    status,
    weekId: WEEK,
    calendarEventId: `ev-${id}`,
    calendarSynced: false,
    promptedMeetingIds: [],
    usagePrompted: false,
    updatedAt: NOW,
  });

  it('builds the view from seeded repositories', async () => {
    const f = fakeDeps({ usage: new FakeUsageSource([]) });
    const runtime = createAppRuntime(f.deps);
    await runtime.repos.blocks.save(WEEK, [block('a', 'done', 'fitness'), block('b', 'scheduled')]);
    await runtime.repos.profile.save({ givenName: 'Sam', updatedAt: NOW });
    await runtime.repos.sleepScores.save({
      '2025-01-07': { score: 80, usageMin: 10, dateKey: '2025-01-07', scoredAt: NOW, source: 'usage' },
    });
    const view = await runtime.services.dashboard.load();
    expect(view.greeting).toBe('Hi Sam!');
    expect(view.widgets.map((w) => w.id)).toEqual(['tasks', 'sleep', 'fitness', 'moved']);
    expect(view.widgets[0]).toMatchObject({ value: '50%', caption: '1 of 2 done' });
    expect(view.widgets[2]).toMatchObject({ value: '100%' });
    expect(view.widgets[1]!.value).toBe('8.0');
    expect(view.widgets[1]!.great).toBe(true);
    expect(view.important).toEqual({ rows: [], moreCount: 0 });
  });

  it('reads four weeks and lists deadline rows for an unplaced item and a deadline block', async () => {
    const f = fakeDeps({ usage: new FakeUsageSource([]) });
    const runtime = createAppRuntime(f.deps);
    const nowMs = NOW;
    const week3 = shiftWeekId(WEEK, -3);
    const week4 = shiftWeekId(WEEK, -4);
    const dueSoon = new Date(nowMs + 2 * 86_400_000).toISOString();
    const dueLater = new Date(nowMs + 5 * 86_400_000).toISOString();
    const item = (id: string, weekId: string, dueAt: string) => ({
      id, text: `Item ${id}`, durationMin: 60, priority: 1, category: 'work' as const, confirmed: true, weekId, dueAt,
    });
    await runtime.repos.items.save(week3, [item('far', week3, dueLater)]);
    await runtime.repos.items.save(week4, [item('outside', week4, dueSoon)]);
    await runtime.repos.items.save(WEEK, [item('unplaced', WEEK, dueSoon)]);
    await runtime.repos.blocks.save(WEEK, [{ ...block('dl', 'scheduled'), dueAt: dueLater }]);
    const view = await runtime.services.dashboard.load();
    expect(view.important.rows.map((r) => r.id)).toEqual(['unplaced', 'dl', 'far']);
    expect(view.important.rows[0]!.target).toEqual({ kind: 'summary', weekId: WEEK, itemId: 'unplaced' });
    expect(view.important.rows[1]!.target).toEqual({ kind: 'block', blockId: 'dl', weekId: WEEK });
    expect(view.important.moreCount).toBe(0);
    // Widgets still use only the current week's blocks.
    expect(view.widgets[0]).toMatchObject({ caption: '0 of 1 done' });
  });
  it('greets generically and shows dashes on a fresh install', async () => {
    const runtime = createAppRuntime(fakeDeps().deps);
    const view = await runtime.services.dashboard.load();
    expect(view.greeting).toBe('Hi there!');
    expect(view.widgets[0]!.value).toBe('—');
  });

  it('maps a failing usage permission read to unknown instead of failing', async () => {
    const usage = new FakeUsageSource([]);
    jest.spyOn(usage, 'permission').mockRejectedValue(new Error('native'));
    const runtime = createAppRuntime(fakeDeps({ usage }).deps);
    const view = await runtime.services.dashboard.load();
    expect(view.widgets[1]!.caption).toBe('No nights recorded yet');
  });

  it('says access is needed when usage access is denied and no night is recorded', async () => {
    const usage = new FakeUsageSource([]);
    jest.spyOn(usage, 'permission').mockResolvedValue('denied');
    const runtime = createAppRuntime(fakeDeps({ usage }).deps);
    const view = await runtime.services.dashboard.load();
    expect(view.widgets[1]!.caption).toBe('Allow usage access to see this');
  });
});

describe('ids adapter', () => {
  it('generates unique local ids and valid base32hex Calendar event ids', () => {
    const ids = new RandomIdGenerator();
    const local = new Set<string>();
    const events = new Set<string>();
    for (let i = 0; i < 500; i += 1) {
      local.add(ids.next());
      const eventId = ids.calendarEventId();
      expect(eventId).toMatch(/^[0-9a-v]{5,1024}$/);
      events.add(eventId);
    }
    expect(local.size).toBe(500);
    expect(events.size).toBe(500);
  });

  it('stays unique and valid even with a constant random source', () => {
    const ids = new RandomIdGenerator(() => 0, () => 0.999999);
    expect(ids.next()).not.toBe(ids.next());
    const a = ids.calendarEventId();
    const b = ids.calendarEventId();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[0-9a-v]{26}$/);
    expect(createRuntimeId()).toMatch(/^rt-[0-9a-z]+-[0-9a-z]{10}$/);
  });
});

describe('sleep data and demo wiring (R24, R25)', () => {
  const setDev = (value: boolean | undefined) => {
    (global as unknown as { __DEV__?: boolean }).__DEV__ = value;
  };
  const withDev = <T,>(value: boolean, fn: () => T): T => {
    const prev = (global as unknown as { __DEV__?: boolean }).__DEV__;
    setDev(value);
    try {
      return fn();
    } finally {
      setDev(prev);
    }
  };
  const night = (startMs: number, mins: number) => ({ startMs, endMs: startMs + mins * 60_000, asleepMin: mins - 20 });

  function healthDemo() {
    return {
      writeDemoSessions: jest.fn(async (s: unknown[]) => s.length as number | false),
      deleteDemoSessions: jest.fn(async () => 14 as number | false),
    };
  }

  it('debug build: demo wrappers are active and demo is exposed', async () => {
    const healthSleep = new FakeSleepSource([], 'denied');
    const f = fakeDeps({ usage: new FakeUsageSource([], 'denied'), healthSleep, healthDemo: healthDemo() });
    const runtime = createAppRuntime(f.deps);
    expect(runtime.services.demo).toBeDefined();
    expect(await runtime.services.usage.permission()).toBe('denied');
    await runtime.services.demo!.setUsage(true);
    // Demo usage on: the wrapped usage source reports granted without the real grant.
    expect(await runtime.services.usage.permission()).toBe('granted');
    expect(await runtime.services.demo!.isUsageEnabled()).toBe(true);
    // Settings reads the REAL health source, not the demo wrapper.
    expect(await runtime.services.sleepData.status()).toEqual({ availability: 'available', permission: 'denied' });
  });

  it('release build: real sources only and no demo port', async () => {
    await withDev(false, async () => {
      const usage = new FakeUsageSource([], 'denied');
      const healthSleep = new FakeSleepSource([], 'denied');
      const runtime = createAppRuntime(fakeDeps({ usage, healthSleep }).deps);
      expect(runtime.services.demo).toBeUndefined();
      expect(runtime.services.usage).toBe(usage);
      // A demo flag in storage has no effect in release.
      await runtime.repos.demoMode.save({ loadedAt: NOW, blockWeeks: [], demoUsage: true, addedDistractionApps: false });
      expect(await runtime.services.usage.permission()).toBe('denied');
      await runtime.sleep.recordRecentNights();
      expect(Object.keys(await runtime.repos.sleepScores.get())).toHaveLength(0);
    });
  });

  it('passes the sleep source to SleepService (health + usage scoring)', async () => {
    const usage = new FakeUsageSource([{ packageName: 'com.x', foregroundTimeMs: 10 * 60_000 }]);
    const healthSleep = new FakeSleepSource((w) => [night(w.endMs - 8 * 3_600_000, 8 * 60)], 'granted');
    const runtime = createAppRuntime(fakeDeps({ usage, healthSleep }).deps);
    await runtime.sleep.recordRecentNights();
    expect(healthSleep.reads.length).toBeGreaterThan(0);
    const scores = Object.values(await runtime.repos.sleepScores.get());
    expect(scores.some((s) => s.source === 'health+usage')).toBe(true);
  });

  it('sleepData.status and connect delegate to the real source', async () => {
    const healthSleep = new FakeSleepSource([], 'denied', 'needs-install');
    const runtime = createAppRuntime(fakeDeps({ healthSleep }).deps);
    expect(await runtime.services.sleepData.status()).toEqual({ availability: 'needs-install', permission: 'denied' });
    const request = jest.spyOn(healthSleep, 'requestPermission').mockImplementation(async () => {
      healthSleep.permissionState = 'granted';
      return 'granted';
    });
    expect(await runtime.services.sleepData.connect()).toBe('granted');
    expect(request).toHaveBeenCalledTimes(1);
    expect((await runtime.services.sleepData.status()).permission).toBe('granted');
  });

  it('demo.load then remove over in-memory repositories; remove deletes Health Connect demo sessions', async () => {
    const writer = healthDemo();
    const runtime = createAppRuntime(fakeDeps({ healthDemo: writer }).deps);
    const demo = runtime.services.demo!;
    const loaded = await demo.load();
    expect(loaded.blocks).toBeGreaterThan(0);
    expect(loaded.nights).toBe(14);
    expect(Object.keys(await runtime.repos.sleepScores.get()).length).toBeGreaterThanOrEqual(14);

    const removed = await demo.remove();
    expect(writer.deleteDemoSessions).toHaveBeenCalledTimes(1);
    expect(removed).toEqual({ blocks: loaded.blocks, nights: 14, healthRemoved: 14 });
    expect(Object.keys(await runtime.repos.sleepScores.get())).toHaveLength(0);
  });

  it('demo.remove reports healthRemoved false when the writer throws', async () => {
    const writer = healthDemo();
    writer.deleteDemoSessions.mockRejectedValue(new Error('nope'));
    const runtime = createAppRuntime(fakeDeps({ healthDemo: writer }).deps);
    await runtime.services.demo!.load();
    await expect(runtime.services.demo!.remove()).resolves.toMatchObject({ healthRemoved: false });
  });

  it('demo.setUsage(true) scores nights immediately from demo sessions; false stops it', async () => {
    const runtime = createAppRuntime(fakeDeps({ healthSleep: new FakeSleepSource([], 'denied') }).deps);
    const record = jest.spyOn(runtime.sleep, 'recordRecentNights');
    await runtime.services.demo!.setUsage(true);
    expect(record).toHaveBeenCalledTimes(1);
    expect(Object.keys(await runtime.repos.sleepScores.get()).length).toBeGreaterThan(0);
    await runtime.services.demo!.setUsage(false);
    expect(record).toHaveBeenCalledTimes(1);
    expect(await runtime.services.demo!.isUsageEnabled()).toBe(false);
  });

  it('demo.setUsage swallows scoring errors', async () => {
    const runtime = createAppRuntime(fakeDeps().deps);
    jest.spyOn(runtime.sleep, 'recordRecentNights').mockRejectedValue(new Error('boom'));
    await expect(runtime.services.demo!.setUsage(true)).resolves.toBeUndefined();
  });

  it('demo.writeHealthSleep writes 14 converted nights and then rescores', async () => {
    const writer = healthDemo();
    const runtime = createAppRuntime(fakeDeps({ healthDemo: writer }).deps);
    const record = jest.spyOn(runtime.sleep, 'recordRecentNights');
    await expect(runtime.services.demo!.writeHealthSleep()).resolves.toBe(14);
    const sent = writer.writeDemoSessions.mock.calls[0]![0] as { startMs: number; endMs: number; awakeMin: number }[];
    expect(sent).toHaveLength(14);
    for (const s of sent) {
      expect(s.endMs).toBeGreaterThan(s.startMs);
      expect(Number.isInteger(s.awakeMin)).toBe(true);
      expect(s.awakeMin).toBeGreaterThanOrEqual(0);
    }
    expect(record).toHaveBeenCalledTimes(1);
  });

  it('demo.writeHealthSleep returns false without rescoring when the write is unavailable', async () => {
    const writer = healthDemo();
    writer.writeDemoSessions.mockResolvedValue(false);
    const runtime = createAppRuntime(fakeDeps({ healthDemo: writer }).deps);
    const record = jest.spyOn(runtime.sleep, 'recordRecentNights');
    await expect(runtime.services.demo!.writeHealthSleep()).resolves.toBe(false);
    expect(record).not.toHaveBeenCalled();
  });
});

describe('holidays wiring (R30.2)', () => {
  const HOLIDAYS = {
    country: 'CA',
    fetchedAt: NOW,
    items: [{ date: '2025-02-17', name: 'Family Day' }],
  };
  it('the Settings port reports the country and next holiday from the cache', async () => {
    const runtime = createAppRuntime(fakeDeps({ holidayCountry: () => 'CA' }).deps);
    await runtime.repos.holidays.save(HOLIDAYS);
    await expect(runtime.services.holidays.summary()).resolves.toEqual({
      country: 'Canada',
      next: { name: 'Family Day', date: '2025-02-17' },
    });
  });
  it('refreshes stale holidays on launch, foreground, and background sync when signed in', async () => {
    const runtime = createAppRuntime(fakeDeps({ holidayCountry: () => 'CA' }).deps);
    await runtime.repos.authState.save({ status: 'signed-in' });
    const refresh = jest.spyOn(runtime.holidays, 'refreshIfStale').mockResolvedValue(undefined);
    jest.spyOn(runtime.sync, 'sync').mockResolvedValue({ status: 'ok' } as never);
    await runtime.lifecycle.onLaunch();
    expect(refresh).toHaveBeenCalledTimes(1);
    await runtime.lifecycle.onForeground();
    expect(refresh).toHaveBeenCalledTimes(2);
    await runtime.backgroundSync();
    expect(refresh).toHaveBeenCalledTimes(3);
  });
  it('does not touch the calendar while signed out', async () => {
    const runtime = createAppRuntime(fakeDeps().deps);
    const refresh = jest.spyOn(runtime.holidays, 'refreshIfStale');
    await runtime.lifecycle.onLaunch();
    expect(refresh).not.toHaveBeenCalled();
  });
  it('a failing refresh never fails the lifecycle or the background sync', async () => {
    const runtime = createAppRuntime(fakeDeps().deps);
    await runtime.repos.authState.save({ status: 'signed-in' });
    jest.spyOn(runtime.holidays, 'refreshIfStale').mockRejectedValue(new Error('boom'));
    jest.spyOn(runtime.sync, 'sync').mockResolvedValue({ status: 'ok' } as never);
    await expect(runtime.lifecycle.onLaunch()).resolves.toBeDefined();
    await expect(runtime.lifecycle.onForeground()).resolves.toBeDefined();
    await expect(runtime.backgroundSync()).resolves.toBeUndefined();
  });
  it('exposes cached holiday dates to planning', async () => {
    const runtime = createAppRuntime(fakeDeps({ holidayCountry: () => 'CA' }).deps);
    // NOW is Wed 2025-01-08; the week is 2025-01-05..11. Make Monday 01-06 a holiday.
    await runtime.repos.holidays.save({ ...HOLIDAYS, items: [{ date: '2025-01-06', name: 'Test Day' }] });
    await expect(runtime.holidays.dates()).resolves.toEqual(['2025-01-06']);
  });
});

describe('AI wiring (R33, R35)', () => {
  const AI_BASE = `https://abc123xyz${AI_HOST_SUFFIX}`;
  const enc = (o: object) => Buffer.from(JSON.stringify(o), 'utf8').toString('base64url');
  const ID_TOKEN = `${enc({ alg: 'RS256' })}.${enc({ sub: 'sub-42', exp: Math.floor((NOW + 3_600_000) / 1000) })}.sig`;
  const LINE = 'Zorp the frobnicator | 30';

  /** Runtime with a signed-in vault whose refresh returns an id token. */
  function aiSetup(overrides: Partial<AppRuntimeDeps> = {}) {
    const aiTransport = new FakeHttpTransport(() => ({
      status: 200,
      body: JSON.stringify({ items: [{ index: 0, category: 'work', kind: 'application' }] }),
    }));
    const authClient = new ScriptableAuthClient();
    authClient.nextRefresh({ kind: 'ok', grant: makeGrant({ idToken: ID_TOKEN }) });
    const vault = new FakeTokenVault(makeTokens({ expiryDate: NOW + 3_600_000 }));
    const f = fakeDeps({ aiTransport, aiBaseUrl: AI_BASE, authClient, vault, ...overrides });
    const runtime = createAppRuntime(f.deps);
    return { f, runtime, aiTransport, authClient, vault };
  }

  it('makes no AI call and no token refresh while the assistant is off (default)', async () => {
    const { runtime, aiTransport, authClient } = aiSetup();
    expect((await runtime.settings.get()).aiEnabled).not.toBe(true);
    const result = await runtime.services.intake.submit(LINE, weekIdAt(NOW));
    expect(result.ok).toBe(true);
    expect(aiTransport.requests).toHaveLength(0);
    expect(authClient.refreshCalls).toHaveLength(0);
    const items = await runtime.repos.items.get(weekIdAt(NOW));
    expect(items[0]).toMatchObject({ text: 'Zorp the frobnicator', category: 'misc' });
    expect(items[0]).not.toHaveProperty('kind');
    expect(await runtime.ai.availability()).toBe('disabled');
  });

  it('when enabled, sends only the title with the Bearer id token and applies kind and the default-source category', async () => {
    const { runtime, aiTransport, f } = aiSetup();
    await runtime.services.settings.setAiEnabled(true);
    expect(await runtime.ai.availability()).toBe('ready');
    const weekId = weekIdAt(NOW);
    const result = await runtime.services.intake.submit(LINE, weekId);
    expect(result.ok).toBe(true);
    expect(aiTransport.requests).toHaveLength(1);
    const req = aiTransport.requests[0]!;
    expect(req.url).toBe(`${AI_BASE}/ai/parse-tasks`);
    expect(req.headers.Authorization).toBe(`Bearer ${ID_TOKEN}`);
    expect(req.timeoutMs).toBe(6000);
    expect(JSON.parse(req.body!)).toEqual({ titles: ['Zorp the frobnicator'] });
    const items = await runtime.repos.items.get(weekId);
    expect(items[0]).toMatchObject({ text: 'Zorp the frobnicator', durationMin: 30, category: 'work', kind: 'application' });
    expect((await runtime.repos.blocks.get(weekId))[0]).toMatchObject({ kind: 'application', category: 'work' });
    // The id token is never persisted.
    expect(JSON.stringify(f.kv.snapshot())).not.toContain(ID_TOKEN);
    expect(JSON.stringify(f.kv.snapshot())).not.toContain(ID_TOKEN.split('.')[1]!);
  });

  it('never replaces a keyword category', async () => {
    const { runtime } = aiSetup();
    await runtime.services.settings.setAiEnabled(true);
    const result = await runtime.services.intake.submit('Gym session | 45', weekIdAt(NOW));
    expect(result.ok).toBe(true);
    const items = await runtime.repos.items.get(weekIdAt(NOW));
    expect(items[0]).toMatchObject({ category: 'fitness', kind: 'application' });
  });

  it('enabled but not configured: no network, built-in result', async () => {
    const { runtime, aiTransport, authClient } = aiSetup({ aiBaseUrl: '' });
    await runtime.services.settings.setAiEnabled(true);
    expect(await runtime.ai.availability()).toBe('not-configured');
    expect((await runtime.services.intake.submit(LINE, weekIdAt(NOW))).ok).toBe(true);
    expect(aiTransport.requests).toHaveLength(0);
    expect(authClient.refreshCalls).toHaveLength(0);
  });

  it('a failing or invalid AI service leaves the built-in result, without an error', async () => {
    for (const respond of [
      () => ({ status: 500, body: '' }),
      () => ({ status: 200, body: '{"items":[]}' }),
      () => ({ status: 200, body: 'nope' }),
    ]) {
      const { runtime, aiTransport } = aiSetup();
      aiTransport.respondWith(respond);
      await runtime.services.settings.setAiEnabled(true);
      const result = await runtime.services.intake.submit(LINE, weekIdAt(NOW));
      expect(result.ok).toBe(true);
      const items = await runtime.repos.items.get(weekIdAt(NOW));
      expect(items[0]).toMatchObject({ category: 'misc' });
      expect(items[0]).not.toHaveProperty('kind');
    }
  });

  it('a network failure of the AI call does not end the session or block planning', async () => {
    const { runtime, aiTransport } = aiSetup();
    aiTransport.failNext();
    await runtime.services.settings.setAiEnabled(true);
    expect((await runtime.services.intake.submit(LINE, weekIdAt(NOW))).ok).toBe(true);
    expect(await runtime.services.auth.state()).not.toEqual({ status: 'session-ended', reason: 'transport' });
  });

  it('without an id token (offline refresh) AI is skipped and the session stays signed in', async () => {
    const authClient = new ScriptableAuthClient();
    authClient.nextRefresh({ kind: 'transport-error', message: 'offline' });
    const { runtime, aiTransport } = aiSetup({ authClient });
    await runtime.repos.authState.save({ status: 'signed-in' });
    await runtime.services.settings.setAiEnabled(true);
    expect((await runtime.services.intake.submit(LINE, weekIdAt(NOW))).ok).toBe(true);
    expect(aiTransport.requests).toHaveLength(0);
    expect(await runtime.services.auth.state()).toEqual({ status: 'signed-in' });
  });

  it('exposes googleSub, the ai port and aiProfile on the screen services', async () => {
    const { runtime } = aiSetup();
    expect(runtime.services.ai).toBe(runtime.ai);
    expect(await runtime.services.auth.googleSub()).toBe('sub-42');
    await runtime.services.aiProfile.save('  I led a team.  ');
    expect((await runtime.services.aiProfile.get())?.background).toBe('I led a team.');
    await runtime.services.aiProfile.clear();
    expect(await runtime.services.aiProfile.get()).toBeNull();
  });
});
