/**
 * Shared data contracts for the Google Calendar integration.
 *
 * Instants are ISO-8601 strings (absolute, timezone-aware), matching the
 * scheduling-engine's public surface. The pieces that touch Google and AWS
 * are kept behind small interfaces so the request-building and parsing logic
 * stays pure and fully unit-testable without a network.
 */

import type { Category } from "@timeblocker/scheduling-engine";

export type { Category };

/** OAuth scope required to read and write the primary calendar (R4.1). */
export const CALENDAR_SCOPE = "https://www.googleapis.com/auth/calendar" as const;

/**
 * Google OAuth tokens as persisted in Secrets Manager. `expiryDate` is epoch
 * milliseconds for the access token; `refreshToken` is long-lived.
 */
export interface OAuthTokens {
  accessToken: string;
  refreshToken: string;
  /** Epoch milliseconds at which `accessToken` expires. */
  expiryDate: number;
  scope: string;
  tokenType: string;
}

/** Static OAuth client configuration (no secrets beyond the client secret). */
export interface OAuthClientConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

/**
 * A calendar event as read back from Google, normalized to the subset the
 * engine and the app care about. `start`/`end` are absolute ISO instants.
 */
export interface CalendarEvent {
  id: string;
  summary: string;
  start: string;
  end: string;
  /** True when the event has attendees other than the owner (a meeting). */
  withOthers: boolean;
  /** The event's color id, if any. */
  colorId?: string;
  /**
   * True when the summary starts with the 🧱 prefix (ignoring leading
   * whitespace), i.e. a TimeBlocker block event (R14.4). Always set by
   * `parseCalendarEvent`; optional so hand-built events stay valid.
   */
  isBlock?: boolean;
}

/**
 * A solo block to write to the calendar. `start`/`end` are absolute ISO
 * instants; `category` drives the color (R4.1).
 */
export interface SoloBlock {
  /** Human-readable title, without the 🧱 prefix (it is added on write). */
  title: string;
  start: string;
  end: string;
  category: Category;
  /** Existing Google event id when updating an already-written block. */
  calendarEventId?: string;
}

/** The reminder settings Google applies to an event. */
export interface EventReminders {
  useDefault: boolean;
  overrides: Array<{ method: "popup" | "email"; minutes: number }>;
}

/** The request body shape for Google Calendar event insert/update. */
export interface GoogleEventRequest {
  /**
   * Client-chosen event id for idempotent creates (R14.8). Google requires
   * base32hex characters (a-v, 0-9), 5-1024 long.
   */
  id?: string;
  summary: string;
  start: { dateTime: string };
  end: { dateTime: string };
  colorId: string;
  reminders: EventReminders;
}
