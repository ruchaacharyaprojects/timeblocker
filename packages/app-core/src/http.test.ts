import { describe, expect, it } from "vitest";
import {
  GOOGLE_ALLOWED_HOSTS,
  GoogleCalendarHttp,
  GoogleOnlyHttp,
  NonGoogleDestinationError,
  isAllowedGoogleUrl,
} from "./http.js";
import { FakeHttpTransport } from "./testkit.js";

const ALLOWED_URLS = [
  "https://www.googleapis.com/calendar/v3/calendars/primary/events",
  "https://oauth2.googleapis.com/token",
  "https://oauth2.googleapis.com/revoke?token=x",
  "https://accounts.google.com/o/oauth2/v2/auth",
  "https://WWW.GOOGLEAPIS.COM/calendar/v3",
  "https://www.googleapis.com:443/calendar/v3",
];

const REFUSED_URLS = [
  // Wrong scheme.
  "http://www.googleapis.com/calendar/v3",
  "http://oauth2.googleapis.com/token",
  "ftp://www.googleapis.com/x",
  // Lookalike and suffix/prefix hosts.
  "https://googleapis.com.evil.example/calendar/v3",
  "https://www.googleapis.com.evil.example/calendar/v3",
  "https://evilwww.googleapis.com/x",
  "https://googleapis.com/x",
  "https://calendar.googleapis.com/x",
  "https://accounts.google.com.evil.example/x",
  "https://evil.example/https://www.googleapis.com/",
  // Credentials and non-default ports.
  "https://user:pass@www.googleapis.com/x",
  "https://www.googleapis.com@evil.example/x",
  "https://www.googleapis.com:8443/x",
  // Characters URL parsers may rewrite.
  "https://evil.example\\@www.googleapis.com/x",
  "https://www.googleapis.com\\.evil.example/x",
  " https://www.googleapis.com/x",
  "https://www.google\napis.com/x",
  "https://www.googleapis.com./x",
  // Not a URL at all.
  "www.googleapis.com/calendar",
  "",
];

describe("isAllowedGoogleUrl", () => {
  it("lists exactly the three Google hosts", () => {
    expect([...GOOGLE_ALLOWED_HOSTS].sort()).toEqual(
      ["accounts.google.com", "oauth2.googleapis.com", "www.googleapis.com"],
    );
  });

  it.each(ALLOWED_URLS)("allows %s", (url) => {
    expect(isAllowedGoogleUrl(url)).toBe(true);
  });

  it.each(REFUSED_URLS)("refuses %s", (url) => {
    expect(isAllowedGoogleUrl(url)).toBe(false);
  });
});

describe("GoogleOnlyHttp", () => {
  it.each(REFUSED_URLS)("throws before any I/O for %s", async (url) => {
    const transport = new FakeHttpTransport(() => ({ status: 200, body: "" }));
    const http = new GoogleOnlyHttp(transport);
    await expect(
      http.request("GET", url, { Authorization: "Bearer secret" }, undefined, {
        timeoutMs: 1000,
      }),
    ).rejects.toBeInstanceOf(NonGoogleDestinationError);
    expect(transport.requests).toHaveLength(0);
  });

  it("does not echo the refused URL in the error message", async () => {
    const http = new GoogleOnlyHttp(new FakeHttpTransport());
    const error = await http
      .request("GET", "https://evil.example/?token=secret", {}, undefined, { timeoutMs: 1 })
      .catch((e: unknown) => e);
    expect((error as Error).message).not.toContain("secret");
  });

  it("forwards allowed requests unchanged", async () => {
    const transport = new FakeHttpTransport(() => ({ status: 201, body: "ok" }));
    const http = new GoogleOnlyHttp(transport);
    const response = await http.request(
      "POST",
      "https://oauth2.googleapis.com/token",
      { "Content-Type": "application/x-www-form-urlencoded" },
      "a=b",
      { timeoutMs: 1234 },
    );
    expect(response).toEqual({ status: 201, body: "ok" });
    expect(transport.requests).toEqual([
      {
        method: "POST",
        url: "https://oauth2.googleapis.com/token",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "a=b",
        timeoutMs: 1234,
      },
    ]);
  });
});

describe("GoogleCalendarHttp", () => {
  it("adds the bearer token, JSON-encodes bodies, and parses JSON responses", async () => {
    const transport = new FakeHttpTransport(() => ({ status: 200, body: '{"id":"abc"}' }));
    const http = new GoogleCalendarHttp(transport, 5000);
    const response = await http.post(
      "https://www.googleapis.com/calendar/v3/calendars/primary/events",
      "tok",
      { summary: "x" },
    );
    expect(response).toEqual({ status: 200, body: { id: "abc" } });
    const [request] = transport.requests;
    expect(request?.method).toBe("POST");
    expect(request?.headers.Authorization).toBe("Bearer tok");
    expect(request?.headers["Content-Type"]).toBe("application/json");
    expect(request?.body).toBe('{"summary":"x"}');
    expect(request?.timeoutMs).toBe(5000);
  });

  it("implements delete, with an empty body parsed as undefined", async () => {
    const transport = new FakeHttpTransport(() => ({ status: 204, body: "" }));
    const http = new GoogleCalendarHttp(transport);
    const response = await http.delete(
      "https://www.googleapis.com/calendar/v3/calendars/primary/events/abcde",
      "tok",
    );
    expect(response).toEqual({ status: 204, body: undefined });
    expect(transport.requests[0]?.method).toBe("DELETE");
    expect(transport.requests[0]?.body).toBeUndefined();
  });

  it("passes non-JSON bodies through as text", async () => {
    const transport = new FakeHttpTransport(() => ({ status: 502, body: "Bad Gateway" }));
    const response = await new GoogleCalendarHttp(transport).get(
      "https://www.googleapis.com/x",
      "tok",
    );
    expect(response).toEqual({ status: 502, body: "Bad Gateway" });
  });

  it("never sends the token to a non-Google host", async () => {
    const transport = new FakeHttpTransport(() => ({ status: 200, body: "{}" }));
    const http = new GoogleCalendarHttp(transport);
    await expect(
      http.get("https://googleapis.com.evil.example/calendar/v3", "tok"),
    ).rejects.toBeInstanceOf(NonGoogleDestinationError);
    await expect(
      http.put("http://www.googleapis.com/calendar/v3", "tok", {}),
    ).rejects.toBeInstanceOf(NonGoogleDestinationError);
    expect(transport.requests).toHaveLength(0);
  });
});
