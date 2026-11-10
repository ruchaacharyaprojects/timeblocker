import { describe, it, expect } from "vitest";
import { weekBounds } from "@timeblocker/scheduling-engine";
import {
  CalendarHttpError,
  GoogleCalendarClient,
  buildListUrl,
} from "./calendar.js";
import { BLOCK_PREFIX, CATEGORY_COLOR_ID } from "./events.js";
import type { AccessTokenProvider, CalendarHttpClient } from "./calendar.js";
import type { SoloBlock } from "./types.js";
import { FakeCalendarHttp } from "./testkit.js";

const WEEK = weekBounds("2025-01-15T12:00:00.000Z");

const AUTH: AccessTokenProvider = {
  async getValidAccessToken() {
    return "token-abc";
  },
};

describe("buildListUrl bounds the read to the Sunday-Saturday week", () => {
  it("sets timeMin/timeMax to the week bounds and expands recurring events", () => {
    const url = new URL(buildListUrl(WEEK));
    expect(url.searchParams.get("timeMin")).toBe(WEEK.sunday);
    expect(url.searchParams.get("timeMax")).toBe(WEEK.saturday);
    expect(url.searchParams.get("singleEvents")).toBe("true");
    expect(url.searchParams.get("orderBy")).toBe("startTime");
  });
});

describe("readWeek returns normalized events (R4.1 planning input)", () => {
  it("parses items and drops malformed ones, passing the bearer token", async () => {
    const http = new FakeCalendarHttp({
      get: () => ({
        status: 200,
        body: {
          items: [
            {
              id: "e1",
              summary: "Standup",
              start: { dateTime: "2025-01-15T13:00:00Z" },
              end: { dateTime: "2025-01-15T13:30:00Z" },
              attendees: [{ self: true }, { email: "a@b.com" }],
            },
            { summary: "no id, dropped" },
          ],
        },
      }),
    });
    const client = new GoogleCalendarClient(AUTH, http);
    const events = await client.readWeek(WEEK);
    expect(events).toHaveLength(1);
    expect(events[0].id).toBe("e1");
    expect(events[0].withOthers).toBe(true);
    expect(http.getCalls[0].token).toBe("token-abc");
  });

  it("throws on a non-2xx list response", async () => {
    const http = new FakeCalendarHttp({ get: () => ({ status: 500, body: {} }) });
    const client = new GoogleCalendarClient(AUTH, http);
    await expect(client.readWeek(WEEK)).rejects.toThrow(/500/);
  });
});

describe("writeBlock creates solo blocks (R4.1, R4.2)", () => {
  const block: SoloBlock = {
    title: "Leg day",
    start: "2025-01-15T17:00:00.000Z",
    end: "2025-01-15T18:00:00.000Z",
    category: "fitness",
  };

  it("POSTs a new event with prefix, color, and suppressed reminders", async () => {
    const http = new FakeCalendarHttp({
      post: () => ({ status: 200, body: { id: "created-1" } }),
    });
    const client = new GoogleCalendarClient(AUTH, http);
    const id = await client.writeBlock(block);
    expect(id).toBe("created-1");
    expect(http.postCalls).toHaveLength(1);
    const body = http.postCalls[0].body as any;
    expect(body.summary.startsWith(BLOCK_PREFIX)).toBe(true);
    expect(body.colorId).toBe(CATEGORY_COLOR_ID.fitness);
    expect(body.reminders.useDefault).toBe(false);
    expect(body.reminders.overrides).toHaveLength(0);
  });

  it("PUTs an update when calendarEventId is set", async () => {
    const http = new FakeCalendarHttp({
      put: () => ({ status: 200, body: { id: "existing-1" } }),
    });
    const client = new GoogleCalendarClient(AUTH, http);
    const id = await client.writeBlock({ ...block, calendarEventId: "existing-1" });
    expect(id).toBe("existing-1");
    expect(http.putCalls).toHaveLength(1);
    expect(http.putCalls[0].url).toContain("existing-1");
    expect(http.postCalls).toHaveLength(0);
  });

  it("throws on a non-2xx write", async () => {
    const http = new FakeCalendarHttp({ post: () => ({ status: 403, body: {} }) });
    const client = new GoogleCalendarClient(AUTH, http);
    await expect(client.writeBlock(block)).rejects.toThrow(/403/);
  });

  it("writes several blocks preserving order", async () => {
    let n = 0;
    const http = new FakeCalendarHttp({
      post: () => ({ status: 200, body: { id: `id-${n++}` } }),
    });
    const client = new GoogleCalendarClient(AUTH, http);
    const ids = await client.writeBlocks([block, { ...block, category: "work" }]);
    expect(ids).toEqual(["id-0", "id-1"]);
  });
});

describe("readWeek pagination and cancelled filtering (R14.1, R14.2)", () => {
  const ev = (id: string, extra: Record<string, unknown> = {}) => ({
    id,
    summary: id,
    start: { dateTime: "2025-01-15T13:00:00Z" },
    end: { dateTime: "2025-01-15T13:30:00Z" },
    ...extra,
  });

  it("follows nextPageToken until exhausted", async () => {
    const pages: Record<string, { items: unknown[]; nextPageToken?: string }> = {
      "": { items: [ev("a")], nextPageToken: "p2" },
      p2: { items: [ev("b")], nextPageToken: "p3" },
      p3: { items: [ev("c")] },
    };
    const http = new FakeCalendarHttp({
      get: (url) => {
        const t = new URL(url).searchParams.get("pageToken") ?? "";
        return { status: 200, body: pages[t] };
      },
    });
    const client = new GoogleCalendarClient(AUTH, http);
    const events = await client.readWeek(WEEK);
    expect(events.map((e) => e.id)).toEqual(["a", "b", "c"]);
    expect(http.getCalls).toHaveLength(3);
    const tokens = http.getCalls.map((c) => new URL(c.url).searchParams.get("pageToken"));
    expect(tokens).toEqual([null, "p2", "p3"]);
    // Bounds are kept on every page.
    for (const c of http.getCalls) {
      expect(new URL(c.url).searchParams.get("timeMin")).toBe(WEEK.sunday);
    }
  });

  it("throws if a later page fails", async () => {
    const http = new FakeCalendarHttp({
      get: (url) =>
        new URL(url).searchParams.get("pageToken")
          ? { status: 503, body: {} }
          : { status: 200, body: { items: [ev("a")], nextPageToken: "p2" } },
    });
    const client = new GoogleCalendarClient(AUTH, http);
    await expect(client.readWeek(WEEK)).rejects.toThrow(/503/);
  });

  it("drops events with status cancelled", async () => {
    const http = new FakeCalendarHttp({
      get: () => ({
        status: 200,
        body: {
          items: [
            ev("keep", { status: "confirmed" }),
            ev("gone", { status: "cancelled" }),
            ev("tentative", { status: "tentative" }),
          ],
        },
      }),
    });
    const client = new GoogleCalendarClient(AUTH, http);
    const events = await client.readWeek(WEEK);
    expect(events.map((e) => e.id)).toEqual(["keep", "tentative"]);
  });

  it("sets isBlock on read events from the 🧱 prefix", async () => {
    const http = new FakeCalendarHttp({
      get: () => ({
        status: 200,
        body: { items: [ev("b", { summary: `${BLOCK_PREFIX} Leg day` }), ev("m")] },
      }),
    });
    const client = new GoogleCalendarClient(AUTH, http);
    const events = await client.readWeek(WEEK);
    expect(events.map((e) => e.isBlock)).toEqual([true, false]);
  });
});

describe("FakeCalendarHttp.delete", () => {
  it("records calls and defaults to 204", async () => {
    const http = new FakeCalendarHttp();
    const res = await http.delete("https://x/1", "tok");
    expect(res.status).toBe(204);
    expect(http.deleteCalls).toEqual([{ url: "https://x/1", token: "tok" }]);
  });

  it("uses the scripted delete handler", async () => {
    const http = new FakeCalendarHttp({ delete: () => ({ status: 410, body: {} }) });
    expect((await http.delete("https://x/1", "tok")).status).toBe(410);
  });
});

describe("deleteBlock (R14.7)", () => {
  it("issues DELETE to the event url with the bearer token on 2xx", async () => {
    const http = new FakeCalendarHttp();
    await new GoogleCalendarClient(AUTH, http).deleteBlock("abc123");
    expect(http.deleteCalls).toHaveLength(1);
    expect(http.deleteCalls[0].url).toMatch(/\/events\/abc123$/);
    expect(http.deleteCalls[0].token).toBe("token-abc");
  });

  it.each([404, 410])("treats %i as success", async (status) => {
    const http = new FakeCalendarHttp({ delete: () => ({ status, body: {} }) });
    await expect(
      new GoogleCalendarClient(AUTH, http).deleteBlock("abc123"),
    ).resolves.toBeUndefined();
  });

  it("throws a CalendarHttpError with the status on other failures", async () => {
    const http = new FakeCalendarHttp({ delete: () => ({ status: 503, body: {} }) });
    const err = await new GoogleCalendarClient(AUTH, http)
      .deleteBlock("abc123")
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CalendarHttpError);
    expect((err as CalendarHttpError).status).toBe(503);
  });

  it("throws a clear error when the HTTP client has no delete", async () => {
    const full = new FakeCalendarHttp();
    const noDelete: CalendarHttpClient = {
      get: full.get.bind(full),
      post: full.post.bind(full),
      put: full.put.bind(full),
    };
    await expect(
      new GoogleCalendarClient(AUTH, noDelete).deleteBlock("abc123"),
    ).rejects.toThrow(/delete is not implemented/);
  });
});

describe("getEvent (R14.4)", () => {
  const RAW = {
    id: "abc123",
    summary: "🧱 Deep work",
    start: { dateTime: "2025-01-15T13:00:00Z" },
    end: { dateTime: "2025-01-15T14:00:00Z" },
  };

  it("returns the parsed event on 200", async () => {
    const http = new FakeCalendarHttp({ get: () => ({ status: 200, body: RAW }) });
    const ev = await new GoogleCalendarClient(AUTH, http).getEvent("abc123");
    expect(ev).not.toBe("deleted");
    expect(ev).toMatchObject({ id: "abc123", isBlock: true });
    expect(http.getCalls[0].url).toMatch(/\/events\/abc123$/);
  });

  it.each([404, 410])("returns 'deleted' on %i", async (status) => {
    const http = new FakeCalendarHttp({ get: () => ({ status, body: {} }) });
    expect(await new GoogleCalendarClient(AUTH, http).getEvent("abc123")).toBe(
      "deleted",
    );
  });

  it("returns 'deleted' for a cancelled event", async () => {
    const http = new FakeCalendarHttp({
      get: () => ({ status: 200, body: { ...RAW, status: "cancelled" } }),
    });
    expect(await new GoogleCalendarClient(AUTH, http).getEvent("abc123")).toBe(
      "deleted",
    );
  });

  it("throws CalendarHttpError on other failures", async () => {
    const http = new FakeCalendarHttp({ get: () => ({ status: 500, body: {} }) });
    await expect(
      new GoogleCalendarClient(AUTH, http).getEvent("abc123"),
    ).rejects.toBeInstanceOf(CalendarHttpError);
  });
});

describe("upsertBlock is idempotent with a client-chosen id (R14.8, R14.9)", () => {
  const BLOCK: SoloBlock = {
    title: "Deep work",
    start: "2025-01-15T13:00:00.000Z",
    end: "2025-01-15T14:00:00.000Z",
    category: "work",
    calendarEventId: "abc123",
  };

  it("POSTs with the client id, prefix, color, and suppressed reminders", async () => {
    const http = new FakeCalendarHttp();
    const id = await new GoogleCalendarClient(AUTH, http).upsertBlock(BLOCK);
    expect(id).toBe("abc123");
    expect(http.putCalls).toHaveLength(0);
    const body = http.postCalls[0].body as Record<string, unknown>;
    expect(body.id).toBe("abc123");
    expect(body.summary).toBe(`${BLOCK_PREFIX} Deep work`);
    expect(body.colorId).toBe(CATEGORY_COLOR_ID.work);
    expect(body.reminders).toEqual({ useDefault: false, overrides: [] });
  });

  it("falls back to PUT on the same id when POST returns 409", async () => {
    const http = new FakeCalendarHttp({ post: () => ({ status: 409, body: {} }) });
    const id = await new GoogleCalendarClient(AUTH, http).upsertBlock(BLOCK);
    expect(id).toBe("abc123");
    expect(http.putCalls).toHaveLength(1);
    expect(http.putCalls[0].url).toMatch(/\/events\/abc123$/);
    expect(http.putCalls[0].body).toEqual(http.postCalls[0].body);
  });

  it.each([404, 410])("returns 'deleted' when the PUT gets %i", async (status) => {
    const http = new FakeCalendarHttp({
      post: () => ({ status: 409, body: {} }),
      put: () => ({ status, body: {} }),
    });
    expect(await new GoogleCalendarClient(AUTH, http).upsertBlock(BLOCK)).toBe(
      "deleted",
    );
  });

  it("throws CalendarHttpError with the status on other POST/PUT failures", async () => {
    const postFail = new FakeCalendarHttp({ post: () => ({ status: 400, body: {} }) });
    const e1 = await new GoogleCalendarClient(AUTH, postFail)
      .upsertBlock(BLOCK)
      .catch((e: unknown) => e);
    expect(e1).toBeInstanceOf(CalendarHttpError);
    expect((e1 as CalendarHttpError).status).toBe(400);
    expect(postFail.putCalls).toHaveLength(0);

    const putFail = new FakeCalendarHttp({
      post: () => ({ status: 409, body: {} }),
      put: () => ({ status: 502, body: {} }),
    });
    const e2 = await new GoogleCalendarClient(AUTH, putFail)
      .upsertBlock(BLOCK)
      .catch((e: unknown) => e);
    expect((e2 as CalendarHttpError).status).toBe(502);
  });

  it("requires a calendarEventId", async () => {
    const http = new FakeCalendarHttp();
    const { calendarEventId: _omit, ...noId } = BLOCK;
    await expect(
      new GoogleCalendarClient(AUTH, http).upsertBlock(noId),
    ).rejects.toThrow(/calendarEventId/);
    expect(http.postCalls).toHaveLength(0);
  });
});

describe("readHolidays reads another calendar's all-day events", () => {
  const CAL = "en.canadian.official#holiday@group.v.calendar.google.com";
  const allDay = (summary: string, start: string, end: string) => ({
    summary,
    start: { date: start },
    end: { date: end },
  });

  it("builds the encoded events URL on www.googleapis.com", async () => {
    const http = new FakeCalendarHttp({ get: () => ({ status: 200, body: { items: [] } }) });
    await new GoogleCalendarClient(AUTH, http).readHolidays(CAL, "2025-01-01T00:00:00Z", "2026-01-01T00:00:00Z");
    const url = new URL(http.getCalls[0].url);
    expect(url.origin).toBe("https://www.googleapis.com");
    expect(url.pathname).toBe(`/calendar/v3/calendars/${encodeURIComponent(CAL)}/events`);
    expect(url.searchParams.get("singleEvents")).toBe("true");
    expect(url.searchParams.get("orderBy")).toBe("startTime");
    expect(url.searchParams.get("timeMin")).toBe("2025-01-01T00:00:00Z");
    expect(url.searchParams.get("timeMax")).toBe("2026-01-01T00:00:00Z");
    expect(url.searchParams.get("maxResults")).toBe("250");
    expect(http.getCalls[0].token).toBe("token-abc");
  });

  it("maps single-day events and expands multi-day all-day events", async () => {
    const http = new FakeCalendarHttp({
      get: () => ({
        status: 200,
        body: {
          items: [
            allDay("Christmas Day", "2025-12-25", "2025-12-26"),
            allDay("Break", "2025-12-30", "2026-01-02"),
            { summary: "timed", start: { dateTime: "2025-03-01T10:00:00Z" } },
            { summary: "No end", start: { date: "2025-07-01" } },
          ],
        },
      }),
    });
    const out = await new GoogleCalendarClient(AUTH, http).readHolidays(CAL, "a", "b");
    expect(out).toEqual([
      { date: "2025-07-01", name: "No end" },
      { date: "2025-12-25", name: "Christmas Day" },
      { date: "2025-12-30", name: "Break" },
      { date: "2025-12-31", name: "Break" },
      { date: "2026-01-01", name: "Break" },
    ]);
  });

  it("follows nextPageToken", async () => {
    const http = new FakeCalendarHttp({
      get: (url) =>
        new URL(url).searchParams.get("pageToken") === "p2"
          ? { status: 200, body: { items: [allDay("B", "2025-02-02", "2025-02-03")] } }
          : { status: 200, body: { items: [allDay("A", "2025-01-01", "2025-01-02")], nextPageToken: "p2" } },
    });
    const out = await new GoogleCalendarClient(AUTH, http).readHolidays(CAL, "a", "b");
    expect(out.map((h) => h.date)).toEqual(["2025-01-01", "2025-02-02"]);
    expect(http.getCalls).toHaveLength(2);
  });

  it.each([404, 403])("returns [] for %i", async (status) => {
    const http = new FakeCalendarHttp({ get: () => ({ status, body: {} }) });
    expect(await new GoogleCalendarClient(AUTH, http).readHolidays(CAL, "a", "b")).toEqual([]);
  });

  it("throws CalendarHttpError on other failures and propagates network errors", async () => {
    const bad = new FakeCalendarHttp({ get: () => ({ status: 500, body: {} }) });
    await expect(new GoogleCalendarClient(AUTH, bad).readHolidays(CAL, "a", "b")).rejects.toMatchObject({
      status: 500,
    });
    const net = new FakeCalendarHttp({
      get: () => {
        throw new Error("offline");
      },
    });
    await expect(new GoogleCalendarClient(AUTH, net).readHolidays(CAL, "a", "b")).rejects.toThrow("offline");
  });
});
