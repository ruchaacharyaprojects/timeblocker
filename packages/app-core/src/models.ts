/**
 * On-device data models persisted in the local `KeyValueStore` (see the
 * design's "Local persistence" key schema). Pure types and constants only.
 *
 * All instants stored as ISO strings come from the engine/calendar surface
 * (`start`, `end`); bookkeeping times (`updatedAt`, `enqueuedAt`, `expiresAt`,
 * ...) are epoch milliseconds from the `Clock` port.
 */
import type { CalendarEvent } from "@timeblocker/calendar-integration";
import type { BlockStatus, IntakeCandidate, PersistedBlock, TaskKind } from "@timeblocker/flows";
import type { PlanningMode, Slot } from "@timeblocker/scheduling-engine";

/** Current version of every stored document's schema. */
export const SCHEMA_VERSION = 1 as const;

// --- Blocks -------------------------------------------------------------------

/**
 * The statuses a block can have on device. The backend's legacy `moved` is
 * never written here: a same-week move keeps `scheduled` (R13.1, R14.4).
 */
export type DeviceBlockStatus = Exclude<BlockStatus, "moved">;

/** A local time span (ISO instants). */
export interface Span {
  start: string;
  end: string;
}

/** Longest block notes kept on the phone (R34.6). */
export const MAX_BLOCK_NOTES_CHARS = 4000;
/** The on-device block: the flows `PersistedBlock` plus sync and dedupe fields. */
export interface DeviceBlock extends PersistedBlock {
  title: string;
  status: DeviceBlockStatus;
  /** Assigned locally at creation (base32hex) so creates are idempotent (R14.8). */
  calendarEventId: string;
  /** True once Google confirmed the event exists. */
  calendarSynced: boolean;
  /** Meetings that already raised a miss prompt for this block (R14.5). */
  promptedMeetingIds: string[];
  /** Whether the usage-signal prompt was already raised (R6.1). */
  usagePrompted: boolean;
  moveReason?: string;
  movedFrom?: Span;
  /** Hard deadline copied from the item, ISO instant (R28.5). */
  dueAt?: string;
  /** Kind of task from the optional AI list reader (R33.1). */
  kind?: TaskKind;
  /** Notes saved from "Save to this task" (R34.6); phone only, up to {@link MAX_BLOCK_NOTES_CHARS}. */
  notes?: string;
  /** Last local change, epoch ms. */
  updatedAt: number;
}

// --- Outbox -------------------------------------------------------------------

export type PendingWriteOp = "upsert" | "delete";

/**
 * A queued Google Calendar write, coalesced per block (latest local state
 * wins). An `upsert` reads the block's current fields at flush time; a
 * `delete` keeps `calendarEventId` because the block row is gone (R14.10).
 */
export interface PendingWrite {
  blockId: string;
  calendarEventId: string;
  op: PendingWriteOp;
  attempts: number;
  lastError?: string;
  /** epoch ms */
  enqueuedAt: number;
}

// --- Notification registry ----------------------------------------------------

export type RegistryKind =
  | "block-reminder"
  | "meeting-reminder"
  | "miss-prompt"
  | "status"
  /** Saturday review / Sunday planning nudges (R9). */
  | "weekly-nudge";

/** Every reminder/prompt TimeBlocker has scheduled or shown (R13.7). */
export interface RegistryEntry {
  id: string;
  kind: RegistryKind;
  /** The block or event id. */
  sourceId: string;
  /** Start of the source block/event, epoch ms. */
  startMs: number;
  fireAtMs: number;
  exact: boolean;
  state: "pending" | "shown";
  /**
   * Hash of the armed notification's visible content (title, body, actions,
   * deep link). A different value under the same id re-arms it (R17.5).
   * Absent on entries written before R17: those are re-armed once.
   */
  contentKey?: string;
}

/** An unanswered "Will you miss this block?" prompt (R13.9). */
export interface OpenPrompt {
  promptId: string;
  blockId: string;
  meetingIds: string[];
  /** epoch ms */
  shownAt: number;
}

// --- Undo -----------------------------------------------------------------------

/** One Undo window for the block-detail snackbar and the notification (R11.9). */
export const UNDO_WINDOW_MS = 10_000;

/** The single active Undo. Valid while `now < expiresAt` and the block is still at `movedTo`. */
export interface UndoToken {
  blockId: string;
  weekId: string;
  calendarEventId: string;
  /** The slot to restore. */
  previous: Slot;
  previousStatus: DeviceBlockStatus;
  /** Where the move put the block. */
  movedTo: Slot;
  /** epoch ms */
  expiresAt: number;
  /**
   * Multi-block Undo (R29.3): every block the action changed, the target
   * first. Absent on single-block tokens; read those through
   * {@link undoEntriesOf}, which turns the top-level fields into one entry.
   */
  entries?: UndoEntry[];
}

/** One block's restore data inside an {@link UndoToken}. */
export interface UndoEntry {
  blockId: string;
  weekId: string;
  calendarEventId: string;
  /** The slot to restore. */
  previous: Slot;
  previousStatus: DeviceBlockStatus;
  /** The block's `movedFrom` before the action; absent means it had none. */
  previousMovedFrom?: Slot;
  /** The block's `moveReason` before the action; absent means it had none. */
  previousMoveReason?: string;
  /** Where the action put the block. */
  movedTo: Slot;
}

/** The entries of `token`; an old single-block token becomes one entry. */
export function undoEntriesOf(token: UndoToken): UndoEntry[] {
  if (Array.isArray(token.entries) && token.entries.length > 0) return token.entries;
  return [
    {
      blockId: token.blockId,
      weekId: token.weekId,
      calendarEventId: token.calendarEventId,
      previous: token.previous,
      previousStatus: token.previousStatus,
      movedTo: token.movedTo,
    },
  ];
}

// --- Sync, auth, permission state ---------------------------------------------

/** Single-flight lease, last success, and the error banner (R14.3, R14.10). */
export interface SyncState {
  lease?: { owner: string; expiresAt: number };
  lastSuccessAt?: number;
  error?: { message: string; at: number; dismissed: boolean };
}

/** Why a Google session ended (see {@link SessionEnded}). */
export type SessionEndedReason =
  /** No tokens in the vault. */
  | "missing"
  /** Google rejected the refresh token; the vault was cleared. */
  | "invalid-grant"
  /** The refresh request failed in transit; the vault was kept. */
  | "transport"
  /** A second Calendar `401` after one forced refresh. */
  | "revoked";

export type AuthStatus = "signed-out" | "signed-in" | "session-ended";

/** Persisted auth status. Never contains tokens. */
export interface AuthState {
  status: AuthStatus;
  reason?: SessionEndedReason;
}

/** Ask-once and exact-alarm flags (R13.8, R13.10). */
export interface PermissionState {
  notificationsRequested: boolean;
  exactAlarmsAvailable: boolean;
}

/** Non-secret display profile from the Google id token (R18.2). */
export interface Profile {
  /** Given name for the dashboard greeting; absent until the next sign-in. */
  givenName?: string;
  /** epoch ms */
  updatedAt: number;
}

/** One scored night (R19.3): date, minutes of use, score. No per-app data. */
export interface SleepScore {
  /** YYYY-MM-DD (Toronto) of the date the night started. */
  dateKey: string;
  /** Whole minutes of phone use inside the sleep window (or the health session). */
  usageMin: number;
  /** Minutes asleep from Health Connect (R25.4); absent for usage-only nights. */
  asleepMin?: number;
  /** 0-100 */
  score: number;
  /** epoch ms when the night was scored */
  scoredAt: number;
  /** Which sources were used (R25.4). Entries stored before R25 read as `usage`. */
  source: SleepScoreSource;
  /** True for generated demo data (R24.5). */
  demo?: boolean;
}

export type SleepScoreSource = "health+usage" | "usage";

/** Bookkeeping for loaded demo data, so removal is exact (R24). */
export interface DemoMode {
  /** epoch ms */
  loadedAt: number;
  /** Past weeks that received demo blocks. */
  blockWeeks: string[];
  /** The "Use demo screen usage" switch. */
  demoUsage: boolean;
  /** True when the demo distraction apps were added to an empty list. */
  addedDistractionApps: boolean;
}

/** The `sleepScores` document: scores keyed by `dateKey`. */
export type SleepScoreMap = Record<string, SleepScore>;

/** The `holidays` document: cached public holidays of the user's country (R30.2). */
export interface HolidayCache {
  /** ISO 3166-1 alpha-2 code, upper case. */
  country: string;
  /** Epoch ms of the last successful fetch. */
  fetchedAt: number;
  /** Holidays for this and next year at fetch time. */
  items: Array<{ date: string; name: string }>;
}
// --- Other stored documents ---------------------------------------------------

/** User settings; exactly one planning mode (R11.11). */
export interface DeviceSettings {
  planningMode: PlanningMode;
  /** YYYY-MM-DD dates. */
  holidays: string[];
  /** Android package names. */
  distractionApps: string[];
  /** Appearance (R26.2); missing = `system`. */
  themeMode?: ThemeMode;
  /** True once the user picked a planning mode; until then `spread` applies (R30.1). */
  planningModeSetByUser?: boolean;
  /** AI assistant switch (R35.1); missing = off. */
  aiEnabled?: boolean;
}

/** Longest "About me for applications" text kept on the phone (R34.2). */
export const MAX_AI_BACKGROUND_CHARS = 3000;

/** The user's background for application help; phone-only (R34.2, D30). */
export interface AiProfile {
  background: string;
  /** epoch ms */
  updatedAt: number;
}

/** Appearance choice (R26.2). */
export type ThemeMode = "system" | "light" | "dark";

/** Intake text kept across app kills before confirm (R1.3). */
export interface IntakeDraft {
  text: string;
  candidates?: IntakeCandidate[];
  /** Lines skipped as non-tasks, e.g. sleep (R22.3). */
  ignored?: { text: string; reason: "sleep" }[];
  /** epoch ms */
  updatedAt: number;
}

/** Non-🧱 events from the latest completed sync of a week (R11.7). */
export interface CalendarCache {
  /** epoch ms */
  syncedAt: number;
  events: CalendarEvent[];
}

// --- Errors -------------------------------------------------------------------

/** User-facing copy shown after any session end (R12.5). */
export const SESSION_ENDED_MESSAGE = "Your Google session ended";

/**
 * Thrown when no valid Google access token can be obtained. Local data is
 * left untouched; callers stop background sync and route to sign-in
 * (R12.5, R14.12).
 */
export class SessionEnded extends Error {
  constructor(readonly reason: SessionEndedReason) {
    super(`${SESSION_ENDED_MESSAGE} (${reason})`);
    this.name = "SessionEnded";
  }
}

/** Narrow an unknown thrown value to {@link SessionEnded}. */
export function isSessionEnded(error: unknown): error is SessionEnded {
  return error instanceof SessionEnded;
}
