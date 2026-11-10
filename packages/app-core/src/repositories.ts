/**
 * Repositories over the {@link KeyValueStore} port, following the design's
 * "Local persistence" key schema.
 *
 * Every document is stored as JSON in an envelope with a top-level
 * `schemaVersion` key (`{ "schemaVersion": 1, "data": ... }`), and the store
 * also holds a `schemaVersion` key with value `1`. A document that is absent,
 * unparseable, has an unknown `schemaVersion`, or has the wrong shape reads
 * as its default and reports a non-sensitive diagnostic (key + reason only).
 *
 * Writes that must land together (for example a block plus its outbox entry)
 * are built as {@link DocWrite}s and committed with one `setMany`
 * ({@link Repositories.commit}). Nothing here ever stores tokens (R12.2).
 */
import type { IntakeItem, WeeklyReview } from "@timeblocker/flows";
import type { PlanningMode } from "@timeblocker/scheduling-engine";
import {
  SCHEMA_VERSION,
  type AuthState,
  type AiProfile,
  MAX_AI_BACKGROUND_CHARS,
  type CalendarCache,
  type DemoMode,
  type HolidayCache,
  type DeviceBlock,
  type DeviceSettings,
  type IntakeDraft,
  type OpenPrompt,
  type PendingWrite,
  type PermissionState,
  type Profile,
  type RegistryEntry,
  type SleepScoreMap,
  type SyncState,
  type UndoToken,
} from "./models.js";
import type { KeyValueStore } from "./ports.js";

// --- Keys -----------------------------------------------------------------------

/** The design's key schema. */
export const KEYS = {
  schemaVersion: "schemaVersion",
  items: (weekId: string) => `items:${weekId}`,
  intakeDraft: "intakeDraft",
  blocks: (weekId: string) => `blocks:${weekId}`,
  settings: "settings",
  reviews: (weekId: string) => `reviews:${weekId}`,
  outbox: "outbox",
  calendarCache: (weekId: string) => `calendarCache:${weekId}`,
  notifRegistry: "notifRegistry",
  openPrompts: "openPrompts",
  undo: "undo",
  syncState: "syncState",
  authState: "authState",
  permissionState: "permissionState",
  profile: "profile",
  sleepScores: "sleepScores",
  demoMode: "demoMode",
  holidays: "holidays",
  aiProfile: "aiProfile",
} as const;

// --- Defaults ---------------------------------------------------------------------

export const PLANNING_MODES: readonly PlanningMode[] = ["earliest-fit", "spread"];

/** Settings default: exactly one planning mode (R11.11). */
export const DEFAULT_DEVICE_SETTINGS: Readonly<DeviceSettings> = Object.freeze({
  planningMode: "spread",
  holidays: [],
  distractionApps: [],
});

export const DEFAULT_AUTH_STATE: Readonly<AuthState> = Object.freeze({
  status: "signed-out",
});

export const DEFAULT_PERMISSION_STATE: Readonly<PermissionState> = Object.freeze({
  notificationsRequested: false,
  exactAlarmsAvailable: false,
});

// --- Envelope and codecs ------------------------------------------------------------

/** One document write; commit several together with {@link Repositories.commit}. */
export interface DocWrite {
  readonly key: string;
  readonly value: string;
}

/** Non-sensitive diagnostic for a document that read as its default. */
export interface CorruptDocument {
  key: string;
  reason: "unparseable" | "unknown-schema-version" | "invalid-shape";
}

export type DiagnosticSink = (diagnostic: CorruptDocument) => void;

/** Validates and normalizes decoded data; returns `undefined` when invalid. */
type Validator<T> = (data: unknown) => T | undefined;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === "string");
}

function arrayOf<T>(isItem: (v: unknown) => boolean): Validator<T[]> {
  return (data) =>
    Array.isArray(data) && data.every(isItem) ? (data as T[]) : undefined;
}

function recordWith<T>(check: (r: Record<string, unknown>) => boolean): Validator<T> {
  return (data) => (isRecord(data) && check(data) ? (data as T) : undefined);
}

function nullable<T>(inner: Validator<T>): Validator<T | null> {
  return (data) => (data === null ? null : inner(data));
}

const validateSettings: Validator<DeviceSettings> = (data) => {
  if (!isRecord(data)) return undefined;
  const { planningMode, holidays, distractionApps } = data;
  if (!PLANNING_MODES.includes(planningMode as PlanningMode)) return undefined;
  if (!isStringArray(holidays) || !isStringArray(distractionApps)) return undefined;
  const { themeMode, planningModeSetByUser, aiEnabled } = data;
  if (aiEnabled !== undefined && typeof aiEnabled !== "boolean") return undefined;
  if (themeMode !== undefined && themeMode !== "system" && themeMode !== "light" && themeMode !== "dark") {
    return undefined;
  }
  if (planningModeSetByUser !== undefined && typeof planningModeSetByUser !== "boolean") return undefined;
  return {
    // R30.1: "spread" unless the user picked a mode themselves.
    planningMode: planningModeSetByUser === true ? (planningMode as PlanningMode) : "spread",
    holidays: [...holidays],
    distractionApps: [...distractionApps],
    ...(themeMode !== undefined ? { themeMode } : {}),
    ...(planningModeSetByUser !== undefined ? { planningModeSetByUser } : {}),
    ...(aiEnabled !== undefined ? { aiEnabled } : {}),
  };
};

const validateAiProfile: Validator<AiProfile | null> = nullable((data): AiProfile | undefined => {
  if (!isRecord(data) || typeof data.background !== "string" || typeof data.updatedAt !== "number") {
    return undefined;
  }
  return {
    background: data.background.slice(0, MAX_AI_BACKGROUND_CHARS),
    updatedAt: data.updatedAt,
  };
});

const AUTH_STATUSES = ["signed-out", "signed-in", "session-ended"];

const validateAuthState = recordWith<AuthState>((r) =>
  AUTH_STATUSES.includes(r.status as string),
);

const validatePermissionState = recordWith<PermissionState>(
  (r) =>
    typeof r.notificationsRequested === "boolean" &&
    typeof r.exactAlarmsAvailable === "boolean",
);

const validateProfile: Validator<Profile> = (data) => {
  if (!isRecord(data) || typeof data.updatedAt !== "number") return undefined;
  if (data.givenName !== undefined && typeof data.givenName !== "string") return undefined;
  return {
    updatedAt: data.updatedAt,
    ...(typeof data.givenName === "string" ? { givenName: data.givenName } : {}),
  };
};

const validateSleepScores: Validator<SleepScoreMap> = (data) => {
  if (!isRecord(data)) return undefined;
  const out: SleepScoreMap = {};
  for (const [key, v] of Object.entries(data)) {
    if (
      !isRecord(v) ||
      v.dateKey !== key ||
      typeof v.usageMin !== "number" ||
      typeof v.score !== "number" ||
      typeof v.scoredAt !== "number" ||
      (v.asleepMin !== undefined && typeof v.asleepMin !== "number") ||
      (v.source !== undefined && v.source !== "usage" && v.source !== "health+usage") ||
      (v.demo !== undefined && typeof v.demo !== "boolean")
    ) {
      return undefined;
    }
    // Entries stored before R25 have no `source`: they are usage-only.
    out[key] = {
      dateKey: key,
      usageMin: v.usageMin,
      ...(typeof v.asleepMin === "number" ? { asleepMin: v.asleepMin } : {}),
      score: v.score,
      scoredAt: v.scoredAt,
      source: v.source === "health+usage" ? "health+usage" : "usage",
      ...(v.demo === true ? { demo: true } : {}),
    };
  }
  return out;
};

const validateHolidays: Validator<HolidayCache | null> = nullable((data): HolidayCache | undefined => {
  if (
    !isRecord(data) ||
    typeof data.country !== "string" ||
    typeof data.fetchedAt !== "number" ||
    !Array.isArray(data.items)
  ) {
    return undefined;
  }
  const items: HolidayCache["items"] = [];
  for (const i of data.items) {
    if (!isRecord(i) || typeof i.date !== "string" || typeof i.name !== "string") return undefined;
    items.push({ date: i.date, name: i.name });
  }
  return { country: data.country, fetchedAt: data.fetchedAt, items };
});

const validateDemoMode: Validator<DemoMode | null> = nullable(
  (data): DemoMode | undefined => {
    if (
      !isRecord(data) ||
      typeof data.loadedAt !== "number" ||
      !isStringArray(data.blockWeeks) ||
      typeof data.demoUsage !== "boolean" ||
      typeof data.addedDistractionApps !== "boolean"
    ) {
      return undefined;
    }
    return {
      loadedAt: data.loadedAt,
      blockWeeks: [...data.blockWeeks],
      demoUsage: data.demoUsage,
      addedDistractionApps: data.addedDistractionApps,
    };
  },
);

const hasId = (v: unknown) => isRecord(v) && typeof v.id === "string";
const hasBlockId = (v: unknown) => isRecord(v) && typeof v.blockId === "string";

const validateOutboxEntry = (v: unknown) =>
  isRecord(v) &&
  typeof v.blockId === "string" &&
  typeof v.calendarEventId === "string" &&
  (v.op === "upsert" || v.op === "delete");

/** Encode a document in the versioned envelope. */
export function encodeDocument(data: unknown): string {
  return JSON.stringify({ schemaVersion: SCHEMA_VERSION, data });
}

/**
 * Decode a stored document, returning `fallback()` (and reporting a
 * diagnostic) when it is unparseable, has an unknown `schemaVersion`, or fails
 * validation. An absent value returns the default silently.
 */
export function decodeDocument<T>(
  key: string,
  raw: string | null,
  validate: Validator<T>,
  fallback: () => T,
  onCorrupt?: DiagnosticSink,
): T {
  if (raw === null) return fallback();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    onCorrupt?.({ key, reason: "unparseable" });
    return fallback();
  }
  if (!isRecord(parsed) || parsed.schemaVersion !== SCHEMA_VERSION) {
    onCorrupt?.({ key, reason: "unknown-schema-version" });
    return fallback();
  }
  const value = validate(parsed.data);
  if (value === undefined) {
    onCorrupt?.({ key, reason: "invalid-shape" });
    return fallback();
  }
  return value;
}

// --- Generic document repository -------------------------------------------------------

/** One key-addressed document type. */
export class DocumentRepository<T> {
  constructor(
    private readonly kv: KeyValueStore,
    private readonly validate: Validator<T>,
    private readonly fallback: () => T,
    private readonly onCorrupt?: DiagnosticSink,
  ) {}

  async read(key: string): Promise<T> {
    return this.decode(key, await this.kv.get(key));
  }

  /** Decode a raw value fetched elsewhere (e.g. via `getMany`). */
  decode(key: string, raw: string | null): T {
    return decodeDocument(key, raw, this.validate, this.fallback, this.onCorrupt);
  }

  /** Build a write for {@link Repositories.commit}. */
  write(key: string, value: T): DocWrite {
    return { key, value: encodeDocument(value) };
  }
}

/** A document stored under one fixed key. */
export class SingletonRepository<T> {
  constructor(
    private readonly doc: DocumentRepository<T>,
    private readonly key: string,
    private readonly commitFn: (writes: readonly DocWrite[]) => Promise<void>,
  ) {}

  get(): Promise<T> {
    return this.doc.read(this.key);
  }

  write(value: T): DocWrite {
    return this.doc.write(this.key, value);
  }

  save(value: T): Promise<void> {
    return this.commitFn([this.write(value)]);
  }
}

/** A document stored per week (`<prefix>:<weekId>`). */
export class WeekRepository<T> {
  constructor(
    private readonly doc: DocumentRepository<T>,
    private readonly keyOf: (weekId: string) => string,
    private readonly commitFn: (writes: readonly DocWrite[]) => Promise<void>,
  ) {}

  get(weekId: string): Promise<T> {
    return this.doc.read(this.keyOf(weekId));
  }

  write(weekId: string, value: T): DocWrite {
    return this.doc.write(this.keyOf(weekId), value);
  }

  save(weekId: string, value: T): Promise<void> {
    return this.commitFn([this.write(weekId, value)]);
  }
}

// --- Outbox coalescing ------------------------------------------------------------------

/** A write to enqueue; `attempts`/`lastError` start fresh. */
export interface OutboxRequest {
  blockId: string;
  calendarEventId: string;
  op: PendingWrite["op"];
  /** epoch ms */
  enqueuedAt: number;
}

/**
 * Add `request` to `outbox`, coalesced per block: at most one entry per
 * `blockId`, and the latest local state wins (R14.10). A replaced entry keeps
 * its queue position and original `enqueuedAt`; its op and event id take the
 * new values and `attempts`/`lastError` reset. Pure; returns a new array.
 */
export function coalesceOutbox(
  outbox: readonly PendingWrite[],
  request: OutboxRequest,
): PendingWrite[] {
  const index = outbox.findIndex((w) => w.blockId === request.blockId);
  if (index === -1) {
    return [...outbox, { ...request, attempts: 0 }];
  }
  const existing = outbox[index]!;
  const merged: PendingWrite = {
    blockId: request.blockId,
    calendarEventId: request.calendarEventId,
    op: request.op,
    attempts: 0,
    enqueuedAt: existing.enqueuedAt,
  };
  return outbox.map((w, i) => (i === index ? merged : w));
}

export class OutboxRepository extends SingletonRepository<PendingWrite[]> {
  /** Read, coalesce `requests` in order, and save. */
  async enqueue(...requests: OutboxRequest[]): Promise<PendingWrite[]> {
    const next = requests.reduce(coalesceOutbox, await this.get());
    await this.save(next);
    return next;
  }

  /** Drop the entry for `blockId` (after a successful flush). */
  async removeBlock(blockId: string): Promise<void> {
    const current = await this.get();
    await this.save(current.filter((w) => w.blockId !== blockId));
  }
}

// --- Repositories -------------------------------------------------------------------------

export interface RepositoriesOptions {
  /** Receives a non-sensitive diagnostic when a document reads as its default. */
  onCorrupt?: DiagnosticSink;
}

/** All on-device repositories over one {@link KeyValueStore}. */
export class Repositories {
  readonly items: WeekRepository<IntakeItem[]>;
  readonly intakeDraft: SingletonRepository<IntakeDraft | null>;
  readonly blocks: WeekRepository<DeviceBlock[]>;
  readonly settings: SingletonRepository<DeviceSettings>;
  readonly reviews: WeekRepository<WeeklyReview | null>;
  readonly outbox: OutboxRepository;
  readonly calendarCache: WeekRepository<CalendarCache | null>;
  readonly notifRegistry: SingletonRepository<RegistryEntry[]>;
  readonly openPrompts: SingletonRepository<OpenPrompt[]>;
  readonly undo: SingletonRepository<UndoToken | null>;
  readonly syncState: SingletonRepository<SyncState>;
  readonly authState: SingletonRepository<AuthState>;
  readonly permissionState: SingletonRepository<PermissionState>;
  readonly profile: SingletonRepository<Profile>;
  readonly sleepScores: SingletonRepository<SleepScoreMap>;
  /** Demo-data bookkeeping (R24); `null` when no demo data is loaded. */
  readonly demoMode: SingletonRepository<DemoMode | null>;
  /** Cached public holidays (R30.2); `null` until first fetched. */
  readonly holidays: SingletonRepository<HolidayCache | null>;
  /** "About me for applications" text, phone-only (R34.2); `null` when unset. */
  readonly aiProfile: SingletonRepository<AiProfile | null>;

  constructor(
    private readonly kv: KeyValueStore,
    options: RepositoriesOptions = {},
  ) {
    const onCorrupt = options.onCorrupt;
    const commit = (writes: readonly DocWrite[]) => this.commit(writes);
    const doc = <T>(validate: Validator<T>, fallback: () => T) =>
      new DocumentRepository<T>(kv, validate, fallback, onCorrupt);

    this.items = new WeekRepository(
      doc(arrayOf<IntakeItem>(hasId), () => []),
      KEYS.items,
      commit,
    );
    this.intakeDraft = new SingletonRepository(
      doc(
        nullable(recordWith<IntakeDraft>((r) => typeof r.text === "string")),
        () => null,
      ),
      KEYS.intakeDraft,
      commit,
    );
    this.blocks = new WeekRepository(
      doc(arrayOf<DeviceBlock>(hasId), () => []),
      KEYS.blocks,
      commit,
    );
    this.settings = new SingletonRepository(
      doc(validateSettings, () => ({
        ...DEFAULT_DEVICE_SETTINGS,
        holidays: [],
        distractionApps: [],
      })),
      KEYS.settings,
      commit,
    );
    this.reviews = new WeekRepository(
      doc(
        nullable(recordWith<WeeklyReview>((r) => typeof r.weekId === "string")),
        () => null,
      ),
      KEYS.reviews,
      commit,
    );
    this.outbox = new OutboxRepository(
      doc(arrayOf<PendingWrite>(validateOutboxEntry), () => []),
      KEYS.outbox,
      commit,
    );
    this.calendarCache = new WeekRepository(
      doc(
        nullable(
          recordWith<CalendarCache>(
            (r) => typeof r.syncedAt === "number" && Array.isArray(r.events),
          ),
        ),
        () => null,
      ),
      KEYS.calendarCache,
      commit,
    );
    this.notifRegistry = new SingletonRepository(
      doc(arrayOf<RegistryEntry>(hasId), () => []),
      KEYS.notifRegistry,
      commit,
    );
    this.openPrompts = new SingletonRepository(
      doc(
        arrayOf<OpenPrompt>((v) => isRecord(v) && typeof v.promptId === "string"),
        () => [],
      ),
      KEYS.openPrompts,
      commit,
    );
    this.undo = new SingletonRepository(
      doc(nullable(recordWith<UndoToken>(
          (r) =>
            hasBlockId(r) &&
            (r.entries === undefined ||
              (Array.isArray(r.entries) && r.entries.length > 0 && r.entries.every(hasBlockId))),
        )), () => null),
      KEYS.undo,
      commit,
    );
    this.syncState = new SingletonRepository(
      doc(recordWith<SyncState>(() => true), () => ({})),
      KEYS.syncState,
      commit,
    );
    this.authState = new SingletonRepository(
      doc(validateAuthState, () => ({ ...DEFAULT_AUTH_STATE })),
      KEYS.authState,
      commit,
    );
    this.permissionState = new SingletonRepository(
      doc(validatePermissionState, () => ({ ...DEFAULT_PERMISSION_STATE })),
      KEYS.permissionState,
      commit,
    );
    this.profile = new SingletonRepository(
      doc(validateProfile, () => ({ updatedAt: 0 })),
      KEYS.profile,
      commit,
    );
    this.sleepScores = new SingletonRepository(
      doc(validateSleepScores, () => ({})),
      KEYS.sleepScores,
      commit,
    );
    this.demoMode = new SingletonRepository(
      doc(validateDemoMode, () => null),
      KEYS.demoMode,
      commit,
    );
    this.holidays = new SingletonRepository(
      doc(validateHolidays, () => null),
      KEYS.holidays,
      commit,
    );
    this.aiProfile = new SingletonRepository(
      doc(validateAiProfile, () => null),
      KEYS.aiProfile,
      commit,
    );
  }

  /**
   * Write several documents atomically with one `setMany`, together with the
   * `schemaVersion` key.
   */
  async commit(writes: readonly DocWrite[]): Promise<void> {
    if (writes.length === 0) return;
    await this.kv.setMany([
      [KEYS.schemaVersion, String(SCHEMA_VERSION)],
      ...writes.map((w) => [w.key, w.value] as const),
    ]);
  }

  /**
   * Save a week's blocks and enqueue their calendar writes in one atomic
   * `setMany` (the outbox is coalesced per block).
   */
  async saveBlocksWithOutbox(
    weekId: string,
    blocks: DeviceBlock[],
    requests: readonly OutboxRequest[],
  ): Promise<PendingWrite[]> {
    const outbox = requests.reduce(coalesceOutbox, await this.outbox.get());
    await this.commit([this.blocks.write(weekId, blocks), this.outbox.write(outbox)]);
    return outbox;
  }
}
