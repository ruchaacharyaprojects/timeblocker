import { CALENDAR_SCOPE } from "@timeblocker/calendar-integration";
import { describe, expect, it } from "vitest";
import { SESSION_ENDED_MESSAGE, SessionEnded } from "../models.js";
import { Repositories } from "../repositories.js";
import {
  FakeBackgroundJobs,
  FakeClock,
  FakeTokenVault,
  MemoryKeyValueStore,
  ScriptableAuthClient,
  makeGrant,
  makeTokens,
} from "../testkit.js";
import {
  AuthService,
  CALENDAR_ACCESS_REQUIRED_MESSAGE,
  GOOGLE_AUTHORIZE_REQUEST,
  OPENID_SCOPE,
  PROFILE_SCOPE,
  SIGN_IN_INCOMPLETE_MESSAGE,
  hasCalendarScope,
} from "./auth.js";

function idTokenFor(claims: object): string {
  const enc = (o: object) =>
    Buffer.from(JSON.stringify(o), "utf8").toString("base64url");
  return `${enc({ alg: "RS256" })}.${enc(claims)}.sig`;
}

describe("profile name (R18.2)", () => {
  it("signIn stores the given name from the id token", async () => {
    const { service, repos, auth } = setup();
    auth.nextAuthorize({
      kind: "ok",
      grant: makeGrant({ idToken: idTokenFor({ given_name: "José" }) }),
    });
    expect((await service.signIn()).ok).toBe(true);
    const profile = await repos.profile.get();
    expect(profile.givenName).toBe("José");
    expect(profile.updatedAt).toBe(NOW);
  });

  it("never persists the id token", async () => {
    const { service, kv, auth } = setup();
    const idToken = idTokenFor({ given_name: "Ana" });
    auth.nextAuthorize({ kind: "ok", grant: makeGrant({ idToken }) });
    await service.signIn();
    expect(JSON.stringify(kv.snapshot())).not.toContain(idToken);
  });

  it("keeps the previous name when the grant has no usable id token", async () => {
    const { service, repos, auth } = setup();
    await repos.profile.save({ givenName: "Ana", updatedAt: 1 });
    auth.nextAuthorize({ kind: "ok", grant: makeGrant() });
    await service.signIn();
    expect(await repos.profile.get()).toEqual({ givenName: "Ana", updatedAt: 1 });
    auth.nextAuthorize({ kind: "ok", grant: makeGrant({ idToken: "garbage" }) });
    await service.signIn();
    expect((await repos.profile.get()).givenName).toBe("Ana");
  });

  it("overwrites the previous name when a fresh id token has one", async () => {
    const { service, repos, auth } = setup();
    await repos.profile.save({ givenName: "Ana", updatedAt: 1 });
    auth.nextAuthorize({
      kind: "ok",
      grant: makeGrant({ idToken: idTokenFor({ name: "Zoë Q" }) }),
    });
    await service.signIn();
    expect((await repos.profile.get()).givenName).toBe("Zoë");
  });

  it("a profile write failure does not fail sign-in", async () => {
    const { service, repos, auth } = setup();
    (repos.profile as { save: unknown }).save = async () => {
      throw new Error("disk full");
    };
    auth.nextAuthorize({
      kind: "ok",
      grant: makeGrant({ idToken: idTokenFor({ given_name: "Ana" }) }),
    });
    expect(await service.signIn()).toEqual({ ok: true, via: "authorize" });
    expect(await service.isSignedIn()).toBe(true);
  });

  it("signOut clears the name, even if the profile write fails", async () => {
    const { service, repos } = setup();
    await repos.profile.save({ givenName: "Ana", updatedAt: 1 });
    await service.signOut();
    expect((await repos.profile.get()).givenName).toBeUndefined();

    (repos.profile as { save: unknown }).save = async () => {
      throw new Error("disk full");
    };
    await expect(service.signOut()).resolves.toBeUndefined();
  });

  it("a corrupt profile document reads as the default", async () => {
    const { repos, kv } = setup();
    kv.data.set("profile", "{nope");
    expect(await repos.profile.get()).toEqual({ updatedAt: 0 });
  });
});

const NOW = Date.parse("2025-07-01T12:00:00Z");

function setup(initialTokens: ReturnType<typeof makeTokens> | null = null) {
  const kv = new MemoryKeyValueStore();
  const repos = new Repositories(kv);
  const vault = new FakeTokenVault(initialTokens);
  const clock = new FakeClock(NOW);
  const auth = new ScriptableAuthClient(clock);
  const jobs = new FakeBackgroundJobs();
  const service = new AuthService({ repos, vault, auth, clock, jobs });
  return { kv, repos, vault, clock, auth, jobs, service };
}

describe("GOOGLE_AUTHORIZE_REQUEST", () => {
  it("requests the Calendar scope with PKCE and offline consent", () => {
    expect(GOOGLE_AUTHORIZE_REQUEST.scopes).toEqual([CALENDAR_SCOPE, "openid", "profile"]);
    expect(OPENID_SCOPE).toBe("openid");
    expect(PROFILE_SCOPE).toBe("profile");
    expect(GOOGLE_AUTHORIZE_REQUEST.usePKCE).toBe(true);
    expect(GOOGLE_AUTHORIZE_REQUEST.additionalParameters).toEqual({
      access_type: "offline",
      prompt: "consent",
    });
  });
});

describe("hasCalendarScope", () => {
  it("finds the scope in a list or a space-separated string", () => {
    expect(hasCalendarScope([CALENDAR_SCOPE])).toBe(true);
    expect(hasCalendarScope([`openid ${CALENDAR_SCOPE}`])).toBe(true);
    expect(hasCalendarScope([])).toBe(false);
    expect(hasCalendarScope([`${CALENDAR_SCOPE}.readonly`])).toBe(false);
  });
});

describe("AuthService.signIn", () => {
  it("saves tokens to the vault only and sets signed-in", async () => {
    const { service, vault, kv, auth } = setup();
    auth.nextAuthorize({
      kind: "ok",
      grant: makeGrant({ accessToken: "SECRET-ACC", refreshToken: "SECRET-REF", expiresAtMs: NOW + 3_600_000 }),
    });

    expect(await service.signIn()).toEqual({ ok: true, via: "authorize" });
    expect(vault.current).toMatchObject({
      accessToken: "SECRET-ACC",
      refreshToken: "SECRET-REF",
      expiryDate: NOW + 3_600_000,
      scope: CALENDAR_SCOPE,
    });
    expect(await service.isSignedIn()).toBe(true);
    // No token material reaches the key/value store.
    const stored = JSON.stringify(kv.snapshot());
    expect(stored).not.toContain("SECRET-ACC");
    expect(stored).not.toContain("SECRET-REF");
  });

  it.each([
    [{ kind: "cancelled" as const }],
    [{ kind: "error" as const, message: "boom" }],
  ])("%j → 'Sign-in didn't complete' and stores nothing", async (outcome) => {
    const { service, vault, kv, auth } = setup();
    auth.nextAuthorize(outcome);

    const result = await service.signIn();

    expect(result).toEqual({
      ok: false,
      reason: "incomplete",
      message: "Sign-in didn't complete. Try again.",
    });
    expect(SIGN_IN_INCOMPLETE_MESSAGE).toBe("Sign-in didn't complete. Try again.");
    expect(vault.saves).toBe(0);
    expect(kv.writes).toBe(0);
    expect((await service.state()).status).toBe("signed-out");
  });

  it("a thrown authorize error is an incomplete sign-in", async () => {
    const { service, vault, kv, auth } = setup();
    auth.nextAuthorize(() => Promise.reject(new Error("custom tab crashed")));

    expect(await service.signIn()).toMatchObject({ ok: false, message: SIGN_IN_INCOMPLETE_MESSAGE });
    expect(vault.saves).toBe(0);
    expect(kv.writes).toBe(0);
  });

  it("denied consent → 'needs Calendar access' and stores nothing", async () => {
    const { service, vault, kv, auth } = setup();
    auth.nextAuthorize({ kind: "denied" });

    expect(await service.signIn()).toEqual({
      ok: false,
      reason: "calendar-access-required",
      message: "TimeBlocker needs Calendar access to work.",
    });
    expect(CALENDAR_ACCESS_REQUIRED_MESSAGE).toBe("TimeBlocker needs Calendar access to work.");
    expect(vault.saves).toBe(0);
    expect(kv.writes).toBe(0);
  });

  it("a grant without the Calendar scope → 'needs Calendar access' and stores nothing", async () => {
    const { service, vault, kv, auth } = setup();
    auth.nextAuthorize({ kind: "ok", grant: makeGrant({ grantedScopes: ["openid", "email"] }) });

    expect(await service.signIn()).toMatchObject({
      ok: false,
      message: CALENDAR_ACCESS_REQUIRED_MESSAGE,
    });
    expect(vault.saves).toBe(0);
    expect(kv.writes).toBe(0);
    expect(await service.isSignedIn()).toBe(false);
  });

  it("a grant without a refresh token is an incomplete sign-in", async () => {
    const { service, vault, auth } = setup();
    auth.nextAuthorize({ kind: "ok", grant: makeGrant({ refreshToken: undefined }) });

    expect(await service.signIn()).toMatchObject({ ok: false, reason: "incomplete" });
    expect(vault.saves).toBe(0);
  });

  it("with tokens kept after a transport failure, refreshes silently first", async () => {
    const { service, vault, auth, repos } = setup(makeTokens({ refreshToken: "kept" }));
    await repos.authState.save({ status: "session-ended", reason: "transport" });

    expect(await service.signIn()).toEqual({ ok: true, via: "silent-refresh" });
    expect(auth.refreshCalls).toEqual(["kept"]);
    expect(auth.authorizeCalls).toBe(0);
    expect(vault.current?.accessToken).toBe("refreshed-1");
    expect(vault.current?.refreshToken).toBe("kept");
    expect(await service.isSignedIn()).toBe(true);
  });

  it("falls back to the browser when the silent refresh fails", async () => {
    const { service, vault, auth } = setup(makeTokens());
    auth.nextRefresh({ kind: "invalid-grant" });

    expect(await service.signIn()).toEqual({ ok: true, via: "authorize" });
    expect(auth.refreshCalls).toHaveLength(1);
    expect(auth.authorizeCalls).toBe(1);
    expect(vault.current?.accessToken).toBe("access-1");
  });

  it("never refreshes when the vault is empty", async () => {
    const { service, auth } = setup();
    await service.signIn();
    expect(auth.refreshCalls).toEqual([]);
    expect(auth.authorizeCalls).toBe(1);
  });
});

describe("AuthService.reconnect", () => {
  async function signedIn() {
    const s = setup();
    s.auth.nextAuthorize({
      kind: "ok",
      grant: makeGrant({ refreshToken: "old-ref", accessToken: "old-acc" }),
    });
    await s.service.signIn();
    await s.repos.profile.save({ updatedAt: 1 });
    return s;
  }

  it("re-authorizes (no silent refresh), replaces tokens, and saves the name", async () => {
    const s = await signedIn();
    const refreshesBefore = s.auth.refreshCalls.length;
    s.auth.nextAuthorize({
      kind: "ok",
      grant: makeGrant({
        refreshToken: "new-ref",
        accessToken: "new-acc",
        idToken: idTokenFor({ given_name: "Rucha" }),
      }),
    });
    expect(await s.service.reconnect()).toEqual({ ok: true, via: "authorize" });
    expect(s.auth.refreshCalls.length).toBe(refreshesBefore);
    expect(s.vault.current).toMatchObject({ refreshToken: "new-ref", accessToken: "new-acc" });
    expect((await s.repos.profile.get()).givenName).toBe("Rucha");
    expect(await s.service.isSignedIn()).toBe(true);
  });

  it.each([
    [{ kind: "cancelled" as const }],
    [{ kind: "error" as const, message: "boom" }],
    [{ kind: "denied" as const }],
  ])("%j leaves the session and all local data untouched", async (outcome) => {
    const s = await signedIn();
    await s.repos.profile.save({ givenName: "Ana", updatedAt: 2 });
    const before = JSON.stringify(s.kv.snapshot());
    const tokens = s.vault.current;
    const saves = s.vault.saves;
    s.auth.nextAuthorize(outcome);
    expect((await s.service.reconnect()).ok).toBe(false);
    expect(JSON.stringify(s.kv.snapshot())).toBe(before);
    expect(s.vault.current).toEqual(tokens);
    expect(s.vault.saves).toBe(saves);
    expect(await s.service.isSignedIn()).toBe(true);
  });

  it("a thrown authorize error or a grant without Calendar scope changes nothing", async () => {
    const s = await signedIn();
    const before = JSON.stringify(s.kv.snapshot());
    s.auth.nextAuthorize(() => Promise.reject(new Error("crash")));
    expect(await s.service.reconnect()).toMatchObject({ ok: false, reason: "incomplete" });
    s.auth.nextAuthorize({ kind: "ok", grant: makeGrant({ grantedScopes: ["openid"] }) });
    expect(await s.service.reconnect()).toMatchObject({ ok: false, reason: "calendar-access-required" });
    expect(JSON.stringify(s.kv.snapshot())).toBe(before);
    expect(await s.service.isSignedIn()).toBe(true);
  });
});

describe("AuthService.signOut", () => {
  it("revokes, clears the vault, stops background sync, and sets signed-out", async () => {
    const { service, vault, auth, jobs } = setup();
    await service.signIn();
    await jobs.startPeriodicSync(30);

    await service.signOut();

    expect(auth.revoked).toEqual(["refresh-1"]);
    expect(vault.current).toBeNull();
    expect(jobs.running).toBe(false);
    expect((await service.state()).status).toBe("signed-out");
  });

  it("still clears the vault when revocation fails", async () => {
    const { service, vault, auth } = setup(makeTokens());
    auth.revoke = () => Promise.reject(new Error("offline"));

    await service.signOut();

    expect(vault.current).toBeNull();
  });
});

describe("AuthService.restoreAfterTransportEnd", () => {
  it("restores signed-in when a transport-ended state still has tokens", async () => {
    const { service, repos } = setup(makeTokens());
    await repos.authState.save({ status: "session-ended", reason: "transport" });
    expect(await service.restoreAfterTransportEnd()).toBe(true);
    expect(await repos.authState.get()).toEqual({ status: "signed-in" });
  });
  it("leaves the state alone when the vault is empty", async () => {
    const { service, repos } = setup();
    await repos.authState.save({ status: "session-ended", reason: "transport" });
    expect(await service.restoreAfterTransportEnd()).toBe(false);
    expect(await repos.authState.get()).toEqual({ status: "session-ended", reason: "transport" });
  });
  it("does not touch other states or reasons", async () => {
    const { service, repos } = setup(makeTokens());
    await repos.authState.save({ status: "session-ended", reason: "revoked" });
    expect(await service.restoreAfterTransportEnd()).toBe(false);
    expect(await repos.authState.get()).toEqual({ status: "session-ended", reason: "revoked" });
    await repos.authState.save({ status: "signed-out" });
    expect(await service.restoreAfterTransportEnd()).toBe(false);
  });
});
describe("AuthService.onSessionEnded", () => {
  it("stops background sync, sets session-ended, and leaves other documents untouched", async () => {
    const { service, kv, repos, jobs, vault } = setup(makeTokens());
    await repos.authState.save({ status: "signed-in" });
    await repos.settings.save({ planningMode: "spread", holidays: ["2025-07-01"], distractionApps: [] });
    await repos.syncState.save({ lastSuccessAt: 5 });
    await jobs.startPeriodicSync(30);
    const before = kv.snapshot();

    const outcome = await service.onSessionEnded(new SessionEnded("transport"));

    expect(outcome).toEqual({ reason: "transport", message: SESSION_ENDED_MESSAGE });
    expect(jobs.running).toBe(false);
    expect(await service.state()).toEqual({ status: "session-ended", reason: "transport" });
    expect(await service.isSignedIn()).toBe(false);
    const after = kv.snapshot();
    for (const key of Object.keys(before)) {
      if (key === "authState") continue;
      expect(after[key]).toBe(before[key]);
    }
    expect(Object.keys(after).sort()).toEqual(Object.keys(before).sort());
    // The vault is the provider's concern; a transport end keeps it.
    expect(vault.current).not.toBeNull();
  });

  it("accepts a bare reason", async () => {
    const { service } = setup();
    expect((await service.onSessionEnded("revoked")).reason).toBe("revoked");
    expect((await service.state()).reason).toBe("revoked");
  });
});

describe("AuthService.tokenProvider", () => {
  it("serves the signed-in access token", async () => {
    const { service, auth } = setup();
    auth.nextAuthorize({
      kind: "ok",
      grant: makeGrant({ accessToken: "live", expiresAtMs: NOW + 3_600_000 }),
    });
    await service.signIn();
    expect(await service.tokenProvider.getValidAccessToken()).toBe("live");
  });
});
