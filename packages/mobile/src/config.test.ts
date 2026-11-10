import {AI_API_BASE_URL, GOOGLE_OAUTH_RELEASE_CLIENT_ID_PLACEHOLDER, AI_HOST_SUFFIX, aiHostOf, isAiConfigured, APPLICATION_ID, GOOGLE_OAUTH, GOOGLE_OAUTH_CLIENT_ID_PLACEHOLDER, isOAuthConfigured, GOOGLE_OAUTH_DEBUG_CLIENT_ID, GOOGLE_OAUTH_RELEASE_CLIENT_ID, oauthClientIdFor } from './config';

describe('Google OAuth config', () => {
  it('uses the Google issuer, the app-id redirect scheme, PKCE, and the Calendar scope', () => {
    expect(APPLICATION_ID).toBe('com.timeblocker.app');
    expect(GOOGLE_OAUTH.issuer).toBe('https://accounts.google.com');
    expect(GOOGLE_OAUTH.redirectUrl).toBe('com.timeblocker.app:/oauth2redirect');
    expect(GOOGLE_OAUTH.usePKCE).toBe(true);
    expect(GOOGLE_OAUTH.scopes).toEqual(['https://www.googleapis.com/auth/calendar']);
  });

  it('holds the placeholder or a real Android client id, and no client secret', () => {
    // Passes both as shipped and after you paste your own client id (README step 3).
    expect(GOOGLE_OAUTH.clientId).toMatch(/\.apps\.googleusercontent\.com$/);
    expect(isOAuthConfigured()).toBe(!GOOGLE_OAUTH.clientId.startsWith('REPLACE_WITH_'));
    expect(isOAuthConfigured({ ...GOOGLE_OAUTH, clientId: GOOGLE_OAUTH_CLIENT_ID_PLACEHOLDER })).toBe(false);
    expect(isOAuthConfigured({ ...GOOGLE_OAUTH, clientId: GOOGLE_OAUTH_RELEASE_CLIENT_ID_PLACEHOLDER })).toBe(false);
    expect(Object.keys(GOOGLE_OAUTH).some(k => /secret/i.test(k))).toBe(false);
  });

  it('reports configured once a real Android client id is set', () => {
    expect(isOAuthConfigured({ ...GOOGLE_OAUTH, clientId: '123-abc.apps.googleusercontent.com' })).toBe(true);
  });
});

describe('AI service config (R35.1, R35.3)', () => {
  it('is either empty (not deployed) or a valid owner API address', () => {
    // Passes as shipped and after the owner pastes the deployed ApiUrl.
    expect(isAiConfigured()).toBe((AI_API_BASE_URL as string) !== '');
    expect(isAiConfigured('')).toBe(false);
  });
  it('accepts only an https address on the owner\'s ca-central-1 API host', () => {
    expect(isAiConfigured(`https://abc123xyz${AI_HOST_SUFFIX}`)).toBe(true);
    expect(isAiConfigured(`https://abc123xyz${AI_HOST_SUFFIX}/`)).toBe(true);
    expect(isAiConfigured(`https://abc123xyz${AI_HOST_SUFFIX}/prod`)).toBe(true);
    expect(aiHostOf(`https://ABC123XYZ${AI_HOST_SUFFIX}`)).toBe(`abc123xyz${AI_HOST_SUFFIX}`);
  });
  it.each([
    '',
    'https://',
    `http://abc123xyz${AI_HOST_SUFFIX}`,
    `https://abc123xyz${AI_HOST_SUFFIX}:8443`,
    `https://user@abc123xyz${AI_HOST_SUFFIX}`,
    `https://abc123xyz${AI_HOST_SUFFIX}.evil.example`,
    `https://evil.example/abc123xyz${AI_HOST_SUFFIX}`,
    `https://a.b${AI_HOST_SUFFIX}`,
    `https://abc123xyz${AI_HOST_SUFFIX.replace('ca-central-1', 'us-east-1')}`,
    'https://example.com',
    'https://www.googleapis.com',
  ])('rejects %p', url => {
    expect(isAiConfigured(url)).toBe(false);
  });
});

describe('one Google OAuth client per signing key', () => {
  it('debug builds use the debug-key client and release builds use the release-key client', () => {
    expect(oauthClientIdFor(true)).toBe(GOOGLE_OAUTH_DEBUG_CLIENT_ID);
    expect(oauthClientIdFor(false)).toBe(GOOGLE_OAUTH_RELEASE_CLIENT_ID);
    // Jest runs as a debug build.
    expect(GOOGLE_OAUTH.clientId).toBe(GOOGLE_OAUTH_DEBUG_CLIENT_ID);
  });
  it('the two clients are different and each is a Google client id or the placeholder', () => {
    expect(GOOGLE_OAUTH_RELEASE_CLIENT_ID).not.toBe(GOOGLE_OAUTH_DEBUG_CLIENT_ID);
    for (const id of [GOOGLE_OAUTH_DEBUG_CLIENT_ID, GOOGLE_OAUTH_RELEASE_CLIENT_ID]) {
      expect(id).toMatch(/\.apps\.googleusercontent\.com$/);
    }
  });
});
