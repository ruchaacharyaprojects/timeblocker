import { authorize, refresh, revoke } from 'react-native-app-auth';
import { CALENDAR_SCOPE } from '@timeblocker/calendar-integration';
import { AppAuthClient, DEFAULT_ACCESS_TOKEN_LIFETIME_MS, GOOGLE_SERVICE_CONFIGURATION } from './authClient';
import { GOOGLE_OAUTH, GOOGLE_OAUTH_CLIENT_ID_PLACEHOLDER } from '../config';

jest.mock('react-native-app-auth', () => ({
  __esModule: true,
  authorize: jest.fn(),
  refresh: jest.fn(),
  revoke: jest.fn(),
}));

const mockAuthorize = authorize as jest.MockedFunction<typeof authorize>;
const mockRefresh = refresh as jest.MockedFunction<typeof refresh>;
const mockRevoke = revoke as jest.MockedFunction<typeof revoke>;

const CLIENT_ID = '123-abc.apps.googleusercontent.com';
const NOW = Date.UTC(2026, 0, 5, 9, 0, 0);
const client = () => new AppAuthClient({ config: { ...GOOGLE_OAUTH, clientId: CLIENT_ID }, now: () => NOW });

/** An Error shaped like a react-native promise rejection. */
const nativeError = (code: string, message: string) => Object.assign(new Error(message), { code });

const authorizeResult = (overrides: Partial<Awaited<ReturnType<typeof authorize>>> = {}) => ({
  accessToken: 'at',
  accessTokenExpirationDate: '2026-01-05T10:00:00Z',
  idToken: '',
  refreshToken: 'rt',
  tokenType: 'Bearer',
  scopes: [CALENDAR_SCOPE],
  authorizationCode: 'code',
  ...overrides,
});

beforeEach(() => jest.resetAllMocks());

describe('AppAuthClient.authorize', () => {
  it('sends the Google PKCE request with offline access and consent, and no client secret', async () => {
    mockAuthorize.mockResolvedValue(authorizeResult());
    await client().authorize();
    const config = mockAuthorize.mock.calls[0]![0];
    expect(config).toEqual({
      issuer: 'https://accounts.google.com',
      serviceConfiguration: GOOGLE_SERVICE_CONFIGURATION,
      clientId: CLIENT_ID,
      redirectUrl: 'com.timeblocker.app:/oauth2redirect',
      scopes: [CALENDAR_SCOPE, 'openid', 'profile'],
      usePKCE: true,
      additionalParameters: { access_type: 'offline', prompt: 'consent' },
    });
    expect(Object.keys(config).some(k => /secret/i.test(k))).toBe(false);
  });

  it('maps a success to a grant with absolute expiry and the granted scopes', async () => {
    mockAuthorize.mockResolvedValue(authorizeResult());
    expect(await client().authorize()).toEqual({
      kind: 'ok',
      grant: {
        accessToken: 'at',
        refreshToken: 'rt',
        expiresAtMs: Date.UTC(2026, 0, 5, 10, 0, 0),
        tokenType: 'Bearer',
        grantedScopes: [CALENDAR_SCOPE],
      },
    });
  });

  it('forwards a non-empty id token and omits an empty or missing one', async () => {
    mockAuthorize.mockResolvedValue(authorizeResult({ idToken: 'a.b.c' }));
    const withToken = await client().authorize();
    expect(withToken.kind === 'ok' && withToken.grant.idToken).toBe('a.b.c');

    mockAuthorize.mockResolvedValue(authorizeResult({ idToken: '' }));
    const empty = await client().authorize();
    expect(empty.kind === 'ok' && 'idToken' in empty.grant).toBe(false);

    mockAuthorize.mockResolvedValue(authorizeResult({ idToken: undefined as unknown as string }));
    const missing = await client().authorize();
    expect(missing.kind === 'ok' && 'idToken' in missing.grant).toBe(false);
  });

  it('reports exactly the scopes Google granted (granular consent can drop Calendar)', async () => {
    mockAuthorize.mockResolvedValue(authorizeResult({ scopes: ['openid', 'email'] }));
    const result = await client().authorize();
    expect(result.kind === 'ok' && result.grant.grantedScopes).toEqual(['openid', 'email']);

    mockAuthorize.mockResolvedValue(
      authorizeResult({ scopes: [CALENDAR_SCOPE], tokenAdditionalParameters: { scope: 'openid' } }),
    );
    const fromToken = await client().authorize();
    expect(fromToken.kind === 'ok' && fromToken.grant.grantedScopes).toEqual(['openid']);
  });

  it('omits a missing refresh token and defaults the expiry when absent', async () => {
    mockAuthorize.mockResolvedValue(authorizeResult({ refreshToken: '', accessTokenExpirationDate: '' }));
    const result = await client().authorize();
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(result.grant.refreshToken).toBeUndefined();
    expect(result.grant.expiresAtMs).toBe(NOW + DEFAULT_ACCESS_TOKEN_LIFETIME_MS);
  });

  it.each([
    [nativeError('authentication_error', 'User cancelled flow'), { kind: 'cancelled' }],
    [nativeError('access_denied', 'The user denied access'), { kind: 'denied' }],
    [nativeError('browser_not_found', 'No browser'), { kind: 'error', message: 'No browser' }],
    [nativeError('token_exchange_failed', 'Network error'), { kind: 'error', message: 'Network error' }],
  ])('maps %p to %p', async (error, expected) => {
    mockAuthorize.mockRejectedValue(error);
    expect(await client().authorize()).toEqual(expected);
  });

  it('refuses to start without a real client id', async () => {
    // Pass the placeholder explicitly so the test does not depend on the id pasted into src/config.ts.
    const placeholder = { ...GOOGLE_OAUTH, clientId: GOOGLE_OAUTH_CLIENT_ID_PLACEHOLDER };
    const result = await new AppAuthClient({ config: placeholder }).authorize();
    expect(result.kind).toBe('error');
    expect(mockAuthorize).not.toHaveBeenCalled();
  });
});

describe('AppAuthClient.refresh', () => {
  it('maps a refresh success; rotated refresh token is kept, scopes empty unless returned', async () => {
    mockRefresh.mockResolvedValue({
      accessToken: 'at2',
      accessTokenExpirationDate: '2026-01-05T11:00:00Z',
      idToken: '',
      refreshToken: null,
      tokenType: 'Bearer',
    });
    expect(await client().refresh('rt')).toEqual({
      kind: 'ok',
      grant: { accessToken: 'at2', expiresAtMs: Date.UTC(2026, 0, 5, 11), tokenType: 'Bearer', grantedScopes: [] },
    });
    expect(mockRefresh.mock.calls[0]![1]).toEqual({ refreshToken: 'rt' });

    mockRefresh.mockResolvedValue({
      accessToken: 'at3',
      accessTokenExpirationDate: '2026-01-05T11:00:00Z',
      idToken: '',
      refreshToken: 'rt2',
      tokenType: 'Bearer',
      additionalParameters: { scope: CALENDAR_SCOPE },
    });
    const rotated = await client().refresh('rt');
    expect(rotated.kind === 'ok' && rotated.grant).toMatchObject({ refreshToken: 'rt2', grantedScopes: [CALENDAR_SCOPE] });
  });

  it('forwards a non-empty id token from the refresh result (R35.2) and omits an empty one', async () => {
    const base = {
      accessToken: 'at2',
      accessTokenExpirationDate: '2026-01-05T11:00:00Z',
      refreshToken: null,
      tokenType: 'Bearer',
    };
    mockRefresh.mockResolvedValueOnce({ ...base, idToken: 'header.payload.sig' });
    const withId = await client().refresh('rt');
    expect(withId.kind === 'ok' && withId.grant.idToken).toBe('header.payload.sig');
    mockRefresh.mockResolvedValueOnce({ ...base, idToken: '' });
    const empty = await client().refresh('rt');
    expect(empty.kind === 'ok' && 'idToken' in empty.grant).toBe(false);
    mockRefresh.mockResolvedValueOnce({ ...base, idToken: undefined as unknown as string });
    const missing = await client().refresh('rt');
    expect(missing.kind === 'ok' && 'idToken' in missing.grant).toBe(false);
  });
  it('maps invalid_grant to invalid-grant and other failures to transport-error', async () => {
    mockRefresh.mockRejectedValueOnce(nativeError('invalid_grant', 'Token has been expired or revoked.'));
    expect(await client().refresh('rt')).toEqual({ kind: 'invalid-grant' });
    mockRefresh.mockRejectedValueOnce(nativeError('token_refresh_failed', 'Network error'));
    expect(await client().refresh('rt')).toEqual({ kind: 'transport-error', message: 'Network error' });
  });
});

describe('AppAuthClient.revoke', () => {
  it('revokes at Google’s revocation endpoint', async () => {
    mockRevoke.mockResolvedValue({ ok: true, status: 200 } as never);
    await client().revoke('rt');
    expect(mockRevoke).toHaveBeenCalledWith(
      { clientId: CLIENT_ID, serviceConfiguration: GOOGLE_SERVICE_CONFIGURATION },
      { tokenToRevoke: 'rt' },
    );
  });

  it('throws on a non-2xx revocation response', async () => {
    mockRevoke.mockResolvedValue({ ok: false, status: 400 } as never);
    await expect(client().revoke('rt')).rejects.toThrow(/400/);
  });
});
