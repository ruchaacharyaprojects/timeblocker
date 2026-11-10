/**
 * `AppServices`: the screen-facing services context (design: "Navigation and
 * screens"; composition root, task 25.1).
 *
 * Contract (stable for tasks 24.2-24.8 and 25.1):
 *
 * - Screens call {@link useAppServices} and use only the members below. Each
 *   member is a narrow interface picked from a real `@timeblocker/app-core`
 *   class or port, so the composition root passes the real instances
 *   unchanged (`auth: authService`, `settings: settingsService`, ...) and
 *   tests pass fakes from `./testServices` (`createTestServices()`).
 * - `authState` is the same {@link AuthStateStore} given to `RootNavigator`.
 *   Call `authState.refresh()` after `auth.signIn()` succeeds and after
 *   `auth.signOut()`, so the navigator swaps its route set.
 * - `intake.submit(raw, weekId)` validates, estimates, and plans in one step;
 *   its `plan.unplaced` (item ids) feeds `NothingFits { itemIds }`.
 * - `dashboard.load()` builds the Home screen's view for the current week. `planning.plan(weekId)` re-plans a week.
 * - The current Toronto week id is `review.currentWeekId()`.
 * - `repos` exposes read-only document readers for the view models
 *   (`buildWeekView`, `buildBlockDetail`, `buildSettingsView`). Screens never
 *   write documents directly; writes go through the services.
 * - `usage.permission()` and `notificationPermission.permission()` read the
 *   current permission without prompting (Settings rows, R11.12, R13.10).
 *   `notifications.ensurePermissionOnce()` is the only call that may prompt.
 * - `clock.now()` is the time source for view models (fake in tests).
 * - Nothing here exposes tokens: `auth` has no token accessor (R12.2).
 */
import React, { createContext, useContext } from 'react';
import type {
  AiPort,
  AiProfileService,
  AuthService,
  BlockActionService,
  CalendarCache,
  Clock,
  DashboardView,
  DeviceBlock,
  IntakeService,
  NotificationService,
  Notifier,
  OpenPrompt,
  PermissionState,
  PlanResult,
  PlanningService,
  Profile,
  ReviewService,
  SettingsService,
  SleepAvailability,
  SleepPermission,
  SyncService,
  SyncState,
  SystemSettings,
  UndoToken,
  UsageSource,
  WeekResetService,
} from '@timeblocker/app-core';
import type { IntakeItem } from '@timeblocker/flows';
import type { AuthStateStore } from '../navigation/authStateSource';

/**
 * Sign-in, sign-out, the persisted (token-free) auth state, and `reconnect`:
 * a one-time interactive Google re-authorization that keeps the session and
 * local data (cancel changes nothing).
 */
export type AuthPort = Pick<AuthService, 'signIn' | 'signOut' | 'state' | 'reconnect' | 'googleSub'>;

/** Intake draft, validation, and "Confirm & plan" (resolves with a {@link PlanResult}). */
export type IntakePort = Pick<IntakeService<PlanResult>, 'draft' | 'validate' | 'confirm' | 'submit'>;

/** Re-plan a week (the result shape `intake.confirm` also returns). */
export type PlanningPort = Pick<PlanningService, 'plan' | 'rollToNextWeek' | 'dropUnplaced'>;
/** Clear this week's unplaced and future scheduled tasks (R21.5). */
export type WeekResetPort = Pick<WeekResetService, 'clear'>;

/** Pull-to-refresh / foreground sync and the error banner (R14.2, R14.10). */
export type SyncPort = Pick<SyncService, 'sync' | 'dismissBanner'>;

/** Bell badges, exact-alarm state, and the one-time permission request (R13.9, R13.10). */
export type NotificationsPort = Pick<
  NotificationService,
  'indicators' | 'exactAlarmState' | 'refreshExactAlarmState' | 'ensurePermissionOnce'
>;

/** Block detail and NothingFits actions (R11.8, R11.9, R13.13, R2.3, R6.3, R8.1). */
export type BlockActionsPort = Pick<
  BlockActionService,
  'imIn' | 'skip' | 'moveIt' | 'changeLength' | 'setTiming' | 'answerPrompt' | 'undo' | 'resolveNothingFits' | 'saveNotes'
>;

/** Saturday review (R9.1-R9.4). */
export type ReviewPort = Pick<ReviewService, 'build' | 'get' | 'currentWeekId'>;

/** Planning mode, appearance, and distraction apps (R7.2, R11.11, R26.2). */
export type SettingsPort = Pick<
  SettingsService,
  'get' | 'setPlanningMode' | 'setThemeMode' | 'addDistractionApp' | 'removeDistractionApp' | 'setAiEnabled'
>;
/** "About me for applications", saved on the phone only (R34.2). */
export type AiProfilePort = Pick<AiProfileService, 'get' | 'save' | 'clear'>;

/** The holiday country and next holiday, read-only (R30.2). `null` until holidays are loaded. */
export interface HolidaysPort {
  summary(): Promise<{ country: string; next?: { name: string; date: string } } | null>;
}

/** A per-week document reader. */
export interface WeekReader<T> {
  get(weekId: string): Promise<T>;
}

/** A singleton document reader. */
export interface DocReader<T> {
  get(): Promise<T>;
}

/** Read-only document access for view models (structurally `Repositories`). */
export interface RepositoryReaders {
  blocks: WeekReader<DeviceBlock[]>;
  items: WeekReader<IntakeItem[]>;
  calendarCache: WeekReader<CalendarCache | null>;
  syncState: DocReader<SyncState>;
  undo: DocReader<UndoToken | null>;
  openPrompts: DocReader<OpenPrompt[]>;
  permissionState: DocReader<PermissionState>;
  profile: DocReader<Profile>;
}

/** The home dashboard's view model for the current week (R18). */
export interface DashboardPort {
  load(): Promise<DashboardView>;
}
/** Samsung Health sleep via Health Connect (R25.1). Reads the real source, never the demo wrapper. */
export interface SleepDataPort {
  status(): Promise<{ availability: SleepAvailability; permission: SleepPermission }>;
  /** Shows the Health Connect permission screen. */
  connect(): Promise<SleepPermission>;
}

/** Debug-build demo data (R24). `undefined` in release builds. */
export interface DemoPort {
  load(): Promise<{ blocks: number; nights: number; weeks: number }>;
  /** `healthRemoved` is the count of demo sessions removed from Health Connect, or false. */
  remove(): Promise<{ blocks: number; nights: number; healthRemoved: number | false }>;
  setUsage(enabled: boolean): Promise<void>;
  isUsageEnabled(): Promise<boolean>;
  /** Writes 14 demo nights to Health Connect; false when unavailable or not permitted. */
  writeHealthSleep(): Promise<number | false>;
}

export interface AppServices {
  auth: AuthPort;
  /** The store `RootNavigator` subscribes to; call `refresh()` after sign-in/out. */
  authState: AuthStateStore;
  intake: IntakePort;
  planning: PlanningPort;
  weekReset: WeekResetPort;
  sync: SyncPort;
  notifications: NotificationsPort;
  blockActions: BlockActionsPort;
  review: ReviewPort;
  dashboard: DashboardPort;
  settings: SettingsPort;
  /** The private AI service (R33-R35); every call is a no-op failure while disabled or unconfigured. */
  ai: AiPort;
  aiProfile: AiProfilePort;
  holidays: HolidaysPort;
  repos: RepositoryReaders;
  /** "Open settings" for usage access, notifications, and exact alarms. */
  systemSettings: SystemSettings;
  /** Usage-access permission, read without prompting. */
  usage: Pick<UsageSource, 'permission'>;
  /** Notification permission, read without prompting. */
  notificationPermission: Pick<Notifier, 'permission'>;
  clock: Clock;
  /** Health Connect sleep status and connect (Settings "Sleep data"). */
  sleepData: SleepDataPort;
  /** Debug builds only. */
  demo?: DemoPort;
}

const AppServicesContext = createContext<AppServices | null>(null);

export interface AppServicesProviderProps {
  services: AppServices;
  children?: React.ReactNode;
}

export function AppServicesProvider({ services, children }: AppServicesProviderProps): React.JSX.Element {
  return <AppServicesContext.Provider value={services}>{children}</AppServicesContext.Provider>;
}

/** The app services. Throws outside {@link AppServicesProvider}. */
export function useAppServices(): AppServices {
  const services = useContext(AppServicesContext);
  if (!services) throw new Error('useAppServices must be used inside AppServicesProvider');
  return services;
}
