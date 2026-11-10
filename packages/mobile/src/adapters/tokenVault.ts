/**
 * `TokenVault` over react-native-keychain 10 (D5, R12.2).
 *
 * The Google tokens are stored as one JSON generic password under service
 * `timeblocker.google`, encrypted with an Android Keystore AES-GCM key. The
 * no-auth storage type is used on purpose: headless sync must read the tokens
 * without a biometric prompt. This is the only place tokens are persisted.
 */
import * as Keychain from 'react-native-keychain';
import type { OAuthTokens } from '@timeblocker/calendar-integration';
import type { TokenVault } from '@timeblocker/app-core';

export const TOKEN_VAULT_SERVICE = 'timeblocker.google';
/** Keychain "username" for the single stored credential. */
export const TOKEN_VAULT_USERNAME = 'google-oauth';

/** True when `value` has the exact shape of {@link OAuthTokens}. */
export function isOAuthTokens(value: unknown): value is OAuthTokens {
  if (typeof value !== 'object' || value === null) return false;
  const t = value as Record<string, unknown>;
  return (
    typeof t.accessToken === 'string' &&
    typeof t.refreshToken === 'string' &&
    typeof t.expiryDate === 'number' &&
    Number.isFinite(t.expiryDate) &&
    typeof t.scope === 'string' &&
    typeof t.tokenType === 'string'
  );
}

export class KeychainTokenVault implements TokenVault {
  constructor(private readonly service: string = TOKEN_VAULT_SERVICE) {}

  async load(): Promise<OAuthTokens | null> {
    const credentials = await Keychain.getGenericPassword({ service: this.service });
    if (!credentials) return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(credentials.password);
    } catch {
      return null; // Unreadable entry: treat as signed out.
    }
    if (!isOAuthTokens(parsed)) return null;
    return {
      accessToken: parsed.accessToken,
      refreshToken: parsed.refreshToken,
      expiryDate: parsed.expiryDate,
      scope: parsed.scope,
      tokenType: parsed.tokenType,
    };
  }

  async save(tokens: OAuthTokens): Promise<void> {
    const stored: OAuthTokens = {
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiryDate: tokens.expiryDate,
      scope: tokens.scope,
      tokenType: tokens.tokenType,
    };
    const result = await Keychain.setGenericPassword(TOKEN_VAULT_USERNAME, JSON.stringify(stored), {
      service: this.service,
      storage: Keychain.STORAGE_TYPE.AES_GCM_NO_AUTH,
    });
    if (result === false) throw new Error('Could not save Google tokens to the keystore');
  }

  async clear(): Promise<void> {
    await Keychain.resetGenericPassword({ service: this.service });
  }
}
