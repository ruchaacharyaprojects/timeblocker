import { describe, it, expect } from "vitest";
import {
  DynamoDBTokenStore,
  SecretsManagerTokenStore,
  deserializeTokens,
  serializeTokens,
  type TokenTablePort,
} from "./secrets.js";
import { CALENDAR_SCOPE, type OAuthTokens } from "./types.js";
import { InMemorySecretsManager, InMemoryTokenTable } from "./testkit.js";

const TOKENS: OAuthTokens = {
  accessToken: "a",
  refreshToken: "r",
  expiryDate: 123456,
  scope: CALENDAR_SCOPE,
  tokenType: "Bearer",
};

describe("token (de)serialization", () => {
  it("round-trips tokens through the stored payload", () => {
    expect(deserializeTokens(serializeTokens(TOKENS))).toEqual(TOKENS);
  });

  it("returns null for empty input", () => {
    expect(deserializeTokens(null)).toBeNull();
    expect(deserializeTokens("")).toBeNull();
  });

  it("throws on a malformed payload", () => {
    expect(() => deserializeTokens(JSON.stringify({ accessToken: "a" }))).toThrow();
  });

  it("round-trips for many random expiry values", () => {
    for (let i = 0; i < 200; i++) {
      const expiry = Math.floor(Math.random() * 1e12);
      const t = { ...TOKENS, expiryDate: expiry };
      expect(deserializeTokens(serializeTokens(t))?.expiryDate).toBe(expiry);
    }
  });
});

describe("SecretsManagerTokenStore persists via the port", () => {
  it("saves then loads tokens from Secrets Manager", async () => {
    const secrets = new InMemorySecretsManager();
    const store = new SecretsManagerTokenStore(secrets, "timeblocker/google-oauth");
    expect(await store.load()).toBeNull();
    await store.save(TOKENS);
    expect(await store.load()).toEqual(TOKENS);
  });
});

describe("DynamoDBTokenStore persists via the settings-table port", () => {
  it("saves then loads tokens from the settings table", async () => {
    const table = new InMemoryTokenTable();
    const store = new DynamoDBTokenStore(table, "google-oauth-tokens");
    expect(await store.load()).toBeNull();
    await store.save(TOKENS);
    expect(await store.load()).toEqual(TOKENS);
  });

  it("throws on a malformed stored payload", async () => {
    // A fake table port that returns an incomplete token payload.
    const table: TokenTablePort = {
      async getTokenItem() {
        return JSON.stringify({ accessToken: "a" });
      },
      async putTokenItem() {},
    };
    const store = new DynamoDBTokenStore(table, "google-oauth-tokens");
    await expect(store.load()).rejects.toThrow();
  });
});
