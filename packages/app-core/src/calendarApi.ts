/**
 * The device {@link CalendarApi}: the existing `GoogleCalendarClient`
 * constructed over {@link GoogleCalendarHttp} (and therefore
 * {@link GoogleOnlyHttp}), so Calendar traffic and the access token only ever
 * reach `www.googleapis.com` (R12.3, R12.8).
 */
import {
  CalendarHttpError,
  GoogleCalendarClient,
  type AccessTokenProvider,
  type CalendarEvent,
  type CalendarHttpClient,
} from "@timeblocker/calendar-integration";
import type { Week } from "@timeblocker/scheduling-engine";
import { DEFAULT_GOOGLE_TIMEOUT_MS, GoogleCalendarHttp } from "./http.js";
import type { CalendarApi, CalendarBlockWrite, HttpTransport } from "./ports.js";

export interface DeviceCalendarApiOptions {
  /** Per-request timeout, ms (default {@link DEFAULT_GOOGLE_TIMEOUT_MS}). */
  timeoutMs?: number;
}

/** Google Calendar behind the narrow {@link CalendarApi} port. */
export class DeviceCalendarApi implements CalendarApi {
  private readonly http: CalendarHttpClient;
  private readonly client: GoogleCalendarClient;

  constructor(
    private readonly auth: AccessTokenProvider,
    transport: HttpTransport,
    options: DeviceCalendarApiOptions = {},
  ) {
    this.http = new GoogleCalendarHttp(
      transport,
      options.timeoutMs ?? DEFAULT_GOOGLE_TIMEOUT_MS,
    );
    this.client = new GoogleCalendarClient(auth, this.http);
  }

  /**
   * `GoogleCalendarClient.readWeek` reports a non-2xx list page as a plain
   * `Error`; the port promises `CalendarHttpError(operation, status)`, so the
   * failing status is captured per call and rethrown typed.
   */
  async readWeek(week: Week): Promise<CalendarEvent[]> {
    let failedStatus: number | undefined;
    const recording: CalendarHttpClient = {
      get: async (url, token) => {
        const response = await this.http.get(url, token);
        if (response.status < 200 || response.status >= 300) {
          failedStatus = response.status;
        }
        return response;
      },
      post: (url, token, body) => this.http.post(url, token, body),
      put: (url, token, body) => this.http.put(url, token, body),
    };
    try {
      return await new GoogleCalendarClient(this.auth, recording).readWeek(week);
    } catch (error) {
      if (failedStatus !== undefined && !(error instanceof CalendarHttpError)) {
        throw new CalendarHttpError("get", failedStatus);
      }
      throw error;
    }
  }

  getEvent(eventId: string): Promise<CalendarEvent | "deleted"> {
    return this.client.getEvent(eventId);
  }

  upsertBlock(block: CalendarBlockWrite): Promise<string | "deleted"> {
    return this.client.upsertBlock(block);
  }

  deleteBlock(eventId: string): Promise<void> {
    return this.client.deleteBlock(eventId);
  }
  readHolidays(calendarId: string, timeMin: string, timeMax: string): Promise<{ date: string; name: string }[]> {
    return this.client.readHolidays(calendarId, timeMin, timeMax);
  }
}

/** Build the device {@link CalendarApi} from a token provider and raw transport. */
export function createDeviceCalendarApi(
  auth: AccessTokenProvider,
  transport: HttpTransport,
  options: DeviceCalendarApiOptions = {},
): CalendarApi {
  return new DeviceCalendarApi(auth, transport, options);
}
