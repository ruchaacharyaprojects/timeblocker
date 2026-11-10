/**
 * {@link TokenStore} implementations for Google OAuth tokens.
 *
 * Per design.md (v1), Google OAuth tokens live in the DynamoDB settings table,
 * encrypted at rest — see {@link DynamoDBTokenStore}. A Secrets Manager-backed
 * store ({@link SecretsManagerTokenStore}) is kept as an option. Rather than
 * take a hard dependency on the AWS SDK (which would pull a networked client
 * into this otherwise-pure package), each store talks to a small injected port
 * ({@link SecretsManagerPort} / {@link TokenTablePort}). In production those
 * ports are thin adapters over the AWS SDK; in tests they are in-memory fakes.
 * The JSON (de)serialization of the token payload is pure and unit-tested here
 * and shared by both stores.
 */

import type { TokenStore } from "./oauth.js";
import type { OAuthTokens } from "./types.js";

/** Minimal Secrets Manager surface the token store needs. */
export interface SecretsManagerPort {
  /** Return the secret string for `secretId`, or null if it does not exist. */
  getSecretString(secretId: string): Promise<string | null>;
  /** Create or overwrite the secret string for `secretId`. */
  putSecretString(secretId: string, value: string): Promise<void>;
}

/** Serialize tokens to the stored secret payload (pure). */
export function serializeTokens(tokens: OAuthTokens): string {
  return JSON.stringify(tokens);
}

/**
 * Parse the stored secret payload back into tokens (pure). Returns null for
 * empty input and throws on malformed or incomplete payloads so callers never
 * operate on half-formed credentials.
 */
export function deserializeTokens(payload: string | null): OAuthTokens | null {
  if (!payload) return null;
  const parsed = JSON.parse(payload) as Partial<OAuthTokens>;
  if (
    typeof parsed.accessToken !== "string" ||
    typeof parsed.refreshToken !== "string" ||
    typeof parsed.expiryDate !== "number"
  ) {
    throw new Error("Stored OAuth token payload is malformed");
  }
  return {
    accessToken: parsed.accessToken,
    refreshToken: parsed.refreshToken,
    expiryDate: parsed.expiryDate,
    scope: parsed.scope ?? "",
    tokenType: parsed.tokenType ?? "Bearer",
  };
}

/** A {@link TokenStore} that persists tokens as a Secrets Manager secret. */
export class SecretsManagerTokenStore implements TokenStore {
  constructor(
    private readonly secrets: SecretsManagerPort,
    private readonly secretId: string,
  ) {}

  async load(): Promise<OAuthTokens | null> {
    const payload = await this.secrets.getSecretString(this.secretId);
    return deserializeTokens(payload);
  }

  async save(tokens: OAuthTokens): Promise<void> {
    await this.secrets.putSecretString(this.secretId, serializeTokens(tokens));
  }
}

/**
 * Minimal DynamoDB surface the token store needs. In production this is a thin
 * adapter over a `DynamoDBDocumentClient` pointed at the settings table; in
 * tests it is an in-memory fake. Items are addressed by their `settingKey`
 * (the settings table's partition key) and carry the serialized token payload
 * under `value`.
 */
export interface TokenTablePort {
  /** Return the stored payload for `settingKey`, or null if absent. */
  getTokenItem(settingKey: string): Promise<string | null>;
  /** Create or overwrite the stored payload for `settingKey`. */
  putTokenItem(settingKey: string, value: string): Promise<void>;
}

/**
 * A {@link TokenStore} that persists tokens in the DynamoDB settings table
 * (encrypted at rest with the table's AWS-managed key), rather than in a
 * Secrets Manager secret. This removes the Secrets Manager flat monthly charge
 * while keeping tokens encrypted. The JSON (de)serialization is the same pure
 * {@link serializeTokens}/{@link deserializeTokens} used by the Secrets
 * Manager store, so the stored payload format is identical.
 */
export class DynamoDBTokenStore implements TokenStore {
  constructor(
    private readonly table: TokenTablePort,
    private readonly settingKey: string,
  ) {}

  async load(): Promise<OAuthTokens | null> {
    const payload = await this.table.getTokenItem(this.settingKey);
    return deserializeTokens(payload);
  }

  async save(tokens: OAuthTokens): Promise<void> {
    await this.table.putTokenItem(this.settingKey, serializeTokens(tokens));
  }
}
