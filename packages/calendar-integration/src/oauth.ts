/**
 * Google OAuth flow for the Calendar scopes (R4.1).
 *
 * The URL building, token-expiry decision, and token-response parsing are
 * pure functions. The networked exchange/refresh calls go through an injected
 * {@link HttpClient} so the flow is unit-testable without hitting Google, and
 * token persistence goes through a {@link TokenStore} (backed by Secrets
 * Manager in production — see `secrets.ts`).
 */

import {
  CALENDAR_SCOPE,
  type OAuthClientConfig,
  type OAuthTokens,
} from "./types.js";

const GOOGLE_AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";

/** Refresh the access token this many ms before it actually expires. */
export const EXPIRY_SKEW_MS = 60_000;

/** Minimal HTTP port so the OAuth client needs no concrete fetch dependency. */
export interface HttpClient {
  postForm(
    url: string,
    form: Record<string, string>,
  ): Promise<{ status: number; body: unknown }>;
}

/** Persistence port for OAuth tokens (Secrets Manager in production). */
export interface TokenStore {
  load(): Promise<OAuthTokens | null>;
  save(tokens: OAuthTokens): Promise<void>;
}

/**
 * Build the Google consent URL requesting the Calendar scope with offline
 * access (so Google returns a refresh token) and forced consent.
 */
export function buildAuthUrl(
  config: OAuthClientConfig,
  opts: { state?: string } = {},
): string {
  const params = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    response_type: "code",
    scope: CALENDAR_SCOPE,
    access_type: "offline",
    prompt: "consent",
  });
  if (opts.state) params.set("state", opts.state);
  return `${GOOGLE_AUTH_ENDPOINT}?${params.toString()}`;
}

/** The raw token response Google returns from the token endpoint. */
interface GoogleTokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  token_type?: string;
}

/**
 * Parse a Google token response into {@link OAuthTokens}. `now` lets callers
 * compute a deterministic absolute expiry. When refreshing, Google may omit
 * `refresh_token`; `previousRefreshToken` is carried forward in that case.
 */
export function parseTokenResponse(
  body: unknown,
  now: number,
  previousRefreshToken?: string,
): OAuthTokens {
  const res = (body ?? {}) as GoogleTokenResponse;
  if (!res.access_token) {
    throw new Error("Google token response missing access_token");
  }
  const refreshToken = res.refresh_token ?? previousRefreshToken;
  if (!refreshToken) {
    throw new Error("Google token response missing refresh_token");
  }
  const expiresInMs = (res.expires_in ?? 0) * 1000;
  return {
    accessToken: res.access_token,
    refreshToken,
    expiryDate: now + expiresInMs,
    scope: res.scope ?? CALENDAR_SCOPE,
    tokenType: res.token_type ?? "Bearer",
  };
}

/** True when `tokens` are expired (or within the refresh skew) at `now`. */
export function isExpired(tokens: OAuthTokens, now: number): boolean {
  return now >= tokens.expiryDate - EXPIRY_SKEW_MS;
}

/**
 * OAuth client that completes the code exchange, refreshes access tokens, and
 * persists them to the token store. Pure decisions are delegated to the
 * functions above so the networked parts stay thin.
 */
export class GoogleOAuthClient {
  constructor(
    private readonly config: OAuthClientConfig,
    private readonly http: HttpClient,
    private readonly store: TokenStore,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** The consent URL the user is sent to (R4.1 OAuth with Calendar scopes). */
  authUrl(state?: string): string {
    return buildAuthUrl(this.config, { state });
  }

  /** Exchange an authorization code for tokens and persist them. */
  async exchangeCode(code: string): Promise<OAuthTokens> {
    const { status, body } = await this.http.postForm(GOOGLE_TOKEN_ENDPOINT, {
      client_id: this.config.clientId,
      client_secret: this.config.clientSecret,
      redirect_uri: this.config.redirectUri,
      grant_type: "authorization_code",
      code,
    });
    if (status < 200 || status >= 300) {
      throw new Error(`Google token exchange failed with status ${status}`);
    }
    const tokens = parseTokenResponse(body, this.now());
    await this.store.save(tokens);
    return tokens;
  }

  /** Force a refresh using the stored refresh token and persist the result. */
  async refresh(existing: OAuthTokens): Promise<OAuthTokens> {
    const { status, body } = await this.http.postForm(GOOGLE_TOKEN_ENDPOINT, {
      client_id: this.config.clientId,
      client_secret: this.config.clientSecret,
      grant_type: "refresh_token",
      refresh_token: existing.refreshToken,
    });
    if (status < 200 || status >= 300) {
      throw new Error(`Google token refresh failed with status ${status}`);
    }
    const tokens = parseTokenResponse(body, this.now(), existing.refreshToken);
    await this.store.save(tokens);
    return tokens;
  }

  /**
   * Return a currently-valid access token, refreshing and re-persisting if the
   * stored token is missing or expired. Throws if no tokens are stored (the
   * user has not completed the consent flow).
   */
  async getValidAccessToken(): Promise<string> {
    const existing = await this.store.load();
    if (!existing) {
      throw new Error("No stored Google OAuth tokens; consent flow required");
    }
    if (isExpired(existing, this.now())) {
      const refreshed = await this.refresh(existing);
      return refreshed.accessToken;
    }
    return existing.accessToken;
  }
}
