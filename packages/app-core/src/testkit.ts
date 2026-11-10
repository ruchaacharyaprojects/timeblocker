/**
 * Test-only in-memory fakes for every app-core port (design: "Testing
 * strategy"). Not exported from the package index. They let services run
 * end to end under Node with no network, no native modules, and no timers.
 *
 * Conventions shared by the fakes:
 * - every fake records its calls so tests can assert on order and arguments;
 * - failures are injected explicitly (`failNext`, `failAll`, ...) and are
 *   consumed in FIFO order;
 * - a "hang" failure returns a promise that never settles, for timeout tests.
 */
import {
  CALENDAR_SCOPE,
  CalendarHttpError,
  colorIdForCategory,
  withBlockPrefix,
  type CalendarEvent,
  type OAuthTokens,
} from "@timeblocker/calendar-integration";
import type { Week } from "@timeblocker/scheduling-engine";
import type { AppUsageRecord, UsageWindow } from "@timeblocker/usage-metrics";
import {
  BASE32HEX_ALPHABET,
  isCalendarEventId,
  type AuthClient,
  type AuthGrant,
  type AuthResult,
  type BackgroundJobs,
  type CalendarApi,
  type CalendarBlockWrite,
  type Clock,
  type HttpMethod,
  type HttpResponse,
  type HttpTransport,
  type IdGenerator,
  type KeyValueStore,
  type NotificationPayload,
  type NotificationPermission,
  type Notifier,
  type RefreshResult,
  type SleepAvailability,
  type SleepPermission,
  type SleepSession,
  type SleepSource,
  type SystemSettings,
  type TokenVault,
  type UsagePermission,
  type UsageSource,
} from "./ports.js";

/** A promise that never settles (simulates a hung request). */
function never<T>(): Promise<T> {
  return new Promise<T>(() => {});
}

/** Error thrown by fakes to simulate a network/transport failure. */
export class FakeNetworkError extends Error {
  constructor(message = "Simulated network failure") {
    super(message);
    this.name = "FakeNetworkError";
  }
}

// --- KeyValueStore --------------------------------------------------------------

/** Map-backed {@link KeyValueStore}. `setMany` is all-or-nothing. */
export class MemoryKeyValueStore implements KeyValueStore {
  readonly data = new Map<string, string>();
  /** Number of write operations (`set`, `setMany`, `remove`) that succeeded. */
  writes = 0;
  private pendingWriteFailures: Error[] = [];

  constructor(initial: Readonly<Record<string, string>> = {}) {
    for (const [k, v] of Object.entries(initial)) this.data.set(k, v);
  }

  /** The next write operation throws `error` and changes nothing. */
  failNextWrite(error: Error = new Error("Simulated storage failure")): void {
    this.pendingWriteFailures.push(error);
  }

  /** A plain-object copy of the whole store. */
  snapshot(): Record<string, string> {
    return Object.fromEntries(this.data);
  }

  async get(key: string): Promise<string | null> {
    return this.data.get(key) ?? null;
  }

  async set(key: string, value: string): Promise<void> {
    this.checkWrite();
    this.data.set(key, value);
    this.writes += 1;
  }

  async getMany(
    keys: readonly string[],
  ): Promise<ReadonlyArray<readonly [key: string, value: string | null]>> {
    return keys.map((k) => [k, this.data.get(k) ?? null] as const);
  }

  async setMany(
    entries: ReadonlyArray<readonly [key: string, value: string]>,
  ): Promise<void> {
    this.checkWrite();
    for (const [k, v] of entries) this.data.set(k, v);
    this.writes += 1;
  }

  async remove(keys: readonly string[]): Promise<void> {
    this.checkWrite();
    for (const k of keys) this.data.delete(k);
    this.writes += 1;
  }

  private checkWrite(): void {
    const failure = this.pendingWriteFailures.shift();
    if (failure) throw failure;
  }
}

// --- TokenVault -----------------------------------------------------------------

/** In-memory {@link TokenVault} that counts saves and clears. */
export class FakeTokenVault implements TokenVault {
  current: OAuthTokens | null;
  saves = 0;
  clears = 0;
  loads = 0;

  constructor(initial: OAuthTokens | null = null) {
    this.current = initial ? { ...initial } : null;
  }

  async load(): Promise<OAuthTokens | null> {
    this.loads += 1;
    return this.current ? { ...this.current } : null;
  }

  async save(tokens: OAuthTokens): Promise<void> {
    this.current = { ...tokens };
    this.saves += 1;
  }

  async clear(): Promise<void> {
    this.current = null;
    this.clears += 1;
  }
}

/** Build {@link OAuthTokens} with the Calendar scope; override any field. */
export function makeTokens(overrides: Partial<OAuthTokens> = {}): OAuthTokens {
  return {
    accessToken: "access-0",
    refreshToken: "refresh-0",
    expiryDate: 3_600_000,
    scope: CALENDAR_SCOPE,
    tokenType: "Bearer",
    ...overrides,
  };
}

// --- AuthClient -------------------------------------------------------------------

/** Build an {@link AuthGrant} with the Calendar scope; override any field. */
export function makeGrant(overrides: Partial<AuthGrant> = {}): AuthGrant {
  return {
    accessToken: "access-1",
    refreshToken: "refresh-1",
    expiresAtMs: 3_600_000,
    tokenType: "Bearer",
    grantedScopes: [CALENDAR_SCOPE],
    ...overrides,
  };
}

type Scripted<T> = T | (() => T | Promise<T>);

async function resolveScripted<T>(s: Scripted<T>): Promise<T> {
  return typeof s === "function" ? (s as () => T | Promise<T>)() : s;
}

/**
 * Scriptable {@link AuthClient}. Queue results with `nextAuthorize` /
 * `nextRefresh` (a value or a function returning a value or promise, so tests
 * can hold a refresh open with a deferred). When a queue is empty:
 * `authorize` → `ok` with {@link makeGrant}; `refresh` → `ok` with a fresh
 * access token expiring one hour after the clock (no refresh token, as
 * Google usually omits it on refresh).
 */
export class ScriptableAuthClient implements AuthClient {
  authorizeCalls = 0;
  readonly refreshCalls: string[] = [];
  readonly revoked: string[] = [];
  private readonly authorizeQueue: Array<Scripted<AuthResult>> = [];
  private readonly refreshQueue: Array<Scripted<RefreshResult>> = [];
  private refreshCounter = 0;

  constructor(private readonly clock?: Clock) {}

  nextAuthorize(result: Scripted<AuthResult>): this {
    this.authorizeQueue.push(result);
    return this;
  }

  nextRefresh(result: Scripted<RefreshResult>): this {
    this.refreshQueue.push(result);
    return this;
  }

  async authorize(): Promise<AuthResult> {
    this.authorizeCalls += 1;
    const next = this.authorizeQueue.shift();
    return next === undefined
      ? { kind: "ok", grant: makeGrant() }
      : resolveScripted(next);
  }

  async refresh(refreshToken: string): Promise<RefreshResult> {
    this.refreshCalls.push(refreshToken);
    const next = this.refreshQueue.shift();
    if (next !== undefined) return resolveScripted(next);
    this.refreshCounter += 1;
    const { refreshToken: _omitted, ...grant } = makeGrant({
      accessToken: `refreshed-${this.refreshCounter}`,
      expiresAtMs: (this.clock?.now() ?? 0) + 3_600_000,
    });
    return { kind: "ok", grant };
  }

  async revoke(token: string): Promise<void> {
    this.revoked.push(token);
  }
}

// --- HttpTransport ------------------------------------------------------------------

export interface HttpRequestRecord {
  method: HttpMethod;
  url: string;
  headers: Readonly<Record<string, string>>;
  body: string | undefined;
  timeoutMs: number;
}

export type HttpResponder = (
  request: HttpRequestRecord,
) => HttpResponse | Promise<HttpResponse>;

/**
 * Recording {@link HttpTransport}. Responses come from the responder
 * (default `404` with an empty body). `failNext` throws, `hangNext` never
 * settles; both are consumed before the responder.
 */
export class FakeHttpTransport implements HttpTransport {
  readonly requests: HttpRequestRecord[] = [];
  private readonly overrides: Array<{ kind: "throw"; error: Error } | { kind: "hang" }> = [];

  constructor(
    private responder: HttpResponder = () => ({ status: 404, body: "" }),
  ) {}

  respondWith(responder: HttpResponder): void {
    this.responder = responder;
  }

  failNext(error: Error = new FakeNetworkError()): void {
    this.overrides.push({ kind: "throw", error });
  }

  hangNext(): void {
    this.overrides.push({ kind: "hang" });
  }

  async request(
    method: HttpMethod,
    url: string,
    headers: Readonly<Record<string, string>>,
    body: string | undefined,
    options: { timeoutMs: number },
  ): Promise<HttpResponse> {
    const record: HttpRequestRecord = {
      method,
      url,
      headers: { ...headers },
      body,
      timeoutMs: options.timeoutMs,
    };
    this.requests.push(record);
    const override = this.overrides.shift();
    if (override?.kind === "throw") throw override.error;
    if (override?.kind === "hang") return never();
    return this.responder(record);
  }
}

// --- CalendarApi ----------------------------------------------------------------------

export type CalendarOp = "readWeek" | "getEvent" | "upsertBlock" | "deleteBlock" | "readHolidays";
export const CALENDAR_WRITE_OPS: readonly CalendarOp[] = ["upsertBlock", "deleteBlock"];

/** How an injected calendar call fails. */
export type CalendarFailure =
  /** A non-2xx response, thrown as `CalendarHttpError(operation, status)`. */
  | { kind: "status"; status: number }
  /** A transport failure (thrown as {@link FakeNetworkError} or `error`). */
  | { kind: "network"; error?: Error }
  /** The call never settles (for timeout tests). */
  | { kind: "hang" };

export interface CalendarCallRecord {
  op: CalendarOp;
  /** Event id for `getEvent`/`deleteBlock`/`upsertBlock`; the week for `readWeek`. */
  target: string | Week;
  outcome: "ok" | "failed" | "lost" | "hung";
}

interface FailureRule {
  op: CalendarOp | "any";
  failure: CalendarFailure;
  remaining: number;
}

const HTTP_OPERATION: Record<CalendarOp, "get" | "insert" | "update" | "delete"> = {
  readWeek: "get",
  getEvent: "get",
  upsertBlock: "insert",
  deleteBlock: "delete",
  readHolidays: "get",
};

function overlapsWeek(event: CalendarEvent, week: Week): boolean {
  return (
    Date.parse(event.start) < Date.parse(week.saturday) &&
    Date.parse(event.end) > Date.parse(week.sunday)
  );
}

/**
 * In-memory Google Calendar behind {@link CalendarApi}, with a call log,
 * failure injection, and lost-response simulation.
 *
 * Semantics mirror `GoogleCalendarClient`:
 * - `upsertBlock` creates or overwrites the event under the client-chosen id
 *   (🧱 prefix, category color, `isBlock: true`); an id the user deleted in
 *   Calendar (`deleteRemotely`) returns `"deleted"`;
 * - `deleteBlock` succeeds whether or not the event exists;
 * - `getEvent` returns `"deleted"` for unknown or deleted ids;
 * - `readWeek` returns events overlapping the week (half-open), sorted by start.
 *
 * Injected failures (`failNext`, `failAll`) throw before any effect. A lost
 * response (`loseNextResponse`) applies the effect, then throws a network
 * error, as when a write reaches Google but the reply never arrives.
 */
export class FakeCalendar implements CalendarApi {
  readonly calls: CalendarCallRecord[] = [];
  private readonly store = new Map<string, CalendarEvent>();
  /** Holiday calendars by id (see {@link setHolidays}); unknown ids read as `[]` (404). */
  private readonly holidayCalendars = new Map<string, { date: string; name: string }[]>();
  private readonly deletedIds = new Set<string>();
  private readonly rules: FailureRule[] = [];
  private readonly lostResponses: Array<CalendarOp | "any"> = [];
  private failEverything: CalendarFailure | null = null;

  constructor(initial: readonly CalendarEvent[] = []) {
    for (const e of initial) this.addEvent(e);
  }

  // -- Test controls --

  /** Fail the next `count` calls of `op` (or of any op). */
  failNext(op: CalendarOp | "any", failure: CalendarFailure, count = 1): this {
    this.rules.push({ op, failure, remaining: count });
    return this;
  }

  /** Fail every call until {@link clearFailures}. */
  failAll(failure: CalendarFailure = { kind: "network" }): this {
    this.failEverything = failure;
    return this;
  }

  /** Remove all pending failures and lost responses. */
  clearFailures(): this {
    this.rules.length = 0;
    this.lostResponses.length = 0;
    this.failEverything = null;
    return this;
  }

  /** The next call of `op` (or any op) applies its effect, then throws. */
  loseNextResponse(op: CalendarOp | "any" = "any"): this {
    this.lostResponses.push(op);
    return this;
  }

  /** Add or replace an event as if created elsewhere (e.g. a meeting). */
  addEvent(event: CalendarEvent): void {
    this.deletedIds.delete(event.id);
    this.store.set(event.id, { ...event });
  }

  /** Define the all-day holidays of a (public holiday) calendar id. */
  setHolidays(calendarId: string, items: readonly { date: string; name: string }[]): this {
    this.holidayCalendars.set(calendarId, items.map((i) => ({ ...i })));
    return this;
  }
  /** The user deletes an event in Google Calendar. */
  deleteRemotely(eventId: string): void {
    this.store.delete(eventId);
    this.deletedIds.add(eventId);
  }

  /** The user moves an event in Google Calendar. */
  moveRemotely(eventId: string, start: string, end: string): void {
    const event = this.store.get(eventId);
    if (!event) throw new Error(`FakeCalendar: no event ${eventId}`);
    this.store.set(eventId, { ...event, start, end });
  }

  /** A copy of one stored event, or `undefined`. */
  event(eventId: string): CalendarEvent | undefined {
    const e = this.store.get(eventId);
    return e ? { ...e } : undefined;
  }

  /** Copies of all stored events, sorted by start then id. */
  events(): CalendarEvent[] {
    return [...this.store.values()]
      .map((e) => ({ ...e }))
      .sort((a, b) => Date.parse(a.start) - Date.parse(b.start) || a.id.localeCompare(b.id));
  }

  /** Copies of the stored 🧱 events. */
  blockEvents(): CalendarEvent[] {
    return this.events().filter((e) => e.isBlock === true);
  }

  /** Ops in call order, optionally only those with `outcome`. */
  opLog(outcome?: CalendarCallRecord["outcome"]): CalendarOp[] {
    return this.calls.filter((c) => !outcome || c.outcome === outcome).map((c) => c.op);
  }

  // -- CalendarApi --

  async readWeek(week: Week): Promise<CalendarEvent[]> {
    return this.run("readWeek", week, () =>
      this.events().filter((e) => overlapsWeek(e, week)),
    );
  }

  async getEvent(eventId: string): Promise<CalendarEvent | "deleted"> {
    return this.run("getEvent", eventId, () => this.event(eventId) ?? "deleted");
  }

  async upsertBlock(block: CalendarBlockWrite): Promise<string | "deleted"> {
    const id = block.calendarEventId;
    return this.run("upsertBlock", id, () => {
      if (!isCalendarEventId(id)) throw new CalendarHttpError("insert", 400);
      if (this.deletedIds.has(id)) return "deleted";
      this.store.set(id, {
        id,
        summary: withBlockPrefix(block.title),
        start: block.start,
        end: block.end,
        withOthers: false,
        colorId: colorIdForCategory(block.category),
        isBlock: true,
      });
      return id;
    });
  }

  /** Holidays whose date falls in [timeMin, timeMax) (by the date part of each bound). */
  async readHolidays(calendarId: string, timeMin: string, timeMax: string): Promise<{ date: string; name: string }[]> {
    return this.run("readHolidays", calendarId, () =>
      (this.holidayCalendars.get(calendarId) ?? [])
        .filter((h) => h.date >= timeMin.slice(0, 10) && h.date < timeMax.slice(0, 10))
        .map((h) => ({ ...h })),
    );
  }
  async deleteBlock(eventId: string): Promise<void> {
    return this.run("deleteBlock", eventId, () => {
      if (this.store.delete(eventId)) this.deletedIds.add(eventId);
    });
  }

  private async run<T>(op: CalendarOp, target: string | Week, effect: () => T): Promise<T> {
    const record: CalendarCallRecord = { op, target, outcome: "ok" };
    this.calls.push(record);
    const failure = this.takeFailure(op);
    if (failure) {
      if (failure.kind === "hang") {
        record.outcome = "hung";
        return never();
      }
      record.outcome = "failed";
      throw failure.kind === "status"
        ? new CalendarHttpError(HTTP_OPERATION[op], failure.status)
        : (failure.error ?? new FakeNetworkError());
    }
    const result = effect();
    const lostIdx = this.lostResponses.findIndex((o) => o === op || o === "any");
    if (lostIdx >= 0) {
      this.lostResponses.splice(lostIdx, 1);
      record.outcome = "lost";
      throw new FakeNetworkError(`Simulated lost response for ${op}`);
    }
    return result;
  }

  private takeFailure(op: CalendarOp): CalendarFailure | null {
    if (this.failEverything) return this.failEverything;
    const idx = this.rules.findIndex((r) => r.op === op || r.op === "any");
    if (idx < 0) return null;
    const rule = this.rules[idx]!;
    rule.remaining -= 1;
    if (rule.remaining <= 0) this.rules.splice(idx, 1);
    return rule.failure;
  }
}

// --- Notifier ---------------------------------------------------------------------------

export interface ScheduledNotification {
  notification: NotificationPayload;
  fireAtMs: number;
  exact: boolean;
}

/**
 * In-memory {@link Notifier}: a pending-alarm set, the currently posted
 * notifications, a history of everything shown, and permission/exact toggles.
 *
 * - `schedule` with the same id replaces the previous alarm; `exact: true`
 *   while exact alarms are not allowed throws (Android's SecurityException).
 * - `showNow` and firing alarms only post when permission is `granted`;
 *   otherwise the notification is recorded in `dropped`.
 * - `requestPermission` moves `undetermined` to `requestOutcome`; once
 *   decided it just returns the current state.
 */
export class FakeNotifier implements Notifier {
  readonly pending = new Map<string, ScheduledNotification>();
  readonly posted = new Map<string, NotificationPayload>();
  readonly shown: NotificationPayload[] = [];
  readonly dropped: NotificationPayload[] = [];
  readonly cancelled: string[] = [];
  permissionState: NotificationPermission;
  requestOutcome: NotificationPermission = "granted";
  exactAllowed: boolean;
  permissionRequests = 0;

  constructor(
    options: { permission?: NotificationPermission; exactAllowed?: boolean } = {},
  ) {
    this.permissionState = options.permission ?? "granted";
    this.exactAllowed = options.exactAllowed ?? true;
  }

  setPermission(permission: NotificationPermission): void {
    this.permissionState = permission;
  }

  setExactAllowed(allowed: boolean): void {
    this.exactAllowed = allowed;
  }

  /** Fire every pending alarm with `fireAtMs <= nowMs`, in fire-time order. */
  fireDue(nowMs: number): NotificationPayload[] {
    const due = [...this.pending.values()]
      .filter((s) => s.fireAtMs <= nowMs)
      .sort((a, b) => a.fireAtMs - b.fireAtMs);
    for (const s of due) {
      this.pending.delete(s.notification.id);
      this.post(s.notification);
    }
    return due.map((s) => s.notification);
  }

  async schedule(
    notification: NotificationPayload,
    fireAtMs: number,
    exact: boolean,
  ): Promise<void> {
    if (exact && !this.exactAllowed) {
      throw new Error("FakeNotifier: exact alarms are not allowed");
    }
    this.pending.set(notification.id, { notification, fireAtMs, exact });
  }

  async showNow(notification: NotificationPayload): Promise<void> {
    this.post(notification);
  }

  async cancel(id: string): Promise<void> {
    this.pending.delete(id);
    this.posted.delete(id);
    this.cancelled.push(id);
  }

  async listPending(): Promise<string[]> {
    return [...this.pending.keys()];
  }

  async permission(): Promise<NotificationPermission> {
    return this.permissionState;
  }

  async requestPermission(): Promise<NotificationPermission> {
    this.permissionRequests += 1;
    if (this.permissionState === "undetermined") {
      this.permissionState = this.requestOutcome;
    }
    return this.permissionState;
  }

  async canScheduleExact(): Promise<boolean> {
    return this.exactAllowed;
  }

  private post(notification: NotificationPayload): void {
    if (this.permissionState !== "granted") {
      this.dropped.push(notification);
      return;
    }
    this.posted.set(notification.id, notification);
    this.shown.push(notification);
  }
}

// --- Clock and ids ------------------------------------------------------------------------

/** Manually advanced {@link Clock}. */
export class FakeClock implements Clock {
  private ms: number;

  constructor(start: number | string = 0) {
    this.ms = typeof start === "string" ? Date.parse(start) : start;
    if (!Number.isFinite(this.ms)) throw new Error(`FakeClock: bad start ${start}`);
  }

  now(): number {
    return this.ms;
  }

  set(at: number | string): void {
    this.ms = typeof at === "string" ? Date.parse(at) : at;
  }

  advance(ms: number): void {
    this.ms += ms;
  }
}

/**
 * Deterministic {@link IdGenerator}: `next()` → `<prefix>-1`, `<prefix>-2`, ...;
 * `calendarEventId()` → `tb` + the counter in base32hex, zero-padded to 8
 * (e.g. `tb00000001`), always a valid Google event id.
 */
export class DeterministicIdGenerator implements IdGenerator {
  private localCount = 0;
  private eventCount = 0;

  constructor(private readonly prefix = "id") {}

  next(): string {
    this.localCount += 1;
    return `${this.prefix}-${this.localCount}`;
  }

  calendarEventId(): string {
    this.eventCount += 1;
    return `tb${toBase32Hex(this.eventCount).padStart(8, "0")}`;
  }
}

function toBase32Hex(n: number): string {
  let out = "";
  let v = n;
  do {
    out = BASE32HEX_ALPHABET[v % 32]! + out;
    v = Math.floor(v / 32);
  } while (v > 0);
  return out;
}

// --- Background jobs, usage, system settings ------------------------------------------------

/** Records periodic-sync start/stop. */
export class FakeBackgroundJobs implements BackgroundJobs {
  running = false;
  intervalMin: number | null = null;
  starts = 0;
  stops = 0;

  async startPeriodicSync(intervalMin: number): Promise<void> {
    this.running = true;
    this.intervalMin = intervalMin;
    this.starts += 1;
  }

  async stopPeriodicSync(): Promise<void> {
    this.running = false;
    this.stops += 1;
  }
}

/**
 * {@link UsageSource} returning fixed records (or a responder). Returns `[]`
 * when permission is denied, as the native module yields no data then.
 */
export class FakeUsageSource implements UsageSource {
  permissionState: UsagePermission;
  readonly reads: UsageWindow[] = [];
  private responder: (window: UsageWindow) => AppUsageRecord[];

  constructor(
    records: AppUsageRecord[] | ((window: UsageWindow) => AppUsageRecord[]) = [],
    permission: UsagePermission = "granted",
  ) {
    this.responder = typeof records === "function" ? records : () => records;
    this.permissionState = permission;
  }

  setRecords(records: AppUsageRecord[] | ((window: UsageWindow) => AppUsageRecord[])): void {
    this.responder = typeof records === "function" ? records : () => records;
  }

  async permission(): Promise<UsagePermission> {
    return this.permissionState;
  }

  async readUsage(window: UsageWindow): Promise<AppUsageRecord[]> {
    this.reads.push({ ...window });
    if (this.permissionState !== "granted") return [];
    return this.responder(window).map((r) => ({ ...r }));
  }
}

/**
 * {@link SleepSource} returning fixed sessions (or a responder). Records every
 * window read; `failReads` makes `readSessions` throw.
 */
export class FakeSleepSource implements SleepSource {
  availabilityState: SleepAvailability;
  permissionState: SleepPermission;
  failReads = false;
  readonly reads: UsageWindow[] = [];
  private responder: (window: UsageWindow) => SleepSession[];
  constructor(
    sessions: SleepSession[] | ((window: UsageWindow) => SleepSession[]) = [],
    permission: SleepPermission = "granted",
    availability: SleepAvailability = "available",
  ) {
    this.responder = typeof sessions === "function" ? sessions : () => sessions;
    this.permissionState = permission;
    this.availabilityState = availability;
  }
  setSessions(sessions: SleepSession[] | ((window: UsageWindow) => SleepSession[])): void {
    this.responder = typeof sessions === "function" ? sessions : () => sessions;
  }
  async availability(): Promise<SleepAvailability> {
    return this.availabilityState;
  }
  async permission(): Promise<SleepPermission> {
    return this.permissionState;
  }
  async requestPermission(): Promise<SleepPermission> {
    return this.permissionState;
  }
  async readSessions(window: UsageWindow): Promise<SleepSession[]> {
    this.reads.push({ ...window });
    if (this.failReads) throw new Error("Simulated Health Connect failure");
    return this.responder(window).map((s) => ({ ...s }));
  }
}

export type SettingsScreen = "usage-access" | "notifications" | "exact-alarms";

/** Records which system settings screens were opened. */
export class FakeSystemSettings implements SystemSettings {
  readonly opened: SettingsScreen[] = [];

  async openUsageAccess(): Promise<void> {
    this.opened.push("usage-access");
  }

  async openNotificationSettings(): Promise<void> {
    this.opened.push("notifications");
  }

  async openExactAlarmSettings(): Promise<void> {
    this.opened.push("exact-alarms");
  }
}
