/**
 * `AuthService`: Google sign-in, sign-out, and session end on device
 * (design: "Google OAuth on device"; R11.2, R11.3, R12.1-R12.5, R12.11,
 * R14.12).
 *
 * - `signIn()` first tries a silent refresh when tokens are still in the
 *   vault (they are kept after a legacy transport-failure session end), then runs
 *   the interactive `AuthClient.authorize()` (PKCE, `access_type: offline`,
 *   `prompt: consent`; see {@link GOOGLE_AUTHORIZE_REQUEST}). It stores
 *   tokens only when the granted scopes include `CALENDAR_SCOPE`, and only in
 *   the {@link TokenVault} (R12.2). Auth state becomes `signed-in`.
 * - Cancel or error → {@link SIGN_IN_INCOMPLETE_MESSAGE}; denied consent or
 *   a missing Calendar scope → {@link CALENDAR_ACCESS_REQUIRED_MESSAGE}. In
 *   both cases nothing is stored and auth state is unchanged.
 *   The id token (never stored) yields a display-only given name saved to
 *   the `profile` document; a missing name keeps the previous one (R18.2).
 * - `signOut()` clears the profile, revokes the grant (best effort), clears the vault, stops
 *   background sync, and sets `signed-out`.
 * - `onSessionEnded()` stops background sync and sets `session-ended`. Only
 *   the auth-state document is written; every other local document is left
 *   untouched (R12.5, R14.12).
 *
 * Tokens never leave this service except through the
 * {@link DeviceAccessTokenProvider} it exposes for the Calendar client.
 */
import { CALENDAR_SCOPE, type OAuthTokens } from "@timeblocker/calendar-integration";
import {
  SESSION_ENDED_MESSAGE,
  isSessionEnded,
  type AuthState,
  type SessionEnded,
  type SessionEndedReason,
} from "../models.js";
import type {
  AuthClient,
  AuthGrant,
  BackgroundJobs,
  Clock,
  TokenVault,
} from "../ports.js";
import type { Repositories } from "../repositories.js";
import { DeviceAccessTokenProvider } from "../tokenProvider.js";
import { GoogleIdTokenProvider } from "./googleIdToken.js";
import { givenNameFromIdToken, subFromIdToken } from "./idToken.js";

/** Shown when the user cancels or sign-in fails (R11.3). */
export const SIGN_IN_INCOMPLETE_MESSAGE = "Sign-in didn't complete. Try again.";

/** Shown when consent is denied or the Calendar scope was not granted (R12.1, R12.11). */
export const CALENDAR_ACCESS_REQUIRED_MESSAGE =
  "TimeBlocker needs Calendar access to work.";

/** OpenID Connect scope: yields an id token (non-sensitive, R18.2). */
export const OPENID_SCOPE = "openid";

/** Basic profile (name) scope (non-sensitive, R18.2). */
export const PROFILE_SCOPE = "profile";

/**
 * The authorization request the `AuthClient` adapter must send (AppAuth
 * config minus the client id and redirect URL, which are build-time values).
 */
export const GOOGLE_AUTHORIZE_REQUEST = Object.freeze({
  issuer: "https://accounts.google.com",
  scopes: Object.freeze([CALENDAR_SCOPE, OPENID_SCOPE, PROFILE_SCOPE]) as readonly string[],
  usePKCE: true,
  additionalParameters: Object.freeze({
    access_type: "offline",
    prompt: "consent",
  }),
});

export type SignInFailure = "incomplete" | "calendar-access-required";

export type SignInResult =
  | { ok: true; via: "silent-refresh" | "authorize" }
  | { ok: false; reason: SignInFailure; message: string };

/** What the UI shows after a session end (R12.5). */
export interface SessionEndedOutcome {
  reason: SessionEndedReason;
  message: typeof SESSION_ENDED_MESSAGE;
}

export interface AuthServiceDeps {
  repos: Repositories;
  vault: TokenVault;
  auth: AuthClient;
  clock: Clock;
  jobs: BackgroundJobs;
}

/**
 * True when `scopes` include the Calendar scope. Entries may themselves be
 * space-separated scope strings (as in a token response's `scope`).
 */
export function hasCalendarScope(scopes: readonly string[]): boolean {
  return scopes.some((s) => s.split(/\s+/).includes(CALENDAR_SCOPE));
}

/**
 * Build the tokens to store from an initial authorization grant, or `null`
 * when the grant has no refresh token (offline access is required, R12.4).
 */
export function tokensFromGrant(grant: AuthGrant): OAuthTokens | null {
  if (!grant.refreshToken || !grant.accessToken) return null;
  return {
    accessToken: grant.accessToken,
    refreshToken: grant.refreshToken,
    expiryDate: grant.expiresAtMs,
    scope: grant.grantedScopes.join(" "),
    tokenType: grant.tokenType || "Bearer",
  };
}

const incomplete = (): SignInResult => ({
  ok: false,
  reason: "incomplete",
  message: SIGN_IN_INCOMPLETE_MESSAGE,
});

const calendarAccessRequired = (): SignInResult => ({
  ok: false,
  reason: "calendar-access-required",
  message: CALENDAR_ACCESS_REQUIRED_MESSAGE,
});

export class AuthService {
  /** Access tokens for the device Calendar client (R12.4). */
  readonly tokenProvider: DeviceAccessTokenProvider;

  /** In-memory Google id token for the AI service (R35.2); never stored. */
  readonly idTokens: GoogleIdTokenProvider;

  private readonly repos: Repositories;
  private readonly vault: TokenVault;
  private readonly auth: AuthClient;
  private readonly jobs: BackgroundJobs;
  private readonly clock: Clock;

  constructor(deps: AuthServiceDeps) {
    this.clock = deps.clock;
    this.repos = deps.repos;
    this.vault = deps.vault;
    this.auth = deps.auth;
    this.jobs = deps.jobs;
    this.idTokens = new GoogleIdTokenProvider({
      clock: deps.clock,
      refresh: () => this.tokenProvider.forceRefresh(),
    });
    this.tokenProvider = new DeviceAccessTokenProvider(deps.vault, deps.auth, deps.clock, (t) =>
      this.idTokens.remember(t),
    );
  }

  /**
   * A fresh Google id token for the AI service, or `undefined` when none can
   * be obtained (offline, signed out, session ended). Never throws and never
   * ends the session (R35.2).
   */
  getIdToken(): Promise<string | undefined> {
    return this.idTokens.getIdToken();
  }

  /** The `sub` of the current id token, for the Settings "Your Google ID" row (R35.1). */
  async googleSub(): Promise<string | undefined> {
    return subFromIdToken(await this.getIdToken());
  }

  /** The persisted auth state (never contains tokens). */
  state(): Promise<AuthState> {
    return this.repos.authState.get();
  }

  /** Whether the app may leave the sign-in screen (R11.2). */
  async isSignedIn(): Promise<boolean> {
    return (await this.state()).status === "signed-in";
  }

  /** "Sign in with Google". */
  async signIn(): Promise<SignInResult> {
    if (await this.trySilentRefresh()) {
      await this.repos.authState.save({ status: "signed-in" });
      return { ok: true, via: "silent-refresh" };
    }

    let result;
    try {
      result = await this.auth.authorize();
    } catch {
      return incomplete();
    }
    switch (result.kind) {
      case "cancelled":
      case "error":
        return incomplete();
      case "denied":
        return calendarAccessRequired();
      case "ok":
        break;
    }

    if (!hasCalendarScope(result.grant.grantedScopes)) return calendarAccessRequired();
    const tokens = tokensFromGrant(result.grant);
    if (!tokens) return incomplete();

    try {
      await this.vault.save(tokens);
    } catch {
      return incomplete();
    }
    await this.repos.authState.save({ status: "signed-in" });
    this.idTokens.remember(result.grant.idToken);
    await this.saveProfileName(result.grant.idToken);
    return { ok: true, via: "authorize" };
  }

  /**
   * Re-run the interactive Google authorization while staying signed in
   * (e.g. once, to pick up the `profile` scope and read the first name).
   * Unlike {@link signIn} it never takes the silent-refresh shortcut, because
   * a refresh does not re-issue an id token. On success the vault tokens are
   * replaced and the name is saved. On cancel, error, denial, or a grant
   * without the Calendar scope or a refresh token, nothing is written: the
   * session, tokens, and local data stay as they were. Never signs out and
   * never ends the session.
   */
  async reconnect(): Promise<SignInResult> {
    let result;
    try {
      result = await this.auth.authorize();
    } catch {
      return incomplete();
    }
    switch (result.kind) {
      case "cancelled":
      case "error":
        return incomplete();
      case "denied":
        return calendarAccessRequired();
      case "ok":
        break;
    }
    if (!hasCalendarScope(result.grant.grantedScopes)) return calendarAccessRequired();
    const tokens = tokensFromGrant(result.grant);
    if (!tokens) return incomplete();
    try {
      await this.vault.save(tokens);
    } catch {
      return incomplete();
    }
    this.idTokens.remember(result.grant.idToken);
    await this.saveProfileName(result.grant.idToken);
    return { ok: true, via: "authorize" };
  }

  /** Revoke (best effort), clear the vault, stop background sync, sign out. */
  async signOut(): Promise<void> {
    const tokens = await this.vault.load();
    if (tokens) {
      try {
        await this.auth.revoke(tokens.refreshToken);
      } catch {
        // Revocation is best effort; the local tokens are cleared regardless.
      }
    }
    await this.vault.clear();
    this.idTokens.forget();
    await this.stopBackgroundSync();
    await this.repos.authState.save({ status: "signed-out" });
    try {
      await this.repos.profile.save({ updatedAt: this.clock.now() });
    } catch {
      // The profile is display-only; sign-out never fails because of it.
    }
  }

  /** Save the id token's given name; keep any previous name when absent. Never throws. */
  private async saveProfileName(idToken: string | undefined): Promise<void> {
    try {
      const givenName = givenNameFromIdToken(idToken);
      if (givenName === undefined) return;
      await this.repos.profile.save({ givenName, updatedAt: this.clock.now() });
    } catch {
      // Display-only; a failed write must not fail sign-in.
    }
  }

  /**
   * Handle a {@link SessionEnded} from the token provider or the Calendar
   * client: stop background sync and mark the session ended. The vault was
   * already handled by the provider (cleared on `invalid-grant`; a network failure
   * is an `AuthTransportError` and never reaches here). No other document is touched (R12.5, R14.12).
   */
  async onSessionEnded(
    ended: SessionEnded | SessionEndedReason,
  ): Promise<SessionEndedOutcome> {
    const reason = isSessionEnded(ended) ? ended.reason : ended;
    await this.stopBackgroundSync();
    await this.repos.authState.save({ status: "session-ended", reason });
    return { reason, message: SESSION_ENDED_MESSAGE };
  }

  /**
   * Recovery for installs that an older build ended with
   * `session-ended`/`transport` on a network failure. When the stored state
   * is exactly that AND the vault still holds tokens, write `signed-in`
   * and return true (the caller restarts background sync and re-syncs).
   * Any other state, or an empty vault, is left untouched (returns false).
   */
  async restoreAfterTransportEnd(): Promise<boolean> {
    const state = await this.state();
    if (state.status !== "session-ended" || state.reason !== "transport") return false;
    const tokens = await this.vault.load();
    if (!tokens) return false;
    await this.repos.authState.save({ status: "signed-in" });
    return true;
  }

  /**
   * When tokens are still in the vault (kept after a transport failure),
   * refresh silently. Returns true when the vault now holds fresh tokens
   * that include the Calendar scope; otherwise the interactive flow runs.
   */
  private async trySilentRefresh(): Promise<boolean> {
    const existing = await this.vault.load();
    if (!existing) return false;
    try {
      await this.tokenProvider.forceRefresh();
    } catch {
      // SessionEnded (invalid grant clears the vault), AuthTransportError (vault kept)
      // or any other failure: fall back to the interactive flow.
      return false;
    }
    const refreshed = await this.vault.load();
    return refreshed !== null && hasCalendarScope([refreshed.scope]);
  }

  private async stopBackgroundSync(): Promise<void> {
    try {
      await this.jobs.stopPeriodicSync();
    } catch {
      // Stopping is best effort; the auth state below still gates sync.
    }
  }
}
