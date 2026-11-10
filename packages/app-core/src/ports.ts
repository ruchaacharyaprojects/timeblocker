/**
 * Ports: the only way app-core touches the outside world.
 *
 * Every port is implemented by a thin adapter in `@timeblocker/mobile`
 * (AsyncStorage, Keychain, AppAuth, the TimeBlockerAlarms native module,
 * BackgroundFetch, fetch) and by an in-memory fake in `testkit.ts`, so all
 * app logic runs and is tested under Node. Nothing here imports
 * `react-native` or any native library (R12.6, R12.8).
 */
import type {
  CalendarEvent,
  OAuthTokens,
  SoloBlock,
} from "@timeblocker/calendar-integration";
import type { Week } from "@timeblocker/scheduling-engine";
import type {
  AppUsageRecord,
  UsageWindow,
} from "@timeblocker/usage-metrics";
import type {
  AiResult,
  ApplicationHelpRequest,
  ApplicationHelpResponse,
  ParseTasksItem,
} from "./ai/contract.js";
import type { RegistryKind } from "./models.js";

// --- Local persistence -----------------------------------------------------

/**
 * A string key/value store holding JSON documents (adapter: AsyncStorage
 * instance "timeblocker", with a per-key mutex). Nothing stored here is
 * secret; tokens live only in the {@link TokenVault}.
 */
export interface KeyValueStore {
  /** The stored string, or `null` when the key is absent. */
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  /** Values for each key, in the order requested; `null` when absent. */
  getMany(
    keys: readonly string[],
  ): Promise<ReadonlyArray<readonly [key: string, value: string | null]>>;
  /** Write several documents together (for example a block + its outbox). */
  setMany(
    entries: ReadonlyArray<readonly [key: string, value: string]>,
  ): Promise<void>;
  remove(keys: readonly string[]): Promise<void>;
}

// --- Auth -------------------------------------------------------------------

/**
 * Keystore-backed storage for the Google OAuth tokens (adapter:
 * react-native-keychain, service "timeblocker.google"). The only place tokens
 * are ever persisted (R12.2).
 */
export interface TokenVault {
  load(): Promise<OAuthTokens | null>;
  save(tokens: OAuthTokens): Promise<void>;
  clear(): Promise<void>;
}

/** Tokens and scopes as returned by an authorization or refresh. */
export interface AuthGrant {
  accessToken: string;
  /**
   * Present on the initial authorization; on refresh Google may omit it, in
   * which case the existing refresh token is carried forward.
   */
  refreshToken?: string;
  /** Absolute access-token expiry, epoch ms. */
  expiresAtMs: number;
  tokenType: string;
  /** The scopes Google actually granted (granular consent may drop some). */
  grantedScopes: readonly string[];
  /**
   * OpenID Connect id token (JWT) from the initial authorization, when the
   * `openid`/`profile` scopes were granted. Display-only; never stored in the
   * vault (R18.2).
   */
  idToken?: string;
}

/** Outcome of the interactive sign-in (R11.2, R11.3, R12.1, R12.11). */
export type AuthResult =
  | { kind: "ok"; grant: AuthGrant }
  /** The user closed the browser / Custom Tab. */
  | { kind: "cancelled" }
  /** The user declined consent on Google's screen. */
  | { kind: "denied" }
  /** Any other authorization failure. */
  | { kind: "error"; message?: string };

/** Outcome of a refresh-token exchange (R12.4, R12.5). */
export type RefreshResult =
  | { kind: "ok"; grant: AuthGrant }
  /** Google rejected the refresh token (`invalid_grant`): clear the vault. */
  | { kind: "invalid-grant" }
  /** The request failed in transit: keep the vault. */
  | { kind: "transport-error"; message?: string };

/**
 * Google OAuth on device (adapter: react-native-app-auth, PKCE, Android
 * client, no client secret).
 */
export interface AuthClient {
  authorize(): Promise<AuthResult>;
  refresh(refreshToken: string): Promise<RefreshResult>;
  revoke(token: string): Promise<void>;
}

// --- HTTP -------------------------------------------------------------------

export type HttpMethod = "GET" | "POST" | "PUT" | "DELETE";

export interface HttpResponse {
  status: number;
  /** Raw response text (empty string when there is no body). */
  body: string;
}

/**
 * Raw HTTP (adapter: fetch + AbortController). Always wrapped by
 * `GoogleOnlyHttp`, which refuses every non-Google destination (R12.3).
 */
export interface HttpTransport {
  request(
    method: HttpMethod,
    url: string,
    headers: Readonly<Record<string, string>>,
    body: string | undefined,
    options: { timeoutMs: number },
  ): Promise<HttpResponse>;
}

// --- Calendar ---------------------------------------------------------------

/** A block write: the client-chosen Google event id is mandatory (R14.8). */
export type CalendarBlockWrite = SoloBlock & { calendarEventId: string };

/**
 * The narrow slice of `GoogleCalendarClient` app-core uses, so tests can swap
 * in an in-memory fake calendar. Return types match the client exactly; non-2xx
 * responses surface as `CalendarHttpError(operation, status)`.
 */
export interface CalendarApi {
  /** All events overlapping the week (paginated, cancelled dropped). */
  readWeek(week: Week): Promise<CalendarEvent[]>;
  /** One event, or `"deleted"` for `404`/`410`/`status: "cancelled"`. */
  getEvent(eventId: string): Promise<CalendarEvent | "deleted">;
  /**
   * POST with the client id, `409` → PUT. Returns the event id, or
   * `"deleted"` when the PUT gets `404`/`410` (deleted in Calendar).
   */
  upsertBlock(block: CalendarBlockWrite): Promise<string | "deleted">;
  /** DELETE; `404`/`410` count as success. */
  deleteBlock(eventId: string): Promise<void>;
  /**
   * All-day events of another calendar (a public holiday calendar) as dates;
   * multi-day events expand to every date. `404`/`403` give `[]`; other
   * failures throw. Optional only so sync-side test doubles need not
   * implement it; every real implementation and `FakeCalendar` does.
   */
  readHolidays?(calendarId: string, timeMin: string, timeMax: string): Promise<{ date: string; name: string }[]>;
}

// --- Notifications ------------------------------------------------------------

/** Android notification channels created by TimeBlockerAlarms. */
export type NotificationChannel = "reminders" | "prompts" | "status" | "nudges";

/** An action button on a notification. */
export interface NotificationAction {
  /** Stable id passed back on tap (e.g. "im-in", "skip", "move-it", "yes", "no", "undo"). */
  id: string;
  label: string;
}

/** Everything the native side needs to post a notification without JS. */
export interface NotificationPayload {
  /** Stable string id; scheduling the same id replaces the previous alarm. */
  id: string;
  kind: RegistryKind;
  channel: NotificationChannel;
  title: string;
  body: string;
  actions: readonly NotificationAction[];
  /** The block or event id the notification is about. */
  sourceId: string;
  weekId?: string;
  /** Body-tap deep link (e.g. `timeblocker://block/<id>`). */
  deepLink?: string;
  /** Auto-dismiss after this many ms (the Undo status notification). */
  timeoutMs?: number;
}

export type NotificationPermission = "granted" | "denied" | "undetermined";

/** Local notifications (adapter: TimeBlockerAlarms native module). */
export interface Notifier {
  schedule(
    notification: NotificationPayload,
    fireAtMs: number,
    exact: boolean,
  ): Promise<void>;
  showNow(notification: NotificationPayload): Promise<void>;
  /** Cancels both the alarm and any posted notification for `id`. */
  cancel(id: string): Promise<void>;
  /** Ids of alarms that are armed and have not fired yet. */
  listPending(): Promise<string[]>;
  permission(): Promise<NotificationPermission>;
  requestPermission(): Promise<NotificationPermission>;
  canScheduleExact(): Promise<boolean>;
}

// --- Usage, background work, system settings --------------------------------

// --- Health sleep data (Samsung Health via Health Connect, R25) ------------------
/** One sleep session, reduced to what the sleep score needs (no stages, no vitals). */
export interface SleepSession {
  startMs: number;
  endMs: number;
  /** Minutes asleep: session length minus awake stages when stages exist. */
  asleepMin: number;
}
export type SleepAvailability = "available" | "needs-install" | "unsupported";
export type SleepPermission = "granted" | "denied";
/** Reads sleep sessions from Android Health Connect. Never throws for "no data". */
export interface SleepSource {
  availability(): Promise<SleepAvailability>;
  permission(): Promise<SleepPermission>;
  /** Shows the Health Connect permission screen; resolves with the outcome. */
  requestPermission(): Promise<SleepPermission>;
  /** Sessions overlapping [startMs, endMs), oldest first. */
  readSessions(window: UsageWindow): Promise<SleepSession[]>;
}

export type UsagePermission = "granted" | "denied";

/** On-device usage (adapter: existing UsageMetrics native module). Raw records never leave the device (R12.9). */
export interface UsageSource {
  permission(): Promise<UsagePermission>;
  readUsage(window: UsageWindow): Promise<AppUsageRecord[]>;
}

/** Periodic background sync (adapter: react-native-background-fetch). */
export interface BackgroundJobs {
  startPeriodicSync(intervalMin: number): Promise<void>;
  stopPeriodicSync(): Promise<void>;
}

/** Deep links into Android system settings screens. */
export interface SystemSettings {
  openUsageAccess(): Promise<void>;
  openNotificationSettings(): Promise<void>;
  openExactAlarmSettings(): Promise<void>;
}

// --- Time and ids -------------------------------------------------------------

export interface Clock {
  /** Current time, epoch ms. */
  now(): number;
}

export interface IdGenerator {
  /** A new unique local id (items, blocks, prompts). */
  next(): string;
  /**
   * A new Google Calendar event id: base32hex (`a-v`, `0-9`), 5-1024 chars,
   * which Google accepts on insert (R14.8). See {@link isCalendarEventId}.
   */
  calendarEventId(): string;
}

/** Characters Google allows in a client-chosen event id (base32hex, lowercase). */
export const BASE32HEX_ALPHABET = "0123456789abcdefghijklmnopqrstuv";

const CALENDAR_EVENT_ID_PATTERN = /^[0-9a-v]{5,1024}$/;

/** True when `id` is a valid client-chosen Google Calendar event id. */
export function isCalendarEventId(id: string): boolean {
  return CALENDAR_EVENT_ID_PATTERN.test(id);
}

// --- AI assistant -----------------------------------------------------------

/**
 * Why AI is or is not usable right now: `ready`, switched `disabled` in
 * settings, or `not-configured` (no service address in the build config).
 */
export type AiAvailability = "ready" | "disabled" | "not-configured";

/**
 * The private AI service (R33-R35, D28). Adapter: `AiClient` (mobile).
 * Never throws for expected failures; sends nothing unless the assistant is
 * enabled and configured.
 */
export interface AiPort {
  /** Cheap local check (no network): enabled in settings and configured. */
  availability(): Promise<AiAvailability>;
  /** Category + kind for each title (R33.1); one result per title, in order. */
  parseTasks(titles: readonly string[]): Promise<AiResult<ParseTasksItem[]>>;
  /** Talking points, email draft or study steps (R34). */
  applicationHelp(request: ApplicationHelpRequest): Promise<AiResult<ApplicationHelpResponse>>;
}
