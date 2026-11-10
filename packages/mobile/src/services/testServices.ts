/**
 * Test helper: an {@link AppServices} where every method is a `jest.fn`
 * backed by a small in-memory {@link TestState}. Jest only (uses the `jest`
 * global); never import it from production code.
 *
 * Defaults (override per test with `mockResolvedValueOnce` / `mockImplementation`):
 *
 * - `auth.signIn` succeeds (`via: 'authorize'`) and sets `signed-in`;
 *   `auth.signOut` sets `signed-out`; `authState` is a real
 *   `createAuthStateStore(() => auth.state())`.
 * - `intake.validate` accepts any non-blank text with no candidates and
 *   stores it as the draft; `intake.submit` rejects blank text (`empty`) and otherwise, like
 *   `intake.confirm` and `planning.plan`, returns an
 *   empty {@link PlanResult} (`no-draft` when there is no draft).
 * - `sync.sync` records `lastSuccessAt = now`; `sync.dismissBanner` dismisses
 *   the stored error.
 * - `notifications.*` derive from `state.permissionState` and
 *   `state.notificationPermission`.
 * - `blockActions.imIn` / `skip` update the stored block's status
 *   (`in-progress` / `skipped`); `moveIt`, `answerPrompt`, and
 *   `resolveNothingFits` return `not-found`; `undo` is rejected (`no-token`).
 * - `review.build` returns an empty review; `review.get` reads `state.reviews`.
 * - `settings.*` mutate `state.settings` with app-core's validation rules.
 * - `repos.*` read `state`; `clock.now()` returns `state.now`.
 */
import {
  DEFAULT_DEVICE_SETTINGS,
  DEFAULT_PERMISSION_STATE,
  PLANNING_MODES,
  weekIdAt,
  weekOfId,
  type AuthState,
  type CalendarCache,
  type DashboardView,
  type DeviceBlock,
  type DeviceBlockStatus,
  type AiAvailability,
  type ApplicationHelpRequest,
  type AiProfile,
  type DeviceSettings,
  type ThemeMode,
  type IntakeDraft,
  type ChangeLengthResult,
  type SetTimingResult,
  type MoveResult,
  type NotFound,
  type NothingFitsResult,
  type NotificationPermission,
  type PromptAnswerResult,
  type OpenPrompt,
  type PermissionState,
  type PlanResult,
  type Profile,
  type SaveNotesResult,
  type SettingsResult,
  type SleepAvailability,
  type SleepPermission,
  type StatusActionResult,
  type SyncState,
  type UndoToken,
  type UsagePermission,
} from '@timeblocker/app-core';
import type { IntakeItem, WeeklyReview } from '@timeblocker/flows';
import { createAuthStateStore } from '../navigation/authStateSource';
import type { AppServices, BlockActionsPort, DemoPort, HolidaysPort } from './AppServices';

const notFound: NotFound = { kind: 'not-found' };

/** `T` with every method replaced by a typed `jest.MockedFunction`. */
export type Fake<T> = {
  [K in keyof T]: T[K] extends (...args: never[]) => unknown ? jest.MockedFunction<T[K]> : Fake<T[K]>;
};

/** {@link AppServices} with every method a mock (except the real `authState` store). */
export type TestServices = {
  [K in Exclude<keyof AppServices, 'authState' | 'demo'>]: Fake<AppServices[K]>;
} & { authState: AppServices['authState']; demo?: Fake<DemoPort> };

/** The in-memory documents the fakes read and write. Mutate freely in tests. */
export interface TestState {
  now: number;
  authState: AuthState;
  draft: IntakeDraft | null;
  blocks: Record<string, DeviceBlock[]>;
  items: Record<string, IntakeItem[]>;
  calendarCache: Record<string, CalendarCache | null>;
  reviews: Record<string, WeeklyReview | null>;
  syncState: SyncState;
  undo: UndoToken | null;
  openPrompts: OpenPrompt[];
  permissionState: PermissionState;
  settings: DeviceSettings;
  usagePermission: UsagePermission;
  notificationPermission: NotificationPermission;
  profile: Profile;
  sleepAvailability: SleepAvailability;
  sleepPermission: SleepPermission;
  /** Whether `demo` is present (debug build). Default true. */
  demoEnabled: boolean;
  demoUsage: boolean;
  /** What `auth.googleSub` resolves with. */
  googleSub: string | undefined;
  /** What `ai.availability` resolves with. */
  aiAvailability: AiAvailability;
  /** The saved "About me for applications" text. */
  aiProfile: AiProfile | null;
  /** What `dashboard.load` resolves with. */
  dashboard: DashboardView;
  /** What `holidays.summary` resolves with. */
  holidaySummary: HolidaySummary | null;
}

export type HolidaySummary = NonNullable<Awaited<ReturnType<HolidaysPort['summary']>>>;

/** 2025-01-08T15:00:00Z, a Wednesday (10:00 Toronto). */
export const TEST_NOW = Date.UTC(2025, 0, 8, 15, 0, 0);

/** A fixed dashboard view (greeting + four widgets) for screen tests. */
export function sampleDashboard(overrides: Partial<DashboardView> = {}): DashboardView {
  const icons = { tasks: 'check', sleep: 'moon', fitness: 'run', moved: 'double-arrow' } as const;
  const widget = (
    id: DashboardView['widgets'][number]['id'],
    label: string,
    value: string,
    caption: string,
    great = false,
    sourceLine?: string,
  ): DashboardView['widgets'][number] => ({
    id,
    label,
    value,
    caption,
    ...(sourceLine ? { sourceLine } : {}),
    icon: icons[id],
    great,
    a11yLabel: `${label}: ${value}. ${caption}${sourceLine ? `. ${sourceLine}` : ''}`,
  });
  return {
    greeting: 'Hi Sam!',
    hasName: true,
    message: 'A fresh week. Add your tasks to get started.',
    progress: 'going-well',
    widgets: [
      widget('tasks', 'Tasks completed', '50%', '2 of 4 done'),
      widget('sleep', 'Sleep score', '7.4', 'Average of 3 nights', false, 'Phone use only'),
      widget('fitness', 'Fitness score', '100%', '1 of 1 fitness task', true),
      widget('moved', 'Moved tasks', '1', 'moved to a new slot'),
    ],
    important: { rows: [], moreCount: 0 },
    ...overrides,
  };
}

export function emptyReview(weekId: string): WeeklyReview {
  return {
    weekId,
    finished: [],
    partial: [],
    missed: [],
    screenTimeMin: 0,
    distractionLevel: 'low',
    movedToNextWeek: [],
    photoPrompt: "Paste or type next week's to-do list",
    fitnessMissedCount: 0,
  };
}

export function emptyPlanResult(weekId: string, settings: DeviceSettings): PlanResult {
  return {
    weekId,
    week: weekOfId(weekId),
    mode: settings.planningMode,
    placed: [],
    unplaced: [],
    blocks: [],
    sync: 'skipped',
  };
}

const shiftWeek = (weekId: string): string => {
  const d = new Date(`${weekId}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 7);
  return d.toISOString().slice(0, 10);
};

export function createTestServices(seed: Partial<TestState> = {}): TestServices & { state: TestState } {
  const state: TestState = {
    now: TEST_NOW,
    authState: { status: 'signed-out' },
    draft: null,
    blocks: {},
    items: {},
    calendarCache: {},
    reviews: {},
    syncState: {},
    undo: null,
    openPrompts: [],
    permissionState: { ...DEFAULT_PERMISSION_STATE },
    settings: {
      ...DEFAULT_DEVICE_SETTINGS,
      holidays: [...DEFAULT_DEVICE_SETTINGS.holidays],
      distractionApps: [...DEFAULT_DEVICE_SETTINGS.distractionApps],
    },
    usagePermission: 'denied',
    notificationPermission: 'granted',
    profile: { updatedAt: 0 },
    dashboard: sampleDashboard(),
    holidaySummary: null,
    googleSub: undefined,
    aiAvailability: 'disabled',
    aiProfile: null,
    sleepAvailability: 'available',
    sleepPermission: 'denied',
    demoEnabled: true,
    demoUsage: false,
    ...seed,
  };

  const exactAlarm = () => ({
    exactAlarmsAvailable: state.permissionState.exactAlarmsAvailable,
    reminderTimingMayVary: !state.permissionState.exactAlarmsAvailable,
  });

  const setStatus = (status: DeviceBlockStatus) =>
    async ({ weekId, blockId }: { weekId: string; blockId: string }): Promise<StatusActionResult> => {
      const blocks = state.blocks[weekId] ?? [];
      const found = blocks.find((b) => b.id === blockId);
      if (!found) return { kind: 'not-found' };
      const block = { ...found, status, updatedAt: state.now };
      state.blocks[weekId] = blocks.map((b) => (b.id === blockId ? block : b));
      return { kind: 'updated', block };
    };

  const applySettings = (next: DeviceSettings | null, error: 'invalid-theme-mode' | 'invalid-app' | 'invalid-planning-mode' | 'invalid-ai-enabled'): SettingsResult => {
    if (!next) return { ok: false, error, settings: state.settings };
    const changed = JSON.stringify(next) !== JSON.stringify(state.settings);
    state.settings = next;
    return { ok: true, changed, settings: next };
  };

  const auth: TestServices['auth'] = {
    state: jest.fn(async () => state.authState),
    signIn: jest.fn(async () => {
      state.authState = { status: 'signed-in' };
      return { ok: true as const, via: 'authorize' as const };
    }),
    reconnect: jest.fn(async () => ({ ok: true as const, via: 'authorize' as const })),
    googleSub: jest.fn(async () => state.googleSub),
    signOut: jest.fn(async () => {
      state.authState = { status: 'signed-out' };
    }),
  };

  const plan = async (weekId: string) => emptyPlanResult(weekId, state.settings);

  const demo: Fake<DemoPort> = {
    load: jest.fn(async () => ({ blocks: 112, nights: 14, weeks: 8 })),
    remove: jest.fn(async () => ({ blocks: 112, nights: 14, healthRemoved: 14 as number | false })),
    setUsage: jest.fn(async (enabled: boolean) => {
      state.demoUsage = enabled;
    }),
    isUsageEnabled: jest.fn(async () => state.demoUsage),
    writeHealthSleep: jest.fn(async () => 14 as number | false),
  };

  return {
    state,
    auth,
    authState: createAuthStateStore(() => auth.state()),
    intake: {
      draft: jest.fn(async () => state.draft),
      validate: jest.fn(async (raw: string) => {
        if (raw.trim() === '') return { ok: false as const, text: raw, reason: 'empty' as const };
        state.draft = { text: raw, candidates: [], updatedAt: state.now };
        return { ok: true as const, text: raw, candidates: [] };
      }),
      confirm: jest.fn(async (weekId: string) => {
        if (!state.draft) return { ok: false as const, error: 'no-draft' as const };
        state.draft = null;
        return { ok: true as const, weekId, confirmed: [], plan: await plan(weekId) };
      }),
      submit: jest.fn(async (raw: string, weekId: string) => {
        if (raw.trim() === '') return { ok: false as const, error: 'rejected' as const, reason: 'empty' as const };
        state.draft = null;
        return { ok: true as const, weekId, confirmed: [], plan: await plan(weekId) };
      }),
    },
    planning: {
      plan: jest.fn(plan),
      rollToNextWeek: jest.fn(async (weekId: string, _itemIds: readonly string[]) => plan(shiftWeek(weekId))),
      dropUnplaced: jest.fn(async (_weekId: string, _itemIds: readonly string[]) => ({ removed: 0 })),
    },
    weekReset: { clear: jest.fn(async (_weekId: string) => ({ removedTasks: 0, keptAsHistory: 0 })) },
    sync: {
      sync: jest.fn(async (trigger) => {
        state.syncState = { ...state.syncState, lastSuccessAt: state.now };
        delete state.syncState.error;
        return { status: 'completed' as const, trigger, startedAt: state.now, finishedAt: state.now, report: { stepsRun: [] } };
      }),
      dismissBanner: jest.fn(async () => {
        if (state.syncState.error) state.syncState = { ...state.syncState, error: { ...state.syncState.error, dismissed: true } };
      }),
    },
    notifications: {
      indicators: jest.fn(async () => ({
        denied: state.notificationPermission === 'denied',
        blockIds: [],
        meetingIds: [],
      })),
      exactAlarmState: jest.fn(async () => exactAlarm()),
      refreshExactAlarmState: jest.fn(async () => ({ ...exactAlarm(), changed: false })),
      ensurePermissionOnce: jest.fn(async () => ({ permission: state.notificationPermission, requested: false })),
    },
    blockActions: {
      imIn: jest.fn(setStatus('in-progress')),
      skip: jest.fn(setStatus('skipped')),
      moveIt: jest.fn<Promise<MoveResult>, Parameters<BlockActionsPort['moveIt']>>(async () => notFound),
      changeLength: jest.fn<Promise<ChangeLengthResult>, Parameters<BlockActionsPort['changeLength']>>(
        async () => notFound,
      ),
      setTiming: jest.fn<Promise<SetTimingResult>, Parameters<BlockActionsPort['setTiming']>>(
        async () => notFound,
      ),
      answerPrompt: jest.fn<Promise<PromptAnswerResult>, Parameters<BlockActionsPort['answerPrompt']>>(
        async () => notFound,
      ),
      saveNotes: jest.fn<Promise<SaveNotesResult>, Parameters<BlockActionsPort['saveNotes']>>(async (ref, notes) => {
        for (const [weekId, list] of Object.entries(state.blocks)) {
          const found = list.find((b) => b.id === ref.blockId);
          if (!found) continue;
          const { notes: _old, ...rest } = found;
          const next: DeviceBlock = notes ? { ...rest, notes: notes.slice(0, 4000) } : rest;
          state.blocks[weekId] = list.map((b) => (b.id === next.id ? next : b));
          return { kind: 'saved' as const, block: next };
        }
        return notFound;
      }),
      undo: jest.fn(async () => ({ kind: 'rejected' as const, reason: 'no-token' as const })),
      resolveNothingFits: jest.fn<Promise<NothingFitsResult>, Parameters<BlockActionsPort['resolveNothingFits']>>(
        async () => notFound,
      ),
    },
    review: {
      currentWeekId: jest.fn(() => weekIdAt(state.now)),
      build: jest.fn(async (weekId?: string) => {
        const id = weekId ?? weekIdAt(state.now);
        return { weekId: id, review: state.reviews[id] ?? emptyReview(id), usage: 'ok' as const, fitnessMissed: [] };
      }),
      get: jest.fn(async (weekId: string) => state.reviews[weekId] ?? null),
    },
    dashboard: { load: jest.fn(async () => state.dashboard) },
    holidays: {
      summary: jest.fn(async (): Promise<HolidaySummary | null> => state.holidaySummary),
    },
    settings: {
      get: jest.fn(async () => state.settings),
      setPlanningMode: jest.fn(async (mode) =>
        applySettings(
          PLANNING_MODES.includes(mode)
            ? { ...state.settings, planningMode: mode, planningModeSetByUser: true }
            : null,
          'invalid-planning-mode',
        ),
      ),
      setThemeMode: jest.fn(async (mode: ThemeMode) =>
        applySettings(
          mode === 'system' || mode === 'light' || mode === 'dark' ? { ...state.settings, themeMode: mode } : null,
          'invalid-theme-mode',
        ),
      ),
      addDistractionApp: jest.fn(async (pkg: string) => {
        const app = pkg.trim();
        return applySettings(
          app ? { ...state.settings, distractionApps: [...new Set([...state.settings.distractionApps, app])] } : null,
          'invalid-app',
        );
      }),
      setAiEnabled: jest.fn(async (enabled: boolean) =>
        applySettings(
          typeof enabled === 'boolean' ? { ...state.settings, aiEnabled: enabled } : null,
          'invalid-ai-enabled',
        ),
      ),
      removeDistractionApp: jest.fn(async (pkg: string) =>
        applySettings(
          { ...state.settings, distractionApps: state.settings.distractionApps.filter((a) => a !== pkg) },
          'invalid-app',
        ),
      ),
    },
    ai: {
      availability: jest.fn(async () => state.aiAvailability),
      parseTasks: jest.fn(async (_titles: readonly string[]) => ({ ok: false as const, reason: 'disabled' as const })),
      applicationHelp: jest.fn(async (_request: ApplicationHelpRequest) => ({ ok: false as const, reason: 'disabled' as const })),
    },
    aiProfile: {
      get: jest.fn(async () => state.aiProfile),
      save: jest.fn(async (background: string) => {
        state.aiProfile = background.trim()
          ? { background: background.trim().slice(0, 3000), updatedAt: state.now }
          : null;
        return state.aiProfile;
      }),
      clear: jest.fn(async () => {
        state.aiProfile = null;
      }),
    },
    repos: {
      blocks: { get: jest.fn(async (weekId: string) => state.blocks[weekId] ?? []) },
      items: { get: jest.fn(async (weekId: string) => state.items[weekId] ?? []) },
      calendarCache: { get: jest.fn(async (weekId: string) => state.calendarCache[weekId] ?? null) },
      syncState: { get: jest.fn(async () => state.syncState) },
      undo: { get: jest.fn(async () => state.undo) },
      openPrompts: { get: jest.fn(async () => state.openPrompts) },
      permissionState: { get: jest.fn(async () => state.permissionState) },
      profile: { get: jest.fn(async () => state.profile) },
    },
    systemSettings: {
      openUsageAccess: jest.fn(async () => {}),
      openNotificationSettings: jest.fn(async () => {}),
      openExactAlarmSettings: jest.fn(async () => {}),
    },
    usage: { permission: jest.fn(async () => state.usagePermission) },
    notificationPermission: { permission: jest.fn(async () => state.notificationPermission) },
    clock: { now: jest.fn(() => state.now) },
    sleepData: {
      status: jest.fn(async () => ({ availability: state.sleepAvailability, permission: state.sleepPermission })),
      connect: jest.fn(async () => {
        return state.sleepPermission;
      }),
    },
    ...(state.demoEnabled ? { demo } : {}),
  };
}
