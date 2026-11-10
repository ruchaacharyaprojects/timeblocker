import { CALENDAR_SCOPE } from "@timeblocker/calendar-integration";
import { describe, expect, it } from "vitest";
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
import { AuthService } from "./auth.js";
import { GoogleIdTokenProvider, ID_TOKEN_REFRESH_WINDOW_MS } from "./googleIdToken.js";
import { expFromIdToken, subFromIdToken } from "./idToken.js";

const NOW = Date.parse("2025-07-01T12:00:00Z");

function jwt(claims: object): string {
  const enc = (o: object) => Buffer.from(JSON.stringify(o), "utf8").toString("base64url");
  return `${enc({ alg: "RS256" })}.${enc(claims)}.sig`;
}

/** An id token that expires `inMs` after NOW. */
const idTokenExpiringIn = (inMs: number, sub = "sub-123") =>
  jwt({ sub, exp: Math.floor((NOW + inMs) / 1000) });

describe("subFromIdToken / expFromIdToken", () => {
  it("reads sub and exp (seconds)", () => {
    const t = jwt({ sub: "1234567890", exp: 1_900_000_000 });
    expect(subFromIdToken(t)).toBe("1234567890");
    expect(expFromIdToken(t)).toBe(1_900_000_000);
  });

  it("returns undefined for malformed input and wrong types", () => {
    for (const bad of [undefined, null, "", "garbage", "a.b.c", "a..c", jwt({ sub: 5, exp: "x" })]) {
      expect(subFromIdToken(bad)).toBeUndefined();
      expect(expFromIdToken(bad)).toBeUndefined();
    }
    expect(subFromIdToken(jwt({ sub: "" }))).toBeUndefined();
    expect(expFromIdToken(jwt({ exp: -1 }))).toBeUndefined();
  });
});

describe("GoogleIdTokenProvider", () => {
  function provider(refresh: () => Promise<unknown>) {
    const clock = new FakeClock(NOW);
    const p = new GoogleIdTokenProvider({ clock, refresh });
    return { clock, p };
  }

  it("returns a remembered token with more than 60 s left without refreshing", async () => {
    let refreshes = 0;
    const { p } = provider(async () => void refreshes++);
    const t = idTokenExpiringIn(ID_TOKEN_REFRESH_WINDOW_MS + 5_000);
    p.remember(t);
    expect(await p.getIdToken()).toBe(t);
    expect(refreshes).toBe(0);
  });

  it("refreshes when none is remembered and returns what the refresh remembered", async () => {
    let p!: GoogleIdTokenProvider;
    const fresh = idTokenExpiringIn(3_600_000);
    let refreshes = 0;
    ({ p } = provider(async () => {
      refreshes++;
      p.remember(fresh);
    }));
    expect(await p.getIdToken()).toBe(fresh);
    expect(await p.getIdToken()).toBe(fresh);
    expect(refreshes).toBe(1);
  });

  it("refreshes when within 60 s of expiry (inclusive) but not at 61 s", async () => {
    const fresh = idTokenExpiringIn(3_600_000, "new");
    let refreshes = 0;
    const { p } = (() => {
      const r = provider(async () => {
        refreshes++;
        r.p.remember(fresh);
      });
      return r;
    })();
    p.remember(idTokenExpiringIn(61_000));
    await p.getIdToken();
    expect(refreshes).toBe(0);
    p.remember(idTokenExpiringIn(60_000));
    expect(await p.getIdToken()).toBe(fresh);
    expect(refreshes).toBe(1);
  });

  it("refreshes when the clock moves past the 60 s window", async () => {
    const fresh = idTokenExpiringIn(7_200_000);
    let refreshes = 0;
    const r = provider(async () => {
      refreshes++;
      r.p.remember(fresh);
    });
    r.p.remember(idTokenExpiringIn(600_000));
    await r.p.getIdToken();
    expect(refreshes).toBe(0);
    r.clock.advance(560_000);
    expect(await r.p.getIdToken()).toBe(fresh);
    expect(refreshes).toBe(1);
  });

  it("ignores tokens without a readable exp", async () => {
    const { p } = provider(async () => undefined);
    p.remember("garbage");
    p.remember(jwt({ sub: "x" }));
    p.remember(undefined);
    expect(await p.getIdToken()).toBeUndefined();
  });

  it("returns undefined (never throws) when the refresh fails", async () => {
    const { p } = provider(async () => {
      throw new Error("offline");
    });
    expect(await p.getIdToken()).toBeUndefined();
  });

  it("returns undefined when the refresh remembers nothing", async () => {
    const { p } = provider(async () => undefined);
    expect(await p.getIdToken()).toBeUndefined();
  });

  it("shares one in-flight refresh between concurrent callers", async () => {
    let refreshes = 0;
    const fresh = idTokenExpiringIn(3_600_000);
    const r = provider(async () => {
      refreshes++;
      await Promise.resolve();
      r.p.remember(fresh);
    });
    const out = await Promise.all([r.p.getIdToken(), r.p.getIdToken(), r.p.getIdToken()]);
    expect(out).toEqual([fresh, fresh, fresh]);
    expect(refreshes).toBe(1);
  });

  it("forget() drops the token", async () => {
    const { p } = provider(async () => undefined);
    p.remember(idTokenExpiringIn(3_600_000));
    p.forget();
    expect(await p.getIdToken()).toBeUndefined();
  });
});

describe("AuthService id token plumbing (R35.2)", () => {
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
  const signedInTokens = () =>
    makeTokens({ scope: CALENDAR_SCOPE, expiryDate: NOW + 3_600_000 });

  it("remembers the id token from authorize and serves it without a refresh", async () => {
    const { service, auth } = setup();
    const t = idTokenExpiringIn(3_600_000, "sub-abc");
    auth.nextAuthorize({ kind: "ok", grant: makeGrant({ idToken: t }) });
    await service.signIn();
    expect(await service.getIdToken()).toBe(t);
    expect(await service.googleSub()).toBe("sub-abc");
    expect(auth.refreshCalls).toEqual([]);
  });

  it("refreshes through forceRefresh when the id token is missing, using the new id token", async () => {
    const { service, auth, vault } = setup(signedInTokens());
    const t = idTokenExpiringIn(3_600_000, "from-refresh");
    auth.nextRefresh({
      kind: "ok",
      grant: { ...makeGrant({ idToken: t }), refreshToken: undefined } as never,
    });
    expect(await service.googleSub()).toBe("from-refresh");
    expect(auth.refreshCalls).toEqual(["refresh-0"]);
    expect(vault.saves).toBe(1);
  });

  it("remembers the id token of a Calendar-driven refresh (any refresh)", async () => {
    const { service, auth } = setup(signedInTokens());
    const t = idTokenExpiringIn(3_600_000, "cal");
    auth.nextRefresh({ kind: "ok", grant: makeGrant({ idToken: t }) });
    await service.tokenProvider.forceRefresh();
    auth.nextRefresh({ kind: "ok", grant: makeGrant() }); // must not be needed
    expect(await service.getIdToken()).toBe(t);
    expect(auth.refreshCalls).toHaveLength(1);
  });

  it("a refresh within 60 s of expiry is requested again", async () => {
    const { service, auth, clock } = setup(signedInTokens());
    auth.nextAuthorize({
      kind: "ok",
      grant: makeGrant({ idToken: idTokenExpiringIn(120_000, "old") }),
    });
    await service.signIn();
    // signIn runs a silent refresh first when the vault has tokens; this vault was empty.
    clock.advance(70_000);
    auth.nextRefresh({
      kind: "ok",
      grant: makeGrant({ idToken: idTokenExpiringIn(3_600_000 + 70_000, "newer") }),
    });
    expect(await service.googleSub()).toBe("newer");
  });

  it("transport failure -> undefined, session intact, vault kept, no session end", async () => {
    const { service, auth, vault, repos } = setup(signedInTokens());
    await repos.authState.save({ status: "signed-in" });
    auth.nextRefresh({ kind: "transport-error" } as never);
    expect(await service.getIdToken()).toBeUndefined();
    expect(await service.googleSub()).toBeUndefined();
    expect(vault.current).not.toBeNull();
    expect(vault.clears).toBe(0);
    expect(await repos.authState.get()).toEqual({ status: "signed-in" });
  });

  it("session end on refresh -> undefined and auth state is not changed by the AI path", async () => {
    const { service, auth, repos } = setup(signedInTokens());
    await repos.authState.save({ status: "signed-in" });
    auth.nextRefresh({ kind: "invalid-grant" });
    expect(await service.getIdToken()).toBeUndefined();
    expect(await repos.authState.get()).toEqual({ status: "signed-in" });
  });

  it("no tokens in the vault -> undefined", async () => {
    const { service } = setup(null);
    expect(await service.getIdToken()).toBeUndefined();
  });

  it("never writes the id token to the key-value store or the vault", async () => {
    const { service, auth, kv, vault } = setup(signedInTokens());
    const t = idTokenExpiringIn(3_600_000, "secret-sub");
    auth.nextRefresh({ kind: "ok", grant: makeGrant({ idToken: t }) });
    await service.getIdToken();
    await service.googleSub();
    const marker = t.split(".")[1]!;
    expect(JSON.stringify(kv.snapshot())).not.toContain(t);
    expect(JSON.stringify(kv.snapshot())).not.toContain(marker);
    expect(JSON.stringify(vault.current)).not.toContain(t);
    expect(JSON.stringify(vault.current)).not.toContain(marker);
    expect(kv.writes).toBe(0);
  });

  it("signOut forgets the id token", async () => {
    const { service, auth } = setup();
    auth.nextAuthorize({ kind: "ok", grant: makeGrant({ idToken: idTokenExpiringIn(3_600_000) }) });
    await service.signIn();
    await service.signOut();
    expect(await service.getIdToken()).toBeUndefined();
  });
});
