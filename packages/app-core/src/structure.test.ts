/**
 * Structural (smoke) tests for the on-device core (R12.6, R12.8, R12.10, D10):
 * - app-core sources import no react-native / native libraries, AWS SDKs,
 *   CDK, or the infra package;
 * - the flows and app-core package.json files pin exact versions only.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC_DIR = dirname(fileURLToPath(import.meta.url));
const PACKAGE_DIR = dirname(SRC_DIR);
const PACKAGES_DIR = dirname(PACKAGE_DIR);

/** Every `.ts` file under `dir`, recursively. */
function listTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...listTsFiles(full));
    else if (name.endsWith(".ts")) out.push(full);
  }
  return out;
}

/** Module specifiers from static/dynamic imports, re-exports, and require(). */
function importSpecifiers(source: string): string[] {
  const patterns = [
    /\bfrom\s+["']([^"']+)["']/g,
    /\bimport\s+["']([^"']+)["']/g,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
    /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,
  ];
  const found: string[] = [];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) found.push(match[1]!);
  }
  return found;
}

const FORBIDDEN: ReadonlyArray<{ label: string; test: (s: string) => boolean }> = [
  { label: "react-native", test: (s) => /^react-native($|[/-])/.test(s) },
  { label: "@react-native*", test: (s) => s.startsWith("@react-native") },
  { label: "@aws-sdk/*", test: (s) => s.startsWith("@aws-sdk/") },
  { label: "aws-cdk-lib", test: (s) => /^aws-cdk-lib($|\/)/.test(s) },
  { label: "@timeblocker/infra", test: (s) => /^@timeblocker\/infra($|\/)/.test(s) },
];

function forbiddenImports(source: string): string[] {
  return importSpecifiers(source).filter((s) => FORBIDDEN.some((f) => f.test(s)));
}

describe("app-core import boundary", () => {
  it("detects forbidden imports in every syntax (scanner self-check)", () => {
    const sample = [
      `import { View } from "react-native";`,
      `import Keychain from "react-native-keychain";`,
      `import "@react-native-async-storage/async-storage";`,
      `const s3 = await import("@aws-sdk/client-s3");`,
      `const cdk = require("aws-cdk-lib/aws-lambda");`,
      `export * from "@timeblocker/infra";`,
      `import { ok } from "@timeblocker/flows";`,
    ].join("\n");
    expect(forbiddenImports(sample).sort()).toEqual([
      "react-native",
      "react-native-keychain",
      "@react-native-async-storage/async-storage",
      "@aws-sdk/client-s3",
      "aws-cdk-lib/aws-lambda",
      "@timeblocker/infra",
    ].sort());
  });

  it("app-core sources import no react-native, @aws-sdk/*, aws-cdk-lib, or @timeblocker/infra", () => {
    // This file is excluded only because its self-check sample spells out
    // forbidden imports as string data.
    const self = fileURLToPath(import.meta.url);
    const files = listTsFiles(SRC_DIR).filter((f) => f !== self);
    expect(files.length).toBeGreaterThan(0);
    const violations = files.flatMap((file) =>
      forbiddenImports(readFileSync(file, "utf8")).map(
        (spec) => `${relative(PACKAGE_DIR, file)}: ${spec}`,
      ),
    );
    expect(violations).toEqual([]);
  });

  it("app-core package.json declares none of the forbidden packages", () => {
    const pkg = JSON.parse(readFileSync(join(PACKAGE_DIR, "package.json"), "utf8"));
    const names = Object.keys({
      ...pkg.dependencies,
      ...pkg.devDependencies,
      ...pkg.peerDependencies,
      ...pkg.optionalDependencies,
    });
    expect(names.filter((n) => FORBIDDEN.some((f) => f.test(n)))).toEqual([]);
  });
});

/** An exact semver version (no ranges, tags, or wildcards) or a local `file:` link. */
const EXACT_VERSION = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/;

function nonExactVersions(pkgPath: string): string[] {
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  const sections = [
    "dependencies",
    "devDependencies",
    "peerDependencies",
    "optionalDependencies",
  ] as const;
  const bad: string[] = [];
  for (const section of sections) {
    for (const [name, version] of Object.entries<string>(pkg[section] ?? {})) {
      if (!(EXACT_VERSION.test(version) || version.startsWith("file:"))) {
        bad.push(`${section}.${name}: ${version}`);
      }
    }
  }
  return bad;
}

describe("exact dependency versions (D10)", () => {
  it.each(["flows", "app-core"])("%s/package.json pins exact versions only", (pkg) => {
    expect(nonExactVersions(join(PACKAGES_DIR, pkg, "package.json"))).toEqual([]);
  });

  it("rejects ranges and tags", () => {
    for (const v of ["^1.2.3", "~1.2.3", ">=1.0.0", "1.x", "*", "latest", "1.2"]) {
      expect(EXACT_VERSION.test(v)).toBe(false);
    }
    expect(EXACT_VERSION.test("5.9.3")).toBe(true);
  });
});
