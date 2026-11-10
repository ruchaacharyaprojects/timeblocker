import { describe, it, expect } from "vitest";
import {
  DEFAULT_DISTRACTION_APPS,
  addDistractionApp,
  removeDistractionApp,
  isDistractionApp,
  normalizeDistractionList,
  distractionMatcher,
} from "./distractionList.js";

describe("distraction app list (R7.2)", () => {
  it("normalizes casing and whitespace and de-duplicates", () => {
    const list = normalizeDistractionList([
      "  Com.Instagram.Android  ",
      "com.instagram.android",
      "COM.TIKTOK",
    ]);
    expect(list).toEqual(["com.instagram.android", "com.tiktok"]);
  });

  it("drops empty / whitespace-only entries", () => {
    expect(normalizeDistractionList(["", "   ", "com.x"])).toEqual(["com.x"]);
  });

  it("adds an app without duplicating an existing one", () => {
    const start = ["com.a"];
    expect(addDistractionApp(start, "com.b")).toEqual(["com.a", "com.b"]);
    expect(addDistractionApp(start, "COM.A")).toEqual(["com.a"]);
  });

  it("removes an app regardless of casing and leaves the input untouched", () => {
    const start = ["com.a", "com.b"];
    expect(removeDistractionApp(start, "COM.A")).toEqual(["com.b"]);
    // original array is not mutated
    expect(start).toEqual(["com.a", "com.b"]);
  });

  it("reports membership case-insensitively", () => {
    expect(isDistractionApp(["com.a"], "COM.A")).toBe(true);
    expect(isDistractionApp(["com.a"], "com.z")).toBe(false);
  });

  it("builds a reusable matcher", () => {
    const match = distractionMatcher(["com.a", "com.b"]);
    expect(match("com.a")).toBe(true);
    expect(match("com.c")).toBe(false);
  });

  it("ships a non-empty default list the user can edit", () => {
    expect(DEFAULT_DISTRACTION_APPS.length).toBeGreaterThan(0);
    // defaults are already normalized package names
    expect(normalizeDistractionList(DEFAULT_DISTRACTION_APPS)).toEqual(
      normalizeDistractionList([...DEFAULT_DISTRACTION_APPS]),
    );
  });
});

describe("effectiveDistractionApps (R30.3)", () => {
  it("returns the built-ins for an empty user list", async () => {
    const { DEFAULT_DISTRACTION_APPS, effectiveDistractionApps } = await import("./distractionList.js");
    expect(effectiveDistractionApps([])).toEqual([...DEFAULT_DISTRACTION_APPS]);
    expect(DEFAULT_DISTRACTION_APPS).toContain("com.instagram.android");
  });

  it("adds user apps after the built-ins, unique and normalized", async () => {
    const { DEFAULT_DISTRACTION_APPS, effectiveDistractionApps } = await import("./distractionList.js");
    const out = effectiveDistractionApps(["com.mine", " COM.Instagram.Android ", "com.mine", ""]);
    expect(out.slice(0, DEFAULT_DISTRACTION_APPS.length)).toEqual([...DEFAULT_DISTRACTION_APPS]);
    expect(out.slice(DEFAULT_DISTRACTION_APPS.length)).toEqual(["com.mine"]);
    expect(new Set(out).size).toBe(out.length);
  });

  it("has no duplicate built-ins", async () => {
    const { DEFAULT_DISTRACTION_APPS } = await import("./distractionList.js");
    expect(new Set(DEFAULT_DISTRACTION_APPS).size).toBe(DEFAULT_DISTRACTION_APPS.length);
  });
});
