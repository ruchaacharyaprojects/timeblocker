import { describe, it, expect } from "vitest";
import {
  EXPIRY_SKEW_MS,
  GoogleOAuthClient,
  buildAuthUrl,
  isExpired,
  parseTokenResponse,
} from "./oauth.js";
import { CALENDAR_SCOPE, type OAuthClientConfig, type OAuthTokens } from "./types.js";
import { FakeHttpClient, InMemoryTokenStore } from "./testkit.js";

const CONFIG: OAuthClientConfig = {
  clientId: "client-123",
  clientSecret: "secret-xyz",
  redirectUri: "https://app.example.com/oauth/callback",
};

function tokens(overrides: Partial<OAuthTokens> = {}): OAuthTokens {
  return {
    accessToken: "access-1",
    refreshToken: "refresh-1",
    expiryDate: 10_000,
    scope: CALENDAR_SCOPE,
    tokenType: "Bearer",
    ...overrides,
  };
}

describe("buildAuthUrl requests the Calendar scope offline (R4.1)", () => {
  it("includes scope, offline access, and consent prompt", () => {
    const url = new URL(buildAuthUrl(CONFIG, { state: "s1" }));
    const p = url.searchParams;
    expect(p.get("scope")).toBe(CALENDAR_SCOPE);
    expect(p.get("access_type")).toBe("offline");
    expect(p.get("prompt")).toBe("consent");
    expect(p.get("client_id")).toBe(CONFIG.clientId);
    expect(p.get("redirect_uri")).toBe(CONFIG.redirectUri);
    expect(p.get("response_type")).toBe("code");
    expect(p.get("state")).toBe("s1");
  });
});

describe("parseTokenResponse", () => {
  it("computes an absolute expiry from expires_in", () => {
    const t = parseTokenResponse(
      { access_token: "a", refresh_token: "r", expires_in: 3600 },
      1_000,
    );
    expect(t.accessToken).toBe("a");
    expect(t.refreshToken).toBe("r");
    expect(t.expiryDate).toBe(1_000 + 3600 * 1000);
  });

  it("carries forward the previous refresh token when Google omits one", () => {
    const t = parseTokenResponse(
      { access_token: "a2", expires_in: 3600 },
      0,
      "old-refresh",
    );
    expect(t.refreshToken).toBe("old-refresh");
  });

  it("throws when no access token is present", () => {
    expect(() => parseTokenResponse({ refresh_token: "r" }, 0)).toThrow();
  });

  it("throws when there is neither a new nor a previous refresh token", () => {
    expect(() => parseTokenResponse({ access_token: "a" }, 0)).toThrow();
  });
});

describe("isExpired honors the refresh skew", () => {
  it("is true at/after expiry minus skew", () => {
    const t = tokens({ expiryDate: 100_000 });
    expect(isExpired(t, 100_000 - EXPIRY_SKEW_MS)).toBe(true);
    expect(isExpired(t, 100_000 - EXPIRY_SKEW_MS - 1)).toBe(false);
  });
});

describe("GoogleOAuthClient exchange + refresh persist to the store", () => {
  it("exchanges an auth code and saves tokens", async () => {
    const store = new InMemoryTokenStore();
    const http = new FakeHttpClient(() => ({
      status: 200,
      body: { access_token: "a", refresh_token: "r", expires_in: 3600, token_type: "Bearer" },
    }));
    const client = new GoogleOAuthClient(CONFIG, http, store, () => 1_000);
    const t = await client.exchangeCode("code-abc");
    expect(t.accessToken).toBe("a");
    expect(store.current?.refreshToken).toBe("r");
    expect(http.calls[0].form.grant_type).toBe("authorization_code");
    expect(http.calls[0].form.code).toBe("code-abc");
  });

  it("refreshes an expired token and re-persists it", async () => {
    const store = new InMemoryTokenStore(tokens({ expiryDate: 0 }));
    const http = new FakeHttpClient(() => ({
      status: 200,
      body: { access_token: "fresh", expires_in: 3600 },
    }));
    const now = 500_000;
    const client = new GoogleOAuthClient(CONFIG, http, store, () => now);
    const access = await client.getValidAccessToken();
    expect(access).toBe("fresh");
    expect(store.current?.accessToken).toBe("fresh");
    // Refresh token carried forward.
    expect(store.current?.refreshToken).toBe("refresh-1");
    expect(http.calls[0].form.grant_type).toBe("refresh_token");
  });

  it("returns the stored token when still valid without calling the network", async () => {
    const store = new InMemoryTokenStore(tokens({ expiryDate: 10_000_000 }));
    const http = new FakeHttpClient(() => {
      throw new Error("should not be called");
    });
    const client = new GoogleOAuthClient(CONFIG, http, store, () => 0);
    expect(await client.getValidAccessToken()).toBe("access-1");
    expect(http.calls).toHaveLength(0);
  });

  it("throws when no tokens are stored (consent required)", async () => {
    const store = new InMemoryTokenStore(null);
    const http = new FakeHttpClient(() => ({ status: 200, body: {} }));
    const client = new GoogleOAuthClient(CONFIG, http, store, () => 0);
    await expect(client.getValidAccessToken()).rejects.toThrow(/consent/);
  });

  it("throws on a non-2xx token exchange", async () => {
    const store = new InMemoryTokenStore();
    const http = new FakeHttpClient(() => ({ status: 400, body: { error: "bad" } }));
    const client = new GoogleOAuthClient(CONFIG, http, store, () => 0);
    await expect(client.exchangeCode("x")).rejects.toThrow(/400/);
  });
});
