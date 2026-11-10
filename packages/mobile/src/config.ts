/**
 * Device-side configuration. Nothing here is secret.
 *
 * Google OAuth uses an Android client (package name + SHA-1 of the signing key)
 * with PKCE. There is deliberately NO client secret: installed apps cannot keep
 * one, and AppAuth sends a `code_verifier` at the token exchange instead.
 *
 * Setup: Google Cloud Console → Credentials → OAuth client ID (Android) for
 * package `com.timeblocker.app`, enable "Custom URI scheme" in Advanced
 * settings, then paste the client ID below.
 */

/** Android application id; also the OAuth redirect scheme. */
export const APPLICATION_ID = 'com.timeblocker.app';

/** Placeholder until the user creates the Google Cloud OAuth client. */
export const GOOGLE_OAUTH_CLIENT_ID_PLACEHOLDER = 'REPLACE_WITH_ANDROID_CLIENT_ID.apps.googleusercontent.com';
/** Placeholder for the release-key client (a separate Google client, see below). */
export const GOOGLE_OAUTH_RELEASE_CLIENT_ID_PLACEHOLDER = 'REPLACE_WITH_RELEASE_ANDROID_CLIENT_ID.apps.googleusercontent.com';

/** Every placeholder starts with this; no real Google client id does. */
const PLACEHOLDER_PREFIX = 'REPLACE_WITH_';

export interface GoogleOAuthConfig {
  readonly issuer: string;
  readonly clientId: string;
  readonly redirectUrl: string;
  readonly scopes: readonly string[];
  readonly usePKCE: true;
}

/**
 * Google ties an Android OAuth client to one signing key (package + SHA-1), so
 * each signing key needs its own client:
 * - debug builds (emulator, Metro) are signed with android/app/debug.keystore;
 * - release APKs are signed with the personal key in ~/.android (never committed).
 * The AI service accepts ID tokens for both clients (TimeBlockerAiStack googleClientId).
 */
export const GOOGLE_OAUTH_DEBUG_CLIENT_ID: string = GOOGLE_OAUTH_CLIENT_ID_PLACEHOLDER;
/** Android OAuth client for the personal release key. Placeholder until it is created. */
export const GOOGLE_OAUTH_RELEASE_CLIENT_ID: string = GOOGLE_OAUTH_RELEASE_CLIENT_ID_PLACEHOLDER;

/** The client for this build: `__DEV__` is true in debug builds and false in release APKs. */
export function oauthClientIdFor(isDev: boolean): string {
  return isDev ? GOOGLE_OAUTH_DEBUG_CLIENT_ID : GOOGLE_OAUTH_RELEASE_CLIENT_ID;
}

export const GOOGLE_OAUTH: GoogleOAuthConfig = {
  issuer: 'https://accounts.google.com',
  clientId: oauthClientIdFor(typeof __DEV__ === 'undefined' ? true : __DEV__),
  redirectUrl: `${APPLICATION_ID}:/oauth2redirect`,
  // Informational only: the scopes actually sent come from app-core's
  // GOOGLE_AUTHORIZE_REQUEST (Calendar + `openid` + `profile` for the name).
  scopes: ['https://www.googleapis.com/auth/calendar'],
  usePKCE: true,
};

/** True once a real client id has replaced the placeholder. */
export function isOAuthConfigured(config: GoogleOAuthConfig = GOOGLE_OAUTH): boolean {
  return !config.clientId.startsWith(PLACEHOLDER_PREFIX) && config.clientId.endsWith('.apps.googleusercontent.com');
}

/**
 * Base URL of the owner's private AI service (`TimeBlockerAiStack` output
 * `ApiUrl`, R32, R35.3). Empty until the owner deploys it: while empty, or if
 * it is not an https address on the owner's API Gateway host, the AI assistant
 * is unavailable and no AI network call is ever made. Paste the `ApiUrl` here
 * after deploying, e.g. `https://abc123xyz.execute-api.ca-central-1.amazonaws.com`.
 */
export const AI_API_BASE_URL: string = '';

/**
 * The only host shape the app will send an id token to: an HTTP API in
 * ca-central-1 (`*.execute-api.ca-central-1.amazonaws.com`). The structural
 * test allows this host only in this file.
 */
export const AI_HOST_SUFFIX = '.execute-api.ca-central-1.amazonaws.com';
const AI_HOST_ID = /^[a-z0-9]{6,20}$/;

/** The host of `baseUrl` when it is an https URL on the owner's API host, else `undefined`. */
export function aiHostOf(baseUrl: string = AI_API_BASE_URL): string | undefined {
  const match = /^https:\/\/([^/?#:@\s]+)(?:\/[^?#\s]*)?$/i.exec(baseUrl.trim());
  const host = match?.[1]?.toLowerCase();
  if (host === undefined || !host.endsWith(AI_HOST_SUFFIX)) return undefined;
  return AI_HOST_ID.test(host.slice(0, -AI_HOST_SUFFIX.length)) ? host : undefined;
}

/** True when `baseUrl` is a usable AI service address (never true for the empty placeholder). */
export function isAiConfigured(baseUrl: string = AI_API_BASE_URL): boolean {
  return aiHostOf(baseUrl) !== undefined;
}
