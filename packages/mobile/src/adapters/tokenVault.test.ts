import * as Keychain from 'react-native-keychain';
import type { OAuthTokens } from '@timeblocker/calendar-integration';
import { KeychainTokenVault, TOKEN_VAULT_SERVICE } from './tokenVault';

jest.mock('react-native-keychain', () => {
  // A tiny in-memory keychain keyed by service.
  const items = new Map<string, { username: string; password: string }>();
  return {
    __esModule: true,
    STORAGE_TYPE: { AES_GCM_NO_AUTH: 'KeystoreAESGCM_NoAuth' },
    setGenericPassword: jest.fn(async (username: string, password: string, options?: { service?: string }) => {
      items.set(options?.service ?? 'default', { username, password });
      return { service: options?.service, storage: 'KeystoreAESGCM_NoAuth' };
    }),
    getGenericPassword: jest.fn(async (options?: { service?: string }) => {
      const item = items.get(options?.service ?? 'default');
      return item ? { ...item, service: options?.service, storage: 'KeystoreAESGCM_NoAuth' } : false;
    }),
    resetGenericPassword: jest.fn(async (options?: { service?: string }) => items.delete(options?.service ?? 'default')),
  };
});

const mocked = Keychain as jest.Mocked<typeof Keychain>;

const tokens: OAuthTokens = {
  accessToken: 'at',
  refreshToken: 'rt',
  expiryDate: 1_700_000_000_000,
  scope: 'https://www.googleapis.com/auth/calendar',
  tokenType: 'Bearer',
};

describe('KeychainTokenVault', () => {
  it('saves under service "timeblocker.google" with Keystore AES-GCM (no user auth) and loads it back', async () => {
    const vault = new KeychainTokenVault();
    await vault.clear();
    expect(await vault.load()).toBeNull();
    await vault.save({ ...tokens, extra: 'dropped' } as OAuthTokens);
    expect(mocked.setGenericPassword).toHaveBeenCalledWith(expect.any(String), expect.any(String), {
      service: TOKEN_VAULT_SERVICE,
      storage: Keychain.STORAGE_TYPE.AES_GCM_NO_AUTH,
    });
    expect(TOKEN_VAULT_SERVICE).toBe('timeblocker.google');
    expect(await vault.load()).toEqual(tokens);
  });

  it('clear() resets the service entry', async () => {
    const vault = new KeychainTokenVault();
    await vault.save(tokens);
    await vault.clear();
    expect(mocked.resetGenericPassword).toHaveBeenCalledWith({ service: TOKEN_VAULT_SERVICE });
    expect(await vault.load()).toBeNull();
  });

  it('treats an unreadable or malformed entry as no tokens', async () => {
    const vault = new KeychainTokenVault();
    await Keychain.setGenericPassword('x', 'not json', { service: TOKEN_VAULT_SERVICE });
    expect(await vault.load()).toBeNull();
    await Keychain.setGenericPassword('x', JSON.stringify({ accessToken: 'at' }), { service: TOKEN_VAULT_SERVICE });
    expect(await vault.load()).toBeNull();
  });

  it('throws when the keychain refuses to save', async () => {
    mocked.setGenericPassword.mockResolvedValueOnce(false);
    await expect(new KeychainTokenVault().save(tokens)).rejects.toThrow(/keystore/);
  });
});
