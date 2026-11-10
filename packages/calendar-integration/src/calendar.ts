/**
 * Google Calendar read/write client for TimeBlocker.
 *
 * Reads the week's events (R4.1 planning input) and creates/updates solo
 * blocks with the 🧱 prefix, per-category colors (R4.1), and suppressed
 * reminders — no default pop-ups, no email reminders (R4.2). All request
 * building and response parsing is delegated to the pure helpers in
 * `events.ts`; this client only sequences auth + HTTP.
 */

import type { Week } from "@timeblocker/scheduling-engine";
import {
  buildEventRequest,
  parseCalendarEvent,
  type RawGoogleEvent,
} from "./events.js";
import type { CalendarEvent, SoloBlock } from "./types.js";

const CALENDAR_API_BASE =
  "https://www.googleapis.com/calendar/v3/calendars/primary/events";

/** HTTP port for the Calendar REST API (injected; no concrete fetch here). */
export interface CalendarHttpClient {
  get(
    url: string,
    accessToken: string,
  ): Promise<{ status: number; body: unknown }>;
  post(
    url: string,
    accessToken: string,
    body: unknown,
  ): Promise<{ status: number; body: unknown }>;
  put(
    url: string,
    accessToken: string,
    body: unknown,
  ): Promise<{ status: number; body: unknown }>;
  /**
   * DELETE a resource. Optional so existing infra adapters (get/post/put
   * only) still type-check; on-device adapters implement it.
   */
  delete?(
    url: string,
    accessToken: string,
  ): Promise<{ status: number; body: unknown }>;
}

/** Source of a currently-valid access token (the OAuth client in production). */
export interface AccessTokenProvider {
  getValidAccessToken(): Promise<string>;
}

/**
 * Build the list URL for events within a week's Sunday-Saturday bounds.
 * Pass `pageToken` to fetch a subsequent page (R14.1, R14.2).
 */
export function buildListUrl(week: Week, pageToken?: string): string {
  const params = new URLSearchParams({
    timeMin: week.sunday,
    timeMax: week.saturday,
    singleEvents: "true",
    orderBy: "startTime",
    maxResults: "2500",
  });
  if (pageToken) params.set("pageToken", pageToken);
  return `${CALENDAR_API_BASE}?${params.toString()}`;
}

/** Shape of the Google events.list response we consume. */
interface ListResponse {
  items?: RawGoogleEvent[];
  nextPageToken?: string;
}

/** One public holiday date (YYYY-MM-DD) with its name. */
export interface HolidayEntry {
  date: string;
  name: string;
}

/** Build the events.list URL for a (holiday) calendar id. */
export function buildHolidayUrl(
  calendarId: string,
  timeMin: string,
  timeMax: string,
  pageToken?: string,
): string {
  const params = new URLSearchParams({
    singleEvents: "true",
    orderBy: "startTime",
    timeMin,
    timeMax,
    maxResults: "250",
    fields: "items(summary,start,end),nextPageToken",
  });
  if (pageToken) params.set("pageToken", pageToken);
  return `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events?${params.toString()}`;
}

/** Every YYYY-MM-DD in [start, end); just `start` when `end` is missing or not after it. */
export function expandDates(start: string, end?: string): string[] {
  const first = Date.parse(`${start}T00:00:00Z`);
  if (Number.isNaN(first)) return [];
  const last = end ? Date.parse(`${end}T00:00:00Z`) : Number.NaN;
  if (Number.isNaN(last) || last <= first) return [start];
  const dates: string[] = [];
  for (let t = first; t < last && dates.length < 366; t += 86_400_000) {
    dates.push(new Date(t).toISOString().slice(0, 10));
  }
  return dates;
}

interface HolidayListResponse {
  items?: Array<{
    summary?: string;
    start?: { date?: string };
    end?: { date?: string };
  }>;
  nextPageToken?: string;
}

export class GoogleCalendarClient {
  constructor(
    private readonly auth: AccessTokenProvider,
    private readonly http: CalendarHttpClient,
  ) {}

  /**
   * Read all events in the given Sunday-Saturday week from the primary
   * calendar, normalized to {@link CalendarEvent}. Follows `nextPageToken`
   * until exhausted (R14.1, R14.2). Events without concrete times and events
   * with `status: "cancelled"` are dropped.
   */
  async readWeek(week: Week): Promise<CalendarEvent[]> {
    const token = await this.auth.getValidAccessToken();
    const events: CalendarEvent[] = [];
    const seenTokens = new Set<string>();
    let pageToken: string | undefined;
    do {
      const { status, body } = await this.http.get(
        buildListUrl(week, pageToken),
        token,
      );
      if (status < 200 || status >= 300) {
        throw new Error(`Calendar list failed with status ${status}`);
      }
      const page = (body ?? {}) as ListResponse;
      for (const raw of page.items ?? []) {
        if (raw.status === "cancelled") continue;
        const parsed = parseCalendarEvent(raw);
        if (parsed) events.push(parsed);
      }
      pageToken = page.nextPageToken || undefined;
      // Guard against a server repeating a token, which would loop forever.
      if (pageToken !== undefined) {
        if (seenTokens.has(pageToken)) {
          throw new Error("Calendar list repeated a page token");
        }
        seenTokens.add(pageToken);
      }
    } while (pageToken !== undefined);
    return events;
  }

  /**
   * Read all-day events of another calendar (a Google public holiday
   * calendar) as dates. Multi-day all-day events expand to every date in
   * [start.date, end.date). `404`/`403` (calendar missing or no access) give
   * `[]`; other non-2xx responses throw {@link CalendarHttpError}; transport
   * errors propagate. Follows `nextPageToken`. Result is sorted by date.
   */
  async readHolidays(
    calendarId: string,
    timeMin: string,
    timeMax: string,
  ): Promise<HolidayEntry[]> {
    const token = await this.auth.getValidAccessToken();
    const out: HolidayEntry[] = [];
    const seenTokens = new Set<string>();
    let pageToken: string | undefined;
    do {
      const { status, body } = await this.http.get(
        buildHolidayUrl(calendarId, timeMin, timeMax, pageToken),
        token,
      );
      if (status === 404 || status === 403) return [];
      if (!isOk(status)) throw new CalendarHttpError("get", status);
      const page = (body ?? {}) as HolidayListResponse;
      for (const raw of page.items ?? []) {
        const startDate = raw.start?.date;
        if (!startDate) continue;
        const name = raw.summary?.trim() || "Holiday";
        for (const date of expandDates(startDate, raw.end?.date)) {
          out.push({ date, name });
        }
      }
      pageToken = page.nextPageToken || undefined;
      if (pageToken !== undefined) {
        if (seenTokens.has(pageToken)) {
          throw new Error("Calendar list repeated a page token");
        }
        seenTokens.add(pageToken);
      }
    } while (pageToken !== undefined);
    return out.sort((a, b) => a.date.localeCompare(b.date));
  }

  /**
   * Create a new solo block, or update it in place when `calendarEventId` is
   * set. The written event always carries the 🧱 prefix, the category color,
   * and suppressed reminders (R4.1, R4.2). Returns the resulting event id.
   */
  async writeBlock(block: SoloBlock): Promise<string> {
    const token = await this.auth.getValidAccessToken();
    const requestBody = buildEventRequest(block);

    const { status, body } = block.calendarEventId
      ? await this.http.put(
          `${CALENDAR_API_BASE}/${encodeURIComponent(block.calendarEventId)}`,
          token,
          requestBody,
        )
      : await this.http.post(CALENDAR_API_BASE, token, requestBody);

    if (status < 200 || status >= 300) {
      throw new Error(`Calendar write failed with status ${status}`);
    }
    const id = (body as { id?: string }).id ?? block.calendarEventId;
    if (!id) {
      throw new Error("Calendar write returned no event id");
    }
    return id;
  }

  /** Write several solo blocks, preserving input order in the returned ids. */
  async writeBlocks(blocks: SoloBlock[]): Promise<string[]> {
    const ids: string[] = [];
    for (const block of blocks) {
      ids.push(await this.writeBlock(block));
    }
    return ids;
  }

  /**
   * Delete a block's event. `404`/`410` mean the event is already gone and
   * count as success, so retries are safe (R14.7). Requires the injected
   * HTTP client to implement `delete`.
   */
  async deleteBlock(eventId: string): Promise<void> {
    const del = this.http.delete;
    if (typeof del !== "function") {
      throw new Error(
        "CalendarHttpClient.delete is not implemented by the injected HTTP client; deleteBlock requires it",
      );
    }
    const token = await this.auth.getValidAccessToken();
    const { status } = await del.call(this.http, eventUrl(eventId), token);
    if (isOk(status) || isGone(status)) return;
    throw new CalendarHttpError("delete", status);
  }

  /**
   * Fetch one event by id. Returns `"deleted"` when Google reports `404`/`410`
   * or the event's `status` is `"cancelled"` (R14.4 remote deletion).
   * Throws {@link CalendarHttpError} on other non-2xx responses.
   */
  async getEvent(eventId: string): Promise<CalendarEvent | "deleted"> {
    const token = await this.auth.getValidAccessToken();
    const { status, body } = await this.http.get(eventUrl(eventId), token);
    if (isGone(status)) return "deleted";
    if (!isOk(status)) throw new CalendarHttpError("get", status);
    const raw = (body ?? {}) as RawGoogleEvent;
    if (raw.status === "cancelled") return "deleted";
    const parsed = parseCalendarEvent(raw);
    if (!parsed) {
      throw new Error(`Calendar get returned an unparseable event ${eventId}`);
    }
    return parsed;
  }

  /**
   * Idempotently create or update a block under its client-chosen
   * `calendarEventId` (R14.8). Inserts with that id; `409 Conflict` means the
   * event already exists, so the write becomes a `PUT` to the same id. The
   * body comes from {@link buildEventRequest} (🧱 prefix, category color,
   * suppressed reminders; R4.1, R4.2, R14.9).
   *
   * Returns the event id, or `"deleted"` when the `PUT` gets `404`/`410`
   * (the user deleted the event in Calendar). Other failures throw
   * {@link CalendarHttpError} carrying the status code.
   */
  async upsertBlock(block: SoloBlock): Promise<string | "deleted"> {
    const id = block.calendarEventId;
    if (!id) {
      throw new Error("upsertBlock requires a client-chosen calendarEventId");
    }
    const token = await this.auth.getValidAccessToken();
    const requestBody = { ...buildEventRequest(block), id };

    const inserted = await this.http.post(CALENDAR_API_BASE, token, requestBody);
    if (isOk(inserted.status)) return id;
    if (inserted.status !== 409) {
      throw new CalendarHttpError("insert", inserted.status);
    }

    const updated = await this.http.put(eventUrl(id), token, requestBody);
    if (isOk(updated.status)) return id;
    if (isGone(updated.status)) return "deleted";
    throw new CalendarHttpError("update", updated.status);
  }
}

/** A non-2xx Calendar API response; `status` lets callers classify retries. */
export class CalendarHttpError extends Error {
  constructor(
    readonly operation: "get" | "insert" | "update" | "delete",
    readonly status: number,
  ) {
    super(`Calendar ${operation} failed with status ${status}`);
    this.name = "CalendarHttpError";
  }
}

function eventUrl(eventId: string): string {
  return `${CALENDAR_API_BASE}/${encodeURIComponent(eventId)}`;
}

function isOk(status: number): boolean {
  return status >= 200 && status < 300;
}

function isGone(status: number): boolean {
  return status === 404 || status === 410;
}
