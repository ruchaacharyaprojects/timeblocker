import { describe, expect, it } from "vitest";
import { MAX_AI_BACKGROUND_CHARS } from "../models.js";
import { KEYS, Repositories, encodeDocument } from "../repositories.js";
import { FakeClock, MemoryKeyValueStore } from "../testkit.js";
import { AiProfileService } from "./aiProfile.js";
import { SettingsService } from "./settings.js";

function setup() {
  const kv = new MemoryKeyValueStore();
  const repos = new Repositories(kv);
  const clock = new FakeClock(5_000);
  return { kv, repos, clock, settings: new SettingsService(repos), profile: new AiProfileService(repos, clock) };
}

describe("aiEnabled setting (R35.1)", () => {
  it("is off by default", async () => {
    const { settings } = setup();
    expect((await settings.get()).aiEnabled).toBeUndefined();
    expect((await settings.get()).aiEnabled === true).toBe(false);
  });

  it("can be switched on and off and persists", async () => {
    const { settings, repos } = setup();
    const on = await settings.setAiEnabled(true);
    expect(on).toMatchObject({ ok: true, changed: true });
    expect((await repos.settings.get()).aiEnabled).toBe(true);
    expect(await settings.setAiEnabled(true)).toMatchObject({ ok: true, changed: false });
    expect(await settings.setAiEnabled(false)).toMatchObject({ ok: true, changed: true });
    expect((await new SettingsService(repos).get()).aiEnabled).toBe(false);
  });

  it("turning off when never set writes nothing", async () => {
    const { settings, kv } = setup();
    const before = kv.writes;
    expect(await settings.setAiEnabled(false)).toMatchObject({ ok: true, changed: false });
    expect(kv.writes).toBe(before);
  });

  it("rejects a non-boolean without writing", async () => {
    const { settings, kv } = setup();
    const result = await settings.setAiEnabled("yes" as never);
    expect(result).toMatchObject({ ok: false, error: "invalid-ai-enabled" });
    expect(kv.writes).toBe(0);
  });

  it("keeps the other settings", async () => {
    const { settings } = setup();
    await settings.setThemeMode("dark");
    await settings.setAiEnabled(true);
    expect(await settings.get()).toMatchObject({ themeMode: "dark", aiEnabled: true });
  });

  it("the validator accepts stored aiEnabled and rejects a non-boolean document", async () => {
    const doc = (aiEnabled: unknown) =>
      new Repositories(
        new MemoryKeyValueStore({
          [KEYS.settings]: encodeDocument({ planningMode: "spread", holidays: [], distractionApps: [], aiEnabled }),
        }),
      );
    expect((await doc(true).settings.get()).aiEnabled).toBe(true);
    expect((await doc(false).settings.get()).aiEnabled).toBe(false);
    // A corrupt value reads as the defaults (AI off).
    expect((await doc("yes").settings.get()).aiEnabled).toBeUndefined();
  });
});

describe("AiProfileService (R34.2)", () => {
  it("has no profile by default", async () => {
    expect(await setup().profile.get()).toBeNull();
  });

  it("saves trimmed text with a timestamp, phone-only document", async () => {
    const { profile, repos, kv } = setup();
    const saved = await profile.save("  Led a team of four.  ");
    expect(saved).toEqual({ background: "Led a team of four.", updatedAt: 5_000 });
    expect(await repos.aiProfile.get()).toEqual(saved);
    expect(kv.data.has(KEYS.aiProfile)).toBe(true);
  });

  it("caps the background at 3000 characters", async () => {
    const { profile, repos } = setup();
    const saved = await profile.save("x".repeat(MAX_AI_BACKGROUND_CHARS + 500));
    expect(saved?.background).toHaveLength(3000);
    expect((await repos.aiProfile.get())?.background).toHaveLength(3000);
  });

  it("caps an oversized stored document when read", async () => {
    const { repos } = setup();
    await repos.aiProfile.save({ background: "y".repeat(4000), updatedAt: 1 });
    expect((await repos.aiProfile.get())?.background).toHaveLength(3000);
  });

  it("saving blank text clears the profile; clear() deletes it", async () => {
    const { profile } = setup();
    await profile.save("hello");
    expect(await profile.save("   ")).toBeNull();
    expect(await profile.get()).toBeNull();
    await profile.save("again");
    await profile.clear();
    expect(await profile.get()).toBeNull();
  });
});
