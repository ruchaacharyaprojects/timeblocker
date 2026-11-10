import { describe, expect, it } from "vitest";
import { CALENDAR_SCOPE } from "@timeblocker/calendar-integration";
import { weekBounds } from "@timeblocker/scheduling-engine";
import { SessionEnded } from "./models.js";
import type { RefreshResult } from "./ports.js";
import {
  FakeClock,
  FakeHttpTransport,
  FakeNetworkError,
  FakeTokenVault,
  ScriptableAuthClient,
  makeGrant,
  makeTokens,
} from "./testkit.js";
import {
  AuthTransportError,
  DeviceAccessTokenProvider,
  createAuthorizedCalendarApi,
  rotateTokens,
} from "./tokenProvider.js";

const NOW = 1_000_000;
const WEEK = weekBounds("2025-01-15T12:00:00.000Z");

function setup(tokens = makeTokens({ expiryDate: NOW + 3_600_000 })) {
  const clock = new FakeClock(NOW);
  const vault = new FakeTokenVault(tokens);
  const auth = new ScriptableAuthClient(clock);
  const provider = new DeviceAccessTokenProvider(vault, auth, clock);
  return { clock, vault, auth, provider };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

async function sessionEndReason(p: Promise<unknown>): Promise<string> {
  const error = await p.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(SessionEnded);
  return (error as SessionEnded).reason;
}

describe("DeviceAccessTokenProvider", () => {
  it("throws SessionEnded('missing') when the vault is empty", async () => {
    const { auth, provider } = setup(null as never);
    expect(await sessionEndReason(provider.getValidAccessToken())).toBe("missing");
    expect(auth.refreshCalls).toEqual([]);
  });

  it("returns the stored token without refreshing when it is not expiring", async () => {
    const { auth, provider } = setup(
      makeTokens({ accessToken: "stored", expiryDate: NOW + 60_001 }),
    );
    expect(await provider.getValidAccessToken()).toBe("stored");
    expect(auth.refreshCalls).toEqual([]);
  });

  it("refreshes once when the token expires within 60 s and saves rotated tokens", async () => {
    const { vault, auth, provider } = setup(
      makeTokens({ refreshToken: "r-old", expiryDate: NOW + 60_000 }),
    );
    expect(await provider.getValidAccessToken()).toBe("refreshed-1");
    expect(auth.refreshCalls).toEqual(["r-old"]);
    expect(vault.saves).toBe(1);
    // Google omitted the refresh token, so the old one carries forward.
    expect(vault.current).toMatchObject({
      accessToken: "refreshed-1",
      refreshToken: "r-old",
      expiryDate: NOW + 3_600_000,
    });
  });

  it("stores a rotated refresh token when Google returns one", async () => {
    const { vault, auth, provider } = setup(makeTokens({ expiryDate: NOW }));
    auth.nextRefresh({
      kind: "ok",
      grant: makeGrant({ accessToken: "a2", refreshToken: "r2", expiresAtMs: NOW + 10 }),
    });
    expect(await provider.getValidAccessToken()).toBe("a2");
    expect(vault.current?.refreshToken).toBe("r2");
  });

  it("makes at most one refresh per request even if the new token is short-lived", async () => {
    const { auth, provider } = setup(makeTokens({ expiryDate: NOW }));
    auth.nextRefresh({
      kind: "ok",
      grant: makeGrant({ accessToken: "short", expiresAtMs: NOW + 1_000 }),
    });
    expect(await provider.getValidAccessToken()).toBe("short");
    expect(auth.refreshCalls).toHaveLength(1);
  });

  it("shares one in-flight refresh across concurrent callers", async () => {
    const { auth, vault, provider } = setup(makeTokens({ expiryDate: NOW }));
    const gate = deferred<RefreshResult>();
    auth.nextRefresh(() => gate.promise);
    const calls = [
      provider.getValidAccessToken(),
      provider.getValidAccessToken(),
      provider.getValidAccessToken(),
    ];
    gate.resolve({ kind: "ok", grant: makeGrant({ accessToken: "shared", expiresAtMs: NOW + 3_600_000 }) });
    expect(await Promise.all(calls)).toEqual(["shared", "shared", "shared"]);
    expect(auth.refreshCalls).toHaveLength(1);
    expect(vault.saves).toBe(1);
  });

  it("clears the vault and throws SessionEnded('invalid-grant') when Google rejects the refresh token", async () => {
    const { vault, auth, provider } = setup(makeTokens({ expiryDate: NOW }));
    auth.nextRefresh({ kind: "invalid-grant" });
    expect(await sessionEndReason(provider.getValidAccessToken())).toBe("invalid-grant");
    expect(vault.clears).toBe(1);
    expect(vault.current).toBeNull();
  });

  it("keeps the vault and throws AuthTransportError on a transport failure", async () => {
    const tokens = makeTokens({ expiryDate: NOW });
    const { vault, auth, provider } = setup(tokens);
    auth.nextRefresh({ kind: "transport-error", message: "offline" });
    const error = await provider.getValidAccessToken().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AuthTransportError);
    expect(error).not.toBeInstanceOf(SessionEnded);
    expect(vault.clears).toBe(0);
    expect(vault.saves).toBe(0);
    expect(vault.current).toEqual(tokens);
  });

  it("treats a thrown refresh as a transport failure and keeps the vault", async () => {
    const tokens = makeTokens({ expiryDate: NOW });
    const { vault, auth, provider } = setup(tokens);
    auth.nextRefresh(() => Promise.reject(new FakeNetworkError()));
    const error = await provider.getValidAccessToken().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AuthTransportError);
    expect(error).not.toBeInstanceOf(SessionEnded);
    expect(vault.current).toEqual(tokens);
  });
  it("concurrent callers share one failing refresh and all get AuthTransportError", async () => {
    const { vault, auth, provider } = setup(makeTokens({ expiryDate: NOW }));
    auth.nextRefresh({ kind: "transport-error", message: "offline" });
    const results = await Promise.allSettled([
      provider.getValidAccessToken(),
      provider.forceRefresh(),
      provider.getValidAccessToken(),
    ]);
    for (const r of results) {
      expect(r.status).toBe("rejected");
      expect((r as PromiseRejectedResult).reason).toBeInstanceOf(AuthTransportError);
    }
    expect(auth.refreshCalls).toHaveLength(1);
    expect(vault.current).not.toBeNull();
  });

  it("forceRefresh refreshes a still-valid token", async () => {
    const { auth, provider } = setup();
    expect(await provider.forceRefresh()).toBe("refreshed-1");
    expect(auth.refreshCalls).toHaveLength(1);
  });
});

describe("rotateTokens", () => {
  it("keeps the previous scope when the grant reports none", () => {
    const rotated = rotateTokens(makeTokens(), makeGrant({ grantedScopes: [] }));
    expect(rotated.scope).toBe(CALENDAR_SCOPE);
  });
});

describe("Calendar 401 handling", () => {
  function calendar(statuses: number[]) {
    const transport = new FakeHttpTransport(() => ({
      status: statuses.shift() ?? 200,
      body: JSON.stringify({ items: [] }),
    }));
    return transport;
  }

  it("forces one refresh and retries with the new token after a 401", async () => {
    const { auth, provider } = setup(makeTokens({ accessToken: "stale" }));
    const transport = calendar([401, 200]);
    const api = createAuthorizedCalendarApi(provider, transport);
    expect(await api.readWeek(WEEK)).toEqual([]);
    expect(auth.refreshCalls).toHaveLength(1);
    expect(transport.requests.map((r) => r.headers.Authorization)).toEqual([
      "Bearer stale",
      "Bearer refreshed-1",
    ]);
  });

  it("throws SessionEnded('revoked') on a second 401", async () => {
    const { auth, provider } = setup();
    const transport = calendar([401, 401]);
    const api = createAuthorizedCalendarApi(provider, transport);
    expect(await sessionEndReason(api.deleteBlock("abcde12345"))).toBe("revoked");
    expect(auth.refreshCalls).toHaveLength(1);
    expect(transport.requests).toHaveLength(2);
  });

  it("surfaces the refresh failure when the forced refresh is rejected", async () => {
    const { vault, auth, provider } = setup();
    auth.nextRefresh({ kind: "invalid-grant" });
    const transport = calendar([401]);
    const api = createAuthorizedCalendarApi(provider, transport);
    expect(await sessionEndReason(api.getEvent("abcde12345"))).toBe("invalid-grant");
    expect(vault.current).toBeNull();
    expect(transport.requests).toHaveLength(1);
  });

  it("propagates a transport failure of the forced refresh as AuthTransportError", async () => {
    const { vault, auth, provider } = setup();
    auth.nextRefresh({ kind: "transport-error", message: "offline" });
    const api = createAuthorizedCalendarApi(provider, calendar([401]));
    const error = await api.getEvent("abcde12345").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AuthTransportError);
    expect(error).not.toBeInstanceOf(SessionEnded);
    expect(vault.current).not.toBeNull();
  });
  it("passes other errors through without refreshing", async () => {
    const { auth, provider } = setup();
    const api = createAuthorizedCalendarApi(provider, calendar([500]));
    await expect(api.readWeek(WEEK)).rejects.toMatchObject({ status: 500 });
    expect(auth.refreshCalls).toEqual([]);
  });
});
