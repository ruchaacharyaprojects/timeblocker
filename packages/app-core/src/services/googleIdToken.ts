/**
 * `GoogleIdTokenProvider`: the Google id token used as the Bearer token for
 * the AI service (R35.2, R35.3, D30).
 *
 * SECURITY: the token is held IN MEMORY ONLY. It is never written to the
 * vault, the key-value store, or any log. `remember` is fed by the token
 * machinery whenever ANY authorize or refresh returns an id token (including
 * refreshes made for Calendar calls). `getIdToken` returns the remembered
 * token while it has more than 60 s left; otherwise it triggers one refresh
 * through the existing token refresh and returns the token that refresh
 * remembered.
 *
 * Failure is soft: a network failure ({@link AuthTransportError}), a session
 * end, or any other error makes `getIdToken` return `undefined` (the caller
 * treats AI as unavailable). It never ends the session and never throws.
 */
import type { Clock } from "../ports.js";
import { expFromIdToken } from "./idToken.js";

/** Refresh when the token has this much or less time left (R35.2). */
export const ID_TOKEN_REFRESH_WINDOW_MS = 60_000;

export interface GoogleIdTokenProviderDeps {
  clock: Clock;
  /** Run one token refresh; the refresh hands any new id token to `remember`. */
  refresh: () => Promise<unknown>;
}

export class GoogleIdTokenProvider {
  private token: string | undefined;
  private expMs = 0;
  private inFlight: Promise<void> | null = null;

  constructor(private readonly deps: GoogleIdTokenProviderDeps) {}

  /** Keep `idToken` in memory if it is a JWT with a readable `exp`. */
  remember(idToken: string | undefined | null): void {
    if (typeof idToken !== "string" || idToken.length === 0) return;
    const exp = expFromIdToken(idToken);
    if (exp === undefined) return;
    this.token = idToken;
    this.expMs = exp * 1000;
  }

  /** Drop the remembered token (sign-out). */
  forget(): void {
    this.token = undefined;
    this.expMs = 0;
  }

  /** A token with more than 60 s left, refreshing once if needed; else `undefined`. */
  async getIdToken(): Promise<string | undefined> {
    if (this.usable(ID_TOKEN_REFRESH_WINDOW_MS)) return this.token;
    try {
      await this.refreshShared();
    } catch {
      // Network failure or session end: AI is simply unavailable (never ends the session).
      return undefined;
    }
    // After a refresh any unexpired token will do for this call.
    return this.usable(0) ? this.token : undefined;
  }

  private usable(windowMs: number): boolean {
    return this.token !== undefined && this.expMs - this.deps.clock.now() > windowMs;
  }

  private refreshShared(): Promise<void> {
    if (this.inFlight) return this.inFlight;
    const run = Promise.resolve()
      .then(() => this.deps.refresh())
      .then(() => undefined)
      .finally(() => {
        if (this.inFlight === run) this.inFlight = null;
      });
    this.inFlight = run;
    return run;
  }
}
