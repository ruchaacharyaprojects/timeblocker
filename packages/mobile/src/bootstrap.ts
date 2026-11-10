/**
 * Composition root (design: "Composition root"; task 25.1; R12.6, R14.1).
 *
 * Builds every adapter, the repositories, and every app-core service into one
 * {@link AppRuntime}. The UI (`App.tsx`) and the headless tasks (`index.js`)
 * share one instance per JS runtime through {@link getAppRuntime}, so they
 * use the same per-key mutexes, the same in-flight sync, and the same
 * runtime id for sync leases.
 *
 * Native dependencies are injectable ({@link AppRuntimeDeps}) so Jest can
 * build the real service graph over fakes; every omitted dependency falls
 * back to its native adapter. The only network peers are Google (R12.6) and,
 * when the owner enabled the AI assistant and configured its address, the
 * owner's private AI service (R35.3).
 */
import { Platform } from 'react-native';
import {
  AiProfileService,
  AppLifecycle,
  AuthService,
  BlockActionService,
  HolidayService,
  DemoDataService,
  DemoSleepSource,
  DemoUsageSource,
  HistoryReader,
  IntakeService,
  NotificationService,
  PlanningService,
  Repositories,
  ReviewService,
  SettingsService,
  SleepService,
  SyncService,
  UsageRiskService,
  WeekResetService,
  buildDashboard,
  shiftWeekId,
  createAuthorizedCalendarApi,
  createForecastProvider,
  demoSleepSessions,
  type AiPort,
  type AuthClient,
  type BackgroundJobs,
  type Clock,
  type HttpTransport,
  type IdGenerator,
  type KeyValueStore,
  type LifecycleAuth,
  type Notifier,
  type PlanResult,
  type PlanningSync,
  type SleepSource,
  type SessionEnded,
  type SessionEndedReason,
  type SystemSettings,
  type TokenVault,
  type UsageSource,
} from '@timeblocker/app-core';
import {
  AiClient,
  AppAuthClient,
  AsyncStorageKeyValueStore,
  BackgroundFetchJobs,
  FetchHttpTransport,
  HealthConnectSleepSource,
  HealthDemoWriter,
  KeychainTokenVault,
  LinkingSystemSettings,
  NativeNotifier,
  NativeUsageSource,
  RandomIdGenerator,
  createAiEnhancer,
  createRuntimeId,
  type NativeNotifierOptions,
} from './adapters';
import type { SyncHandler } from './adapters/backgroundJobs';
import { createAuthStateStore } from './navigation/authStateSource';
import type { AppServices, DemoPort } from './services/AppServices';

/** Debug-only Health Connect writer (structurally `HealthDemoWriter`). */
export interface HealthDemoPort {
  writeDemoSessions(sessions: { startMs: number; endMs: number; awakeMin: number }[]): Promise<number | false>;
  deleteDemoSessions(): Promise<number | false>;
}

/** Overrides for the native adapters (tests). Omitted entries use the native adapter. */
export interface AppRuntimeDeps {
  kv?: KeyValueStore;
  vault?: TokenVault;
  authClient?: AuthClient;
  transport?: HttpTransport;
  /** Raw HTTP used by the AI client only (tests); defaults to fetch. */
  aiTransport?: HttpTransport;
  /** AI service address override (tests); defaults to `AI_API_BASE_URL`. */
  aiBaseUrl?: string;
  /** Builds the background job scheduler around the background sync handler. */
  jobs?: (onSync: SyncHandler) => BackgroundJobs;
  /** Builds the notifier; `wasRequested` reads `permissionState.notificationsRequested`. */
  notifier?: (options: NativeNotifierOptions) => Notifier;
  usage?: UsageSource;
  /** The real Health Connect sleep source. */
  healthSleep?: SleepSource;
  /** Debug-only Health Connect demo writer. */
  healthDemo?: HealthDemoPort;
  systemSettings?: SystemSettings;
  clock?: Clock;
  ids?: IdGenerator;
  /** Unique per JS runtime; defaults to a random id. */
  runtimeId?: string;
  /** Android API level; defaults to `Platform.Version`. */
  apiLevel?: number;
  /** ISO country code for public holidays; defaults to the device locale's region (R30.2). */
  holidayCountry?: () => string;
}

/** The composed app: screen services, the lifecycle, and the services headless tasks call. */
export interface AppRuntime {
  /** What screens read through `AppServicesProvider`. */
  services: AppServices;
  /** Launch/foreground orchestration (`App.tsx` calls it). */
  lifecycle: Pick<AppLifecycle, 'onLaunch' | 'onForeground'>;
  repos: Repositories;
  auth: AuthService;
  intake: IntakeService<PlanResult>;
  planning: PlanningService;
  sync: SyncService;
  notifications: NotificationService;
  usageRisk: UsageRiskService;
  blockActions: BlockActionService;
  review: ReviewService;
  settings: SettingsService;
  /** AI service client (R33-R35); makes no call unless enabled and configured. */
  ai: AiPort;
  /** "About me for applications" text, phone-only (R34.2). */
  aiProfile: AiProfileService;
  /** Country holidays (R30.2); refreshed on launch, foreground, and background sync. */
  holidays: HolidayService;
  /** Nightly sleep scoring (R19); run after launch, foreground, and background sync. */
  sleep: SleepService;
  notifier: Notifier;
  jobs: BackgroundJobs;
  runtimeId: string;
  /** One `"background"` sync (the periodic job and its headless task, R14.3). */
  backgroundSync: SyncHandler;
  /** Mark the session ended and send the navigator back to SignIn (R12.5, R14.12). */
  endSession(ended: SessionEnded | SessionEndedReason): Promise<void>;
}

/** `Platform.Version` as a number, or undefined off Android (e.g. the Jest preset). */
function platformApiLevel(): number | undefined {
  const level = Number(Platform.Version);
  return Number.isFinite(level) ? level : undefined;
}

/** Build the whole service graph. Prefer {@link getAppRuntime} in app code. */
export function createAppRuntime(deps: AppRuntimeDeps = {}): AppRuntime {
  const clock: Clock = deps.clock ?? { now: () => Date.now() };
  const ids = deps.ids ?? new RandomIdGenerator(() => clock.now());
  const runtimeId = deps.runtimeId ?? createRuntimeId();
  const apiLevel = deps.apiLevel ?? platformApiLevel();

  // --- Adapters -------------------------------------------------------------------------
  const kv = deps.kv ?? new AsyncStorageKeyValueStore();
  const repos = new Repositories(kv);
  const vault = deps.vault ?? new KeychainTokenVault();
  const authClient = deps.authClient ?? new AppAuthClient({ now: () => clock.now() });
  const transport = deps.transport ?? new FetchHttpTransport();
  // Debug builds wrap the real sources so the demo switch can serve synthetic data (R24.3).
  const debugBuild = typeof __DEV__ !== 'undefined' && __DEV__ === true;
  const realUsage = deps.usage ?? new NativeUsageSource();
  const realSleep = deps.healthSleep ?? new HealthConnectSleepSource();
  const usage: UsageSource = debugBuild ? new DemoUsageSource(realUsage, repos) : realUsage;
  const sleepSource: SleepSource = debugBuild ? new DemoSleepSource(realSleep, repos) : realSleep;
  const systemSettings = deps.systemSettings ?? new LinkingSystemSettings();
  const notifierOptions: NativeNotifierOptions = {
    wasRequested: async () => (await repos.permissionState.get()).notificationsRequested,
    ...(apiLevel !== undefined ? { apiLevel } : {}),
  };
  const notifier = deps.notifier ? deps.notifier(notifierOptions) : new NativeNotifier(notifierOptions);

  // The job runs a background sync; `sync` is assigned below, before any job can fire.
  let sync: SyncService | undefined;
  let sleep: SleepService | undefined;
  /** Score recent nights after the main work; never fails the caller (R19.1, R19.4). */
  const recordSleep = async (): Promise<void> => {
    try {
      await sleep?.recordRecentNights();
    } catch {
      // Sleep scoring is best effort and is retried on the next run.
    }
  };
  /** Refresh the country holidays when stale; assigned below, never throws (R30.2). */
  let refreshHolidays: () => Promise<void> = async () => {};
  const backgroundSync: SyncHandler = async () => {
    if (!sync) throw new Error('TimeBlocker services are not ready');
    try {
      await sync.sync('background');
    } finally {
      await refreshHolidays();
      await recordSleep();
    }
  };
  const jobs = deps.jobs ? deps.jobs(backgroundSync) : new BackgroundFetchJobs(backgroundSync);

  // --- Services -------------------------------------------------------------------------
  const auth = new AuthService({ repos, vault, auth: authClient, clock, jobs });
  const authState = createAuthStateStore(() => auth.state());
  const endSession = async (ended: SessionEnded | SessionEndedReason): Promise<void> => {
    try {
      await auth.onSessionEnded(ended);
    } finally {
      // Re-read even if saving failed, so the navigator reflects what is stored.
      await authState.refresh().catch(() => undefined);
    }
  };

  const calendar = createAuthorizedCalendarApi(auth.tokenProvider, transport);
  const holidayService = new HolidayService({
    repos,
    calendar,
    clock,
    ...(deps.holidayCountry ? { country: deps.holidayCountry } : {}),
  });
  const history = new HistoryReader({ repos, clock });
  const notifications = new NotificationService(repos, notifier, clock, {
    ...(apiLevel !== undefined ? { apiLevel } : {}),
    forecasts: createForecastProvider({ repos, clock, history, usage }),
  });
  const usageRisk = new UsageRiskService({ repos, usage, notifier, clock });
  sync = new SyncService({
    repos,
    clock,
    calendar,
    notifier,
    runtimeId,
    usageRisk,
    notifications,
    onSessionEnded: endSession,
  });
  const syncService = sync;

  // PlanningService wants `syncForeground()`; SyncService exposes `sync(trigger)`.
  const planningSync: PlanningSync = {
    async syncForeground() {
      const result = await syncService.sync('foreground');
      if (result.status === 'timed-out') throw new Error('Foreground sync timed out');
    },
  };
  const planning = new PlanningService({
    repos,
    clock,
    ids,
    notifications,
    sync: planningSync,
    flusher: syncService,
    history,
    holidays: holidayService,
  });
  const weekReset = new WeekResetService({ repos, clock, notifications, flusher: syncService });
  const settings = new SettingsService(repos);
  const aiProfile = new AiProfileService(repos, clock);
  // The id token comes from the in-memory provider; AI never ends the session (R35.2).
  const ai: AiPort = new AiClient({
    isEnabled: async () => (await settings.get()).aiEnabled === true,
    getIdToken: () => auth.getIdToken(),
    ...(deps.aiBaseUrl !== undefined ? { baseUrl: deps.aiBaseUrl } : {}),
    ...(deps.aiTransport ? { transport: deps.aiTransport } : {}),
  });
  const intake = new IntakeService<PlanResult>({
    repos,
    clock,
    ids,
    planner: planning,
    history,
    enhancer: createAiEnhancer(ai),
  });
  const blockActions = new BlockActionService({
    repos,
    clock,
    notifier,
    notifications,
    flusher: syncService,
    holidays: holidayService,
  });
  const review = new ReviewService({ repos, clock, usage });
  const sleepService = new SleepService({ repos, usage, clock, sleepSource });
  sleep = sleepService;
  const sleepData: AppServices['sleepData'] = {
    async status() {
      const [availability, permission] = await Promise.all([
        realSleep.availability(),
        realSleep.permission().catch(() => 'denied' as const),
      ]);
      return { availability, permission };
    },
    connect: () => realSleep.requestPermission(),
  };
  const rescore = async (): Promise<void> => {
    try {
      await sleepService.recordRecentNights();
    } catch {
      // Best effort; the next run retries.
    }
  };
  let demo: DemoPort | undefined;
  if (debugBuild) {
    const demoData = new DemoDataService({ repos, clock });
    const healthDemo = deps.healthDemo ?? new HealthDemoWriter();
    demo = {
      load: () => demoData.load(),
      async remove() {
        const removed = await demoData.remove();
        const healthRemoved = await healthDemo.deleteDemoSessions().catch(() => false as const);
        return { ...removed, healthRemoved };
      },
      async setUsage(enabled) {
        await demoData.setDemoUsage(enabled);
        if (enabled) await rescore();
      },
      isUsageEnabled: () => demoData.isDemoUsageEnabled(),
      async writeHealthSleep() {
        const sessions = demoSleepSessions(clock.now(), 14).map((s) => ({
          startMs: s.startMs,
          endMs: s.endMs,
          awakeMin: Math.max(0, Math.round((s.endMs - s.startMs) / 60_000 - s.asleepMin)),
        }));
        const written = await healthDemo.writeDemoSessions(sessions);
        if (written !== false) await rescore();
        return written;
      },
    };
  }
  const dashboard: AppServices['dashboard'] = {
    async load() {
      const weekId = review.currentWeekId();
      // Deadlines look at the current week and the next 3 (R27.2).
      const weekIds = [0, -1, -2, -3].map((n) => shiftWeekId(weekId, n));
      const [blocks, sleepScores, usageStatus, profile, weekBlocks, weekItems] = await Promise.all([
        repos.blocks.get(weekId),
        sleepService.scoresForWeek(weekId),
        usage.permission().then(
          (status): 'granted' | 'denied' | 'unknown' => (status === 'granted' || status === 'denied' ? status : 'unknown'),
          () => 'unknown' as const,
        ),
        repos.profile.get(),
        Promise.all(weekIds.map((w) => repos.blocks.get(w))),
        Promise.all(weekIds.map((w) => repos.items.get(w))),
      ]);
      return buildDashboard({
        deadlineBlocks: weekBlocks.flat(),
        deadlineItems: weekItems.flat(),
        now: clock.now(),
        weekId,
        blocks,
        sleepScores,
        usageStatus,
        givenName: profile.givenName,
      });
    },
  };

  const lifecycleAuth: LifecycleAuth = {
    isSignedIn: () => auth.isSignedIn(),
    onSessionEnded: endSession,
    restoreAfterTransportEnd: () => auth.restoreAfterTransportEnd(),
  };
  refreshHolidays = async () => {
    try {
      if (await auth.isSignedIn()) await holidayService.refreshIfStale();
    } catch {
      // Planning goes on without holidays; the next run retries.
    }
  };
  const baseLifecycle = new AppLifecycle({ auth: lifecycleAuth, notifications, sync: syncService, jobs });
  // Each step does its main work first, then scores recent nights (R19.1).
  const lifecycle: AppRuntime['lifecycle'] = {
    onLaunch: async () => {
      try {
        return await baseLifecycle.onLaunch();
      } finally {
        await refreshHolidays();
        await recordSleep();
      }
    },
    onForeground: async () => {
      try {
        return await baseLifecycle.onForeground();
      } finally {
        await refreshHolidays();
        await recordSleep();
      }
    },
  };

  const services: AppServices = {
    auth,
    authState,
    intake,
    planning,
    weekReset,
    sync: syncService,
    notifications,
    blockActions,
    review,
    dashboard,
    settings,
    ai,
    aiProfile,
    holidays: { summary: () => holidayService.summary() },
    repos,
    systemSettings,
    usage,
    notificationPermission: notifier,
    clock,
    sleepData,
    ...(demo ? { demo } : {}),
  };

  return {
    services,
    lifecycle,
    repos,
    auth,
    intake,
    planning,
    sync: syncService,
    notifications,
    usageRisk,
    blockActions,
    review,
    settings,
    ai,
    aiProfile,
    holidays: holidayService,
    sleep: sleepService,
    notifier,
    jobs,
    runtimeId,
    backgroundSync,
    endSession,
  };
}

let instance: AppRuntime | null = null;

/** The process-wide runtime shared by `App.tsx` and the headless tasks in `index.js`. */
export function getAppRuntime(): AppRuntime {
  if (!instance) instance = createAppRuntime();
  return instance;
}

/** Drop the memoized runtime (tests only). */
export function resetAppRuntimeForTests(): void {
  instance = null;
}
