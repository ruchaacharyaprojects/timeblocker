import {
  CalendarHttpError,
  GoogleCalendarClient,
  type AccessTokenProvider,
  type CalendarHttpClient,
} from "@timeblocker/calendar-integration";
import type { PersistedBlock } from "@timeblocker/flows";
import { describe, expect, expectTypeOf, it } from "vitest";
import {
  BASE32HEX_ALPHABET,
  CalendarHttpError as ReexportedCalendarHttpError,
  SESSION_ENDED_MESSAGE,
  SessionEnded,
  isCalendarEventId,
  isSessionEnded,
  type CalendarApi,
  type DeviceBlock,
} from "./index.js";

describe("SessionEnded", () => {
  it("carries its reason and the user-facing message", () => {
    const err = new SessionEnded("invalid-grant");
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("SessionEnded");
    expect(err.reason).toBe("invalid-grant");
    expect(err.message).toContain(SESSION_ENDED_MESSAGE);
  });

  it("isSessionEnded narrows only SessionEnded", () => {
    expect(isSessionEnded(new SessionEnded("missing"))).toBe(true);
    expect(isSessionEnded(new Error("x"))).toBe(false);
    expect(isSessionEnded(new CalendarHttpError("get", 401))).toBe(false);
  });
});

describe("isCalendarEventId (base32hex, 5-1024)", () => {
  it("accepts base32hex ids within the length bounds", () => {
    expect(BASE32HEX_ALPHABET).toHaveLength(32);
    expect(isCalendarEventId("abcde")).toBe(true);
    expect(isCalendarEventId(BASE32HEX_ALPHABET)).toBe(true);
    expect(isCalendarEventId("v".repeat(1024))).toBe(true);
  });

  it("rejects short, long, uppercase, and non-base32hex ids", () => {
    expect(isCalendarEventId("abcd")).toBe(false);
    expect(isCalendarEventId("a".repeat(1025))).toBe(false);
    expect(isCalendarEventId("ABCDE")).toBe(false);
    expect(isCalendarEventId("abcdw")).toBe(false);
    expect(isCalendarEventId("abc-de")).toBe(false);
  });
});

describe("type contracts", () => {
  it("GoogleCalendarClient satisfies the narrow CalendarApi port", () => {
    const auth: AccessTokenProvider = { getValidAccessToken: async () => "t" };
    const http: CalendarHttpClient = {
      get: async () => ({ status: 200, body: {} }),
      post: async () => ({ status: 200, body: {} }),
      put: async () => ({ status: 200, body: {} }),
    };
    const api: CalendarApi = new GoogleCalendarClient(auth, http);
    expect(typeof api.upsertBlock).toBe("function");
    expectTypeOf<ReturnType<CalendarApi["getEvent"]>>().resolves.toMatchTypeOf<
      Awaited<ReturnType<GoogleCalendarClient["getEvent"]>>
    >();
  });

  it("DeviceBlock is a PersistedBlock and the error class is re-exported", () => {
    expectTypeOf<DeviceBlock>().toMatchTypeOf<PersistedBlock>();
    expect(ReexportedCalendarHttpError).toBe(CalendarHttpError);
  });
});
