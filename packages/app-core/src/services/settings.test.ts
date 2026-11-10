import type { PlanningMode } from "@timeblocker/scheduling-engine";
import { describe, expect, it } from "vitest";
import type { ThemeMode } from "../models.js";
import { DEFAULT_DEVICE_SETTINGS, Repositories } from "../repositories.js";
import { MemoryKeyValueStore } from "../testkit.js";
import { SettingsService, isIsoDate } from "./settings.js";

function setup() {
  const kv = new MemoryKeyValueStore();
  const service = new SettingsService(new Repositories(kv));
  /** A fresh service over the same store, as after an app restart. */
  const reopen = () => new SettingsService(new Repositories(kv));
  return { kv, service, reopen };
}

describe("isIsoDate", () => {
  it.each(["2025-07-01", "2024-02-29", "2025-12-31"])("accepts %s", (d) => {
    expect(isIsoDate(d)).toBe(true);
  });

  it.each([
    "",
    "2025-7-1",
    "2025/07/01",
    "2025-13-01",
    "2025-00-10",
    "2025-02-29",
    "2025-04-31",
    "2025-07-00",
    " 2025-07-01",
    "2025-07-01T00:00",
  ])("rejects %j", (d) => {
    expect(isIsoDate(d)).toBe(false);
  });
});

describe("SettingsService: planning mode", () => {
  it("defaults to exactly one mode and persists a change across reopen", async () => {
    const { service, reopen } = setup();
    expect((await service.get()).planningMode).toBe(DEFAULT_DEVICE_SETTINGS.planningMode);

    const result = await service.setPlanningMode("spread");
    expect(result).toMatchObject({ ok: true, changed: true });
    expect((await reopen().get()).planningMode).toBe("spread");
  });

  it("rejects an unknown mode and writes nothing", async () => {
    const { kv, service } = setup();
    const result = await service.setPlanningMode("both" as PlanningMode);
    expect(result).toMatchObject({ ok: false, error: "invalid-planning-mode" });
    expect(kv.writes).toBe(0);
  });
});

describe("SettingsService: theme mode", () => {
  it("is undefined (system) by default and persists a change across reopen", async () => {
    const { service, reopen } = setup();
    expect((await service.get()).themeMode).toBeUndefined();
    expect(await service.setThemeMode("dark")).toMatchObject({ ok: true, changed: true });
    expect((await reopen().get()).themeMode).toBe("dark");
    expect(await service.setThemeMode("dark")).toMatchObject({ ok: true, changed: false });
  });
  it("rejects an unknown mode and writes nothing", async () => {
    const { kv, service } = setup();
    expect(await service.setThemeMode("neon" as ThemeMode)).toMatchObject({
      ok: false,
      error: "invalid-theme-mode",
    });
    expect(kv.writes).toBe(0);
  });
  it("does not touch the planning mode flag", async () => {
    const { service } = setup();
    const r = await service.setThemeMode("light");
    expect(r.settings.planningModeSetByUser).toBeUndefined();
  });
});
describe("SettingsService: distraction apps", () => {
  it("adds and removes via the normalized usage-metrics list and persists", async () => {
    const { service, reopen } = setup();
    await service.addDistractionApp("com.instagram.android");
    await service.addDistractionApp("  COM.Reddit.Frontpage ");
    expect((await reopen().get()).distractionApps).toEqual([
      "com.instagram.android",
      "com.reddit.frontpage",
    ]);

    await service.removeDistractionApp("COM.INSTAGRAM.ANDROID");
    expect((await reopen().get()).distractionApps).toEqual(["com.reddit.frontpage"]);
  });

  it("treats a duplicate (any casing) as a no-op", async () => {
    const { kv, service } = setup();
    await service.addDistractionApp("com.a");
    const dup = await service.addDistractionApp("COM.A");
    expect(dup).toMatchObject({ ok: true, changed: false });
    expect(dup.settings.distractionApps).toEqual(["com.a"]);
    expect(kv.writes).toBe(1);
  });

  it("rejects an empty package name", async () => {
    const { kv, service } = setup();
    expect(await service.addDistractionApp("   ")).toMatchObject({ ok: false, error: "invalid-app" });
    expect(await service.removeDistractionApp("")).toMatchObject({ ok: false, error: "invalid-app" });
    expect(kv.writes).toBe(0);
  });

  it("leaves other settings untouched", async () => {
    const { service, reopen } = setup();
    await service.setPlanningMode("earliest-fit");
    await service.setThemeMode("dark");
    await service.addDistractionApp("com.a");
    expect(await reopen().get()).toEqual({
      planningMode: "earliest-fit",
      planningModeSetByUser: true,
      themeMode: "dark",
      holidays: [],
      distractionApps: ["com.a"],
    });
  });
});
