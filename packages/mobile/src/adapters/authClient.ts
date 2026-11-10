/**
 * `AuthClient` over react-native-app-auth 9 (D4, R11.2, R11.3, R12.1,
 * R12.4, R12.5, R12.11).
 *
 * Google Android OAuth client, PKCE, no client secret. The request shape comes
 * from app-core's `GOOGLE_AUTHORIZE_REQUEST` (issuer, Calendar scope, PKCE,
 * `access_type=offline`, `prompt=consent`); the client id and redirect URL
 * come from `src/config.ts`. Google's endpoints are pinned so AppAuth never
 * talks to anything but Google (R12.3).
 *
 * Native errors are mapped to the port's result unions:
 * - authorize: `access_denied` → denied; AppAuth's "User cancelled flow" →
 *   cancelled; anything else → error.
 * - refresh: `invalid_grant` → invalid-grant (vault is cleared by the caller);
 *   anything else → transport-error (vault kept).
 */
import {
  authorize as appAuthAuthorize,
  refresh as appAuthRefresh,
  revoke as appAuthRevoke,
  type AuthConfiguration,
  type AuthorizeResult,
  type RefreshResult as AppAuthRefreshResult,
} from 'react-native-app-auth';
import {
  GOOGLE_AUTHORIZE_REQUEST,
  type AuthClient,
  type AuthGrant,
  type AuthResult,
  type RefreshResult,
} from '@timeblocker/app-core';
import { GOOGLE_OAUTH, isOAuthConfigured, type GoogleOAuthConfig } from '../config';

/** Google's OAuth endpoints (pinned; no discovery fetch needed). */
export const GOOGLE_SERVICE_CONFIGURATION = Object.freeze({
  authorizationEndpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
  tokenEndpoint: 'https://oauth2.googleapis.com/token',
  revocationEndpoint: 'https://oauth2.googleapis.com/revoke',
});

/** Assumed access-token lifetime when AppAuth reports no expiry (Google issues 1 h). */
export const DEFAULT_ACCESS_TOKEN_LIFETIME_MS = 60 * 60 * 1000;

export interface AppAuthClientOptions {
  config?: GoogleOAuthConfig;
  now?: () => number;
}

export class AppAuthClient implements AuthClient {
  private readonly config: GoogleOAuthConfig;
  private readonly now: () => number;

  constructor(options: AppAuthClientOptions = {}) {
    this.config = options.config ?? GOOGLE_OAUTH;
    this.now = options.now ?? Date.now;
  }

  /** The exact AppAuth configuration sent for authorize and refresh. */
  appAuthConfig(): AuthConfiguration {
    return {
      issuer: GOOGLE_AUTHORIZE_REQUEST.issuer,
      serviceConfiguration: { ...GOOGLE_SERVICE_CONFIGURATION },
      clientId: this.config.clientId,
      redirectUrl: this.config.redirectUrl,
      scopes: [...GOOGLE_AUTHORIZE_REQUEST.scopes],
      usePKCE: GOOGLE_AUTHORIZE_REQUEST.usePKCE,
      additionalParameters: { ...GOOGLE_AUTHORIZE_REQUEST.additionalParameters },
    };
  }

  async authorize(): Promise<AuthResult> {
    if (!isOAuthConfigured(this.config)) {
      return { kind: 'error', message: 'Google OAuth client id is not configured' };
    }
    let result: AuthorizeResult;
    try {
      result = await appAuthAuthorize(this.appAuthConfig());
    } catch (e) {
      return mapAuthorizeError(e);
    }
    if (!result || !result.accessToken) {
      return { kind: 'error', message: 'Authorization returned no access token' };
    }
    const grant: AuthGrant = {
      accessToken: result.accessToken,
      expiresAtMs: this.expiresAt(result.accessTokenExpirationDate),
      tokenType: result.tokenType || 'Bearer',
      grantedScopes: grantedScopesOf(result),
      ...(result.refreshToken ? { refreshToken: result.refreshToken } : {}),
      ...(typeof result.idToken === 'string' && result.idToken.length > 0
        ? { idToken: result.idToken }
        : {}),
    };
    return { kind: 'ok', grant };
  }

  async refresh(refreshToken: string): Promise<RefreshResult> {
    let result: AppAuthRefreshResult;
    try {
      result = await appAuthRefresh(this.appAuthConfig(), { refreshToken });
    } catch (e) {
      if (errorCode(e) === 'invalid_grant') return { kind: 'invalid-grant' };
      return { kind: 'transport-error', message: errorMessage(e) };
    }
    if (!result || !result.accessToken) {
      return { kind: 'transport-error', message: 'Refresh returned no access token' };
    }
    const scope = result.additionalParameters?.scope;
    const grant: AuthGrant = {
      accessToken: result.accessToken,
      expiresAtMs: this.expiresAt(result.accessTokenExpirationDate),
      tokenType: result.tokenType || 'Bearer',
      // Empty → the token provider carries the stored scope forward.
      grantedScopes: typeof scope === 'string' ? splitScopes(scope) : [],
      ...(result.refreshToken ? { refreshToken: result.refreshToken } : {}),
      // Google re-issues an id token on refresh; kept in memory only (R35.2).
      ...(typeof result.idToken === 'string' && result.idToken.length > 0
        ? { idToken: result.idToken }
        : {}),
    };
    return { kind: 'ok', grant };
  }

  async revoke(token: string): Promise<void> {
    // AppAuth's revoke resolves with the fetch Response despite its `void` type.
    const response: unknown = await appAuthRevoke(
      { clientId: this.config.clientId, serviceConfiguration: { ...GOOGLE_SERVICE_CONFIGURATION } },
      { tokenToRevoke: token },
    );
    if (isResponseLike(response) && !response.ok) {
      throw new Error(`Token revocation failed with status ${response.status}`);
    }
  }

  private expiresAt(isoDate: string | undefined): number {
    const parsed = typeof isoDate === 'string' ? Date.parse(isoDate) : Number.NaN;
    return Number.isFinite(parsed) ? parsed : this.now() + DEFAULT_ACCESS_TOKEN_LIFETIME_MS;
  }
}

function mapAuthorizeError(e: unknown): AuthResult {
  const code = errorCode(e);
  const message = errorMessage(e);
  if (code === 'access_denied') return { kind: 'denied' };
  // AppAuth-Android: GeneralErrors.USER_CANCELED_AUTH_FLOW → "User cancelled flow".
  if ((code && /cancel/i.test(code)) || (message && /cancel/i.test(message))) {
    return { kind: 'cancelled' };
  }
  return { kind: 'error', message };
}

/** Granted scopes: the token response's `scope` if exposed, else the authorization response's. */
function grantedScopesOf(result: AuthorizeResult): string[] {
  const tokenScope = result.tokenAdditionalParameters?.scope;
  if (typeof tokenScope === 'string') return splitScopes(tokenScope);
  return splitScopes((result.scopes ?? []).join(' '));
}

function splitScopes(scope: string): string[] {
  return [...new Set(scope.split(/\s+/).filter(s => s.length > 0))];
}

function errorCode(e: unknown): string | undefined {
  if (typeof e === 'object' && e !== null && typeof (e as { code?: unknown }).code === 'string') {
    return (e as { code: string }).code;
  }
  return undefined;
}

function errorMessage(e: unknown): string | undefined {
  if (e instanceof Error) return e.message;
  if (typeof e === 'object' && e !== null && typeof (e as { message?: unknown }).message === 'string') {
    return (e as { message: string }).message;
  }
  return typeof e === 'string' ? e : undefined;
}

function isResponseLike(value: unknown): value is { ok: boolean; status: number } {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { ok?: unknown }).ok === 'boolean'
  );
}
