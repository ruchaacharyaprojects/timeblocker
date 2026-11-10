/**
 * Token isolation (R12.3, R12.8).
 *
 * `GoogleOnlyHttp` wraps the raw {@link HttpTransport} and refuses, before
 * any I/O, every request whose URL is not `https:` on an allowlisted Google
 * host. `GoogleCalendarHttp` is the only code that adds an `Authorization`
 * header, and it only ever sends through `GoogleOnlyHttp`.
 */
import type { CalendarHttpClient } from "@timeblocker/calendar-integration";
import type { HttpMethod, HttpResponse, HttpTransport } from "./ports.js";

/**
 * The only hosts any request may reach: Calendar API, OAuth token/revoke,
 * and authorization. Compared exactly (no suffix or subdomain matching).
 */
export const GOOGLE_ALLOWED_HOSTS: readonly string[] = Object.freeze([
  "www.googleapis.com",
  "oauth2.googleapis.com",
  "accounts.google.com",
]);

/** Default per-request timeout for Google calls, ms. */
export const DEFAULT_GOOGLE_TIMEOUT_MS = 10_000;

/** Thrown when a request targets anything other than an allowlisted Google URL. */
export class NonGoogleDestinationError extends Error {
  constructor(readonly url: string) {
    // The URL is not echoed in full: it could carry a query with secrets.
    super("Refusing to send a request to a non-Google destination");
    this.name = "NonGoogleDestinationError";
  }
}

/** `scheme://authority` followed by end, `/`, `?`, or `#`. */
const ABSOLUTE_URL = /^([A-Za-z][A-Za-z0-9+.-]*):\/\/([^/?#]*)(?:[/?#]|$)/;
/** Whitespace, control characters, and backslashes, which URL parsers may rewrite. */
const SUSPICIOUS_CHARS = /[\s\u0000-\u001f\u007f\\]/;

/**
 * True only for `https:` URLs whose host is exactly one of
 * {@link GOOGLE_ALLOWED_HOSTS} (case-insensitive), with no credentials and
 * no port other than the default `443`.
 *
 * Parsed by hand rather than with `URL`: React Native's `URL` polyfill does
 * not reliably implement `protocol`/`host`, and this package has no DOM
 * typings. Anything ambiguous (whitespace, control characters, backslashes,
 * `@`) fails closed.
 */
export function isAllowedGoogleUrl(url: string): boolean {
  if (SUSPICIOUS_CHARS.test(url)) return false;
  const match = ABSOLUTE_URL.exec(url);
  if (!match) return false;
  const scheme = (match[1] ?? "").toLowerCase();
  let authority = (match[2] ?? "").toLowerCase();
  if (scheme !== "https") return false;
  if (authority.includes("@")) return false;
  if (authority.endsWith(":443")) authority = authority.slice(0, -4);
  return GOOGLE_ALLOWED_HOSTS.includes(authority);
}

/** An {@link HttpTransport} that only ever talks to Google (R12.3). */
export class GoogleOnlyHttp implements HttpTransport {
  constructor(private readonly transport: HttpTransport) {}

  async request(
    method: HttpMethod,
    url: string,
    headers: Readonly<Record<string, string>>,
    body: string | undefined,
    options: { timeoutMs: number },
  ): Promise<HttpResponse> {
    if (!isAllowedGoogleUrl(url)) throw new NonGoogleDestinationError(url);
    return this.transport.request(method, url, headers, body, options);
  }
}

/**
 * The calendar-integration {@link CalendarHttpClient} (including the
 * optional `delete`) over {@link GoogleOnlyHttp}. Bodies are JSON; an empty
 * response body becomes `undefined`, and a non-JSON body is passed through as
 * the raw string.
 */
export class GoogleCalendarHttp implements CalendarHttpClient {
  private readonly http: GoogleOnlyHttp;

  constructor(
    transport: HttpTransport,
    private readonly timeoutMs: number = DEFAULT_GOOGLE_TIMEOUT_MS,
  ) {
    this.http =
      transport instanceof GoogleOnlyHttp ? transport : new GoogleOnlyHttp(transport);
  }

  get(url: string, accessToken: string): Promise<{ status: number; body: unknown }> {
    return this.send("GET", url, accessToken, undefined);
  }

  post(
    url: string,
    accessToken: string,
    body: unknown,
  ): Promise<{ status: number; body: unknown }> {
    return this.send("POST", url, accessToken, body);
  }

  put(
    url: string,
    accessToken: string,
    body: unknown,
  ): Promise<{ status: number; body: unknown }> {
    return this.send("PUT", url, accessToken, body);
  }

  delete(url: string, accessToken: string): Promise<{ status: number; body: unknown }> {
    return this.send("DELETE", url, accessToken, undefined);
  }

  private async send(
    method: HttpMethod,
    url: string,
    accessToken: string,
    body: unknown,
  ): Promise<{ status: number; body: unknown }> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
    };
    let payload: string | undefined;
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
      payload = JSON.stringify(body);
    }
    const response = await this.http.request(method, url, headers, payload, {
      timeoutMs: this.timeoutMs,
    });
    return { status: response.status, body: parseBody(response.body) };
  }
}

function parseBody(text: string): unknown {
  if (text.trim() === "") return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}
