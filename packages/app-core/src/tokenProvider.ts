/**
 * On-device Google access tokens (design: "Google OAuth on device",
 * R12.4, R12.5).
 *
 * {@link DeviceAccessTokenProvider} implements the existing
 * `AccessTokenProvider` over the Keystore-backed {@link TokenVault} and the
 * AppAuth-backed {@link AuthClient}. {@link withUnauthorizedRetry} wraps a
 * {@link CalendarApi} so a Calendar `401` triggers one forced refresh and
 * one retry; a second `401` ends the session.
 */
import {
  CalendarHttpError,
  isExpired,
  type AccessTokenProvider,
  type CalendarEvent,
  type OAuthTokens,
} from "@timeblocker/calendar-integration";
import type { Week } from "@timeblocker/scheduling-engine";
import {
  createDeviceCalendarApi,
  type DeviceCalendarApiOptions,
} from "./calendarApi.js";
import { SessionEnded } from "./models.js";
import type {
  AuthClient,
  AuthGrant,
  CalendarApi,
  CalendarBlockWrite,
  Clock,
  HttpTransport,
  TokenVault,
} from "./ports.js";

/**
 * Turn a refresh grant into the tokens to persist. Google usually omits the
 * refresh token (and may omit scopes) on refresh; the stored values carry
 * forward in that case.
 */
export function rotateTokens(previous: OAuthTokens, grant: AuthGrant): OAuthTokens {
  return {
    accessToken: grant.accessToken,
    refreshToken: grant.refreshToken ?? previous.refreshToken,
    expiryDate: grant.expiresAtMs,
    scope:
      grant.grantedScopes.length > 0
        ? grant.grantedScopes.join(" ")
        : previous.scope,
    tokenType: grant.tokenType || previous.tokenType,
  };
}

/**
 * The token refresh failed because of the network (AppAuth transport error
 * or a thrown failure). The tokens are intact and nothing was revoked, so
 * this is deliberately NOT a {@link SessionEnded}: it must never reach
 * `AuthService.onSessionEnded` (R14.10; session end is only for missing /
 * invalid-grant / revoked authorization, R12.5, R14.12).
 */
export class AuthTransportError extends Error {
  constructor(message = "Token refresh failed: network unavailable") {
    super(message);
    this.name = "AuthTransportError";
  }
}

/** Narrow an unknown thrown value to {@link AuthTransportError}. */
export function isAuthTransportError(error: unknown): error is AuthTransportError {
  return error instanceof AuthTransportError;
}

/**
 * `AccessTokenProvider` for on-device mode.
 *
 * - No tokens in the vault → `SessionEnded("missing")`.
 * - Access token expired or expiring within 60 s (`isExpired`) → exactly one
 *   `AuthClient.refresh` for that request; concurrent callers share one
 *   in-flight refresh.
 * - Refresh ok → rotated tokens saved to the vault, new access token returned.
 * - `invalid-grant` → vault cleared, `SessionEnded("invalid-grant")`.
 * - Transport failure (result or thrown) → vault kept, {@link AuthTransportError}.
 *   A network problem is NOT a session end: callers treat it like any other
 *   network error (soft failure, retry on the next sync; R14.10).
 *
 * Tokens never leave this class except as the return value handed to the
 * Calendar client (R12.3).
 */
export class DeviceAccessTokenProvider implements AccessTokenProvider {
  private inFlight: Promise<string> | null = null;

  constructor(
    private readonly vault: TokenVault,
    private readonly auth: AuthClient,
    private readonly clock: Clock,
    /**
     * Receives the id token of every successful refresh, for the in-memory
     * `GoogleIdTokenProvider` (R35.2). It is never stored.
     */
    private readonly onIdToken?: (idToken: string) => void,
  ) {}

  async getValidAccessToken(): Promise<string> {
    // Join a refresh already under way rather than starting a second one.
    if (this.inFlight) return this.inFlight;
    const tokens = await this.vault.load();
    if (!tokens) throw new SessionEnded("missing");
    if (!isExpired(tokens, this.clock.now())) return tokens.accessToken;
    return this.refreshShared(tokens);
  }

  /**
   * Refresh regardless of expiry (after a Calendar `401`). Shares any
   * refresh already in flight.
   */
  async forceRefresh(): Promise<string> {
    if (this.inFlight) return this.inFlight;
    const tokens = await this.vault.load();
    if (!tokens) throw new SessionEnded("missing");
    return this.refreshShared(tokens);
  }

  private refreshShared(tokens: OAuthTokens): Promise<string> {
    // A concurrent caller may have started one while we awaited the vault.
    if (this.inFlight) return this.inFlight;
    const run = this.refreshOnce(tokens).finally(() => {
      if (this.inFlight === run) this.inFlight = null;
    });
    this.inFlight = run;
    return run;
  }

  private async refreshOnce(tokens: OAuthTokens): Promise<string> {
    let result;
    try {
      result = await this.auth.refresh(tokens.refreshToken);
    } catch {
      throw new AuthTransportError();
    }
    switch (result.kind) {
      case "ok": {
        const rotated = rotateTokens(tokens, result.grant);
        await this.vault.save(rotated);
        if (result.grant.idToken) {
          try {
            this.onIdToken?.(result.grant.idToken);
          } catch {
            // The id token is optional; never fail a Calendar refresh over it.
          }
        }
        return rotated.accessToken;
      }
      case "invalid-grant":
        await this.vault.clear();
        throw new SessionEnded("invalid-grant");
      case "transport-error":
        throw new AuthTransportError();
    }
  }
}

/** A token provider that can be forced to refresh after a `401`. */
export interface RefreshableTokenProvider {
  forceRefresh(): Promise<string>;
}

function isUnauthorized(error: unknown): boolean {
  return error instanceof CalendarHttpError && error.status === 401;
}

/**
 * Wrap a {@link CalendarApi} so a `401` triggers one forced refresh and one
 * retry of the same call; a second `401` throws `SessionEnded("revoked")`.
 * A failed forced refresh surfaces its own `SessionEnded` or
 * `AuthTransportError` (network; not a session end). All other errors
 * pass through unchanged.
 */
export function withUnauthorizedRetry(
  api: CalendarApi,
  tokens: RefreshableTokenProvider,
): CalendarApi {
  async function call<T>(op: () => Promise<T>): Promise<T> {
    try {
      return await op();
    } catch (error) {
      if (!isUnauthorized(error)) throw error;
    }
    await tokens.forceRefresh();
    try {
      return await op();
    } catch (error) {
      if (isUnauthorized(error)) throw new SessionEnded("revoked");
      throw error;
    }
  }
  return {
    readWeek: (week: Week): Promise<CalendarEvent[]> =>
      call(() => api.readWeek(week)),
    getEvent: (eventId: string): Promise<CalendarEvent | "deleted"> =>
      call(() => api.getEvent(eventId)),
    upsertBlock: (block: CalendarBlockWrite): Promise<string | "deleted"> =>
      call(() => api.upsertBlock(block)),
    deleteBlock: (eventId: string): Promise<void> =>
      call(() => api.deleteBlock(eventId)),
    readHolidays: (calendarId: string, timeMin: string, timeMax: string) =>
      call(async () => (await api.readHolidays?.(calendarId, timeMin, timeMax)) ?? []),
  };
}

/**
 * The device {@link CalendarApi} with token handling: Google Calendar via
 * {@link createDeviceCalendarApi} (Google-only HTTP), tokens from `provider`,
 * and the single forced refresh + retry on `401`.
 */
export function createAuthorizedCalendarApi(
  provider: AccessTokenProvider & RefreshableTokenProvider,
  transport: HttpTransport,
  options: DeviceCalendarApiOptions = {},
): CalendarApi {
  return withUnauthorizedRetry(
    createDeviceCalendarApi(provider, transport, options),
    provider,
  );
}
