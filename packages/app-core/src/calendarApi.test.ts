import { describe, expect, it } from "vitest";
import {
  BLOCK_PREFIX,
  CalendarHttpError,
  type AccessTokenProvider,
} from "@timeblocker/calendar-integration";
import { weekBounds } from "@timeblocker/scheduling-engine";
import { DeviceCalendarApi, createDeviceCalendarApi } from "./calendarApi.js";
import type { CalendarBlockWrite } from "./ports.js";
import { FakeHttpTransport, type HttpRequestRecord } from "./testkit.js";

const AUTH: AccessTokenProvider = {
  async getValidAccessToken() {
    return "access-123";
  },
};

const WEEK = weekBounds("2025-01-15T12:00:00.000Z");

const BLOCK: CalendarBlockWrite = {
  title: "Run",
  start: "2025-01-15T14:00:00.000Z",
  end: "2025-01-15T15:00:00.000Z",
  category: "fitness",
  calendarEventId: "abcde12345",
};

function json(status: number, body: unknown) {
  return { status, body: JSON.stringify(body) };
}

function host(request: HttpRequestRecord | undefined): string {
  return new URL(request?.url ?? "about:blank").host;
}

describe("DeviceCalendarApi", () => {
  it("reads the week across pages with the bearer token on www.googleapis.com only", async () => {
    const transport = new FakeHttpTransport((req) => {
      const page = new URL(req.url).searchParams.get("pageToken");
      return page === null
        ? json(200, {
            items: [
              {
                id: "e1",
                summary: "Meeting",
                start: { dateTime: "2025-01-14T15:00:00Z" },
                end: { dateTime: "2025-01-14T16:00:00Z" },
              },
            ],
            nextPageToken: "p2",
          })
        : json(200, {
            items: [
              {
                id: "e2",
                summary: `${BLOCK_PREFIX}Run`,
                start: { dateTime: "2025-01-15T14:00:00Z" },
                end: { dateTime: "2025-01-15T15:00:00Z" },
              },
              { id: "gone", status: "cancelled" },
            ],
          });
    });
    const api = createDeviceCalendarApi(AUTH, transport);
    const events = await api.readWeek(WEEK);
    expect(events.map((e) => e.id)).toEqual(["e1", "e2"]);
    expect(events[1]?.isBlock).toBe(true);
    expect(transport.requests).toHaveLength(2);
    for (const request of transport.requests) {
      expect(request.method).toBe("GET");
      expect(host(request)).toBe("www.googleapis.com");
      expect(request.headers.Authorization).toBe("Bearer access-123");
    }
  });

  it("surfaces a failed list page as CalendarHttpError('get', status)", async () => {
    const api = new DeviceCalendarApi(AUTH, new FakeHttpTransport(() => json(503, {})));
    const error = await api.readWeek(WEEK).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CalendarHttpError);
    expect(error).toMatchObject({ operation: "get", status: 503 });
  });

  it("propagates transport failures unchanged", async () => {
    const transport = new FakeHttpTransport();
    const boom = new Error("offline");
    transport.failNext(boom);
    const api = new DeviceCalendarApi(AUTH, transport);
    await expect(api.readWeek(WEEK)).rejects.toBe(boom);
  });

  it("readHolidays reads another calendar over Google-only HTTP and treats 404/403 as empty", async () => {
    const transport = new FakeHttpTransport(() =>
      json(200, { items: [{ summary: "Canada Day", start: { date: "2025-07-01" }, end: { date: "2025-07-02" } }] }),
    );
    const api = new DeviceCalendarApi(AUTH, transport);
    const cal = "en.canadian.official#holiday@group.v.calendar.google.com";
    expect(await api.readHolidays(cal, "2025-01-01T00:00:00Z", "2027-01-01T00:00:00Z")).toEqual([
      { date: "2025-07-01", name: "Canada Day" },
    ]);
    const request = transport.requests[0]!;
    expect(host(request)).toBe("www.googleapis.com");
    expect(request.url).toContain(`/calendars/${encodeURIComponent(cal)}/events`);
    expect(request.headers.Authorization).toBe("Bearer access-123");
    for (const status of [404, 403]) {
      transport.respondWith(() => json(status, {}));
      expect(await api.readHolidays(cal, "a", "b")).toEqual([]);
    }
    transport.respondWith(() => json(500, {}));
    await expect(api.readHolidays(cal, "a", "b")).rejects.toMatchObject({ status: 500 });
    const boom = new Error("offline");
    transport.failNext(boom);
    await expect(api.readHolidays(cal, "a", "b")).rejects.toBe(boom);
  });

  it("getEvent parses an event and maps 404/410 to 'deleted'", async () => {
    const transport = new FakeHttpTransport(() =>
      json(200, {
        id: "e1",
        summary: "x",
        start: { dateTime: "2025-01-14T15:00:00Z" },
        end: { dateTime: "2025-01-14T16:00:00Z" },
      }),
    );
    const api = new DeviceCalendarApi(AUTH, transport);
    expect(await api.getEvent("e1")).toMatchObject({ id: "e1" });
    transport.respondWith(() => ({ status: 410, body: "" }));
    expect(await api.getEvent("e1")).toBe("deleted");
  });

  it("upsertBlock inserts with the client id, and 409 becomes a PUT", async () => {
    const transport = new FakeHttpTransport((req) =>
      req.method === "POST" ? json(409, {}) : json(200, { id: BLOCK.calendarEventId }),
    );
    const api = new DeviceCalendarApi(AUTH, transport, { timeoutMs: 7000 });
    expect(await api.upsertBlock(BLOCK)).toBe(BLOCK.calendarEventId);
    expect(transport.requests.map((r) => r.method)).toEqual(["POST", "PUT"]);
    const posted = JSON.parse(transport.requests[0]?.body ?? "{}") as {
      id?: string;
      summary?: string;
    };
    expect(posted.id).toBe(BLOCK.calendarEventId);
    expect(posted.summary?.startsWith(BLOCK_PREFIX)).toBe(true);
    expect(transport.requests[1]?.url).toContain(`/events/${BLOCK.calendarEventId}`);
    expect(transport.requests.every((r) => r.timeoutMs === 7000)).toBe(true);
  });

  it("upsertBlock returns 'deleted' when the PUT gets 404", async () => {
    const transport = new FakeHttpTransport((req) =>
      req.method === "POST" ? json(409, {}) : { status: 404, body: "" },
    );
    expect(await new DeviceCalendarApi(AUTH, transport).upsertBlock(BLOCK)).toBe("deleted");
  });

  it("deleteBlock sends DELETE; 404/410 count as success, other failures throw", async () => {
    const transport = new FakeHttpTransport(() => ({ status: 204, body: "" }));
    const api = new DeviceCalendarApi(AUTH, transport);
    await api.deleteBlock("abcde12345");
    expect(transport.requests[0]?.method).toBe("DELETE");
    expect(host(transport.requests[0])).toBe("www.googleapis.com");

    transport.respondWith(() => ({ status: 404, body: "" }));
    await expect(api.deleteBlock("abcde12345")).resolves.toBeUndefined();
    transport.respondWith(() => ({ status: 410, body: "" }));
    await expect(api.deleteBlock("abcde12345")).resolves.toBeUndefined();

    transport.respondWith(() => ({ status: 500, body: "" }));
    await expect(api.deleteBlock("abcde12345")).rejects.toMatchObject({
      operation: "delete",
      status: 500,
    });
  });
});
