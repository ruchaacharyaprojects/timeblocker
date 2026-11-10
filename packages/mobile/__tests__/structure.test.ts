/**
 * @jest-environment node
 *
 * Structural (smoke) tests for the app bundle (R12.6, R12.8):
 * - `mobile/src` (and the `index.js` entry) contains no backend URL
 *   (`execute-api`, `amazonaws.com`) and no `@timeblocker/infra` or
 *   `@aws-sdk/*` import, with ONE exception: `src/config.ts` may name the
 *   owner's AI API host pattern `*.execute-api.ca-central-1.amazonaws.com`
 *   (R35.3); every other file reaches it only through the config constant;
 * - every absolute http(s) URL in production sources points at a Google host
 *   (or, in `src/config.ts` only, that one AI host pattern).
 *
 * Files are discovered at run time, so new modules (adapters, navigation,
 * screens) are covered automatically. Exact versions and the absence of
 * infra/AWS dependencies in package.json are covered by exactVersions.test.ts.
 */
import fs from 'node:fs';
import path from 'node:path';

const PACKAGE_DIR = path.resolve(__dirname, '..');
const SRC_DIR = path.join(PACKAGE_DIR, 'src');
const SOURCE_EXT = /\.(ts|tsx|js|jsx|mjs|cjs)$/;
const TEST_FILE = /\.test\.(ts|tsx|js|jsx)$/;

/** Every source file under `dir`, recursively (skips node_modules). */
function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listSourceFiles(full));
    else if (entry.isFile() && SOURCE_EXT.test(entry.name)) out.push(full);
  }
  return out;
}

/** All scanned files: everything under src/ plus the app entry point. */
function scannedFiles(): string[] {
  const files = listSourceFiles(SRC_DIR);
  const entry = path.join(PACKAGE_DIR, 'index.js');
  if (fs.existsSync(entry)) files.push(entry);
  return files;
}

/** Module specifiers from static/dynamic imports, re-exports, require(), and jest.mock(). */
function importSpecifiers(source: string): string[] {
  const patterns = [
    /\bfrom\s+["']([^"']+)["']/g,
    /\bimport\s+["']([^"']+)["']/g,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
    /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,
    /\bjest\.(?:mock|requireActual|doMock)\s*\(\s*["']([^"']+)["']/g,
  ];
  const found: string[] = [];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) found.push(match[1]!);
  }
  return found;
}

const FORBIDDEN_IMPORTS: ReadonlyArray<(s: string) => boolean> = [
  s => /^@timeblocker\/infra($|\/)/.test(s),
  s => s.startsWith('@aws-sdk/'),
  s => /^aws-sdk($|\/)/.test(s),
  s => /^aws-cdk-lib($|\/)/.test(s),
];

function forbiddenImports(source: string): string[] {
  return importSpecifiers(source).filter(s => FORBIDDEN_IMPORTS.some(f => f(s)));
}

const BACKEND_URL = /execute-api|amazonaws\.com/gi;

/** The only file allowed to name the owner's AI API host (R35.3). */
const AI_CONFIG_FILE = path.join('src', 'config.ts');
/** The owner's API: exactly `*.execute-api.ca-central-1.amazonaws.com`. */
const AI_HOST = /^[a-z0-9-]+\.execute-api\.ca-central-1\.amazonaws\.com$/i;
const AI_HOST_SUFFIX_TEXT = /\.execute-api\.ca-central-1\.amazonaws\.com/gi;

function backendUrls(source: string, relPath: string = ''): string[] {
  // The config file may only contain the allowed suffix; anything else still counts.
  const text = relPath === AI_CONFIG_FILE ? source.replace(AI_HOST_SUFFIX_TEXT, '') : source;
  return [...text.matchAll(BACKEND_URL)].map(m => m[0]);
}

/** Hosts allowed in production sources: Google OAuth and Calendar (R12.3, R12.8). */
function isGoogleHost(host: string): boolean {
  const h = host.toLowerCase();
  return h === 'google.com' || h.endsWith('.google.com') || h === 'googleapis.com' || h.endsWith('.googleapis.com');
}

function nonGoogleHosts(source: string, relPath: string = ''): string[] {
  const hosts: string[] = [];
  for (const match of source.matchAll(/\bhttps?:\/\/([^/\s'"`?#:)]+)/gi)) {
    const host = match[1]!;
    if (isGoogleHost(host)) continue;
    if (relPath === AI_CONFIG_FILE && AI_HOST.test(host)) continue;
    hosts.push(host);
  }
  return hosts;
}

function rel(file: string): string {
  return path.relative(PACKAGE_DIR, file);
}

describe('scanner self-check', () => {
  it('detects forbidden imports in every syntax', () => {
    const sample = [
      `import { Api } from "@timeblocker/infra";`,
      `export * from '@timeblocker/infra/lambda/shared';`,
      `const s3 = await import("@aws-sdk/client-s3");`,
      `const ddb = require('@aws-sdk/lib-dynamodb');`,
      `import 'aws-sdk';`,
      `jest.mock('@aws-sdk/client-sqs');`,
      `import { plan } from "@timeblocker/flows";`,
      `import { View } from 'react-native';`,
    ].join('\n');
    expect(forbiddenImports(sample).sort()).toEqual(
      [
        '@timeblocker/infra',
        '@timeblocker/infra/lambda/shared',
        '@aws-sdk/client-s3',
        '@aws-sdk/lib-dynamodb',
        'aws-sdk',
        '@aws-sdk/client-sqs',
      ].sort(),
    );
  });

  it('detects backend URLs and non-Google hosts', () => {
    const sample = [
      `const a = "https://abc123.execute-api.us-east-1.amazonaws.com/prod";`,
      `const b = 'https://bucket.s3.AMAZONAWS.COM/x';`,
      `const c = "https://www.googleapis.com/calendar/v3";`,
      `const d = "https://accounts.google.com";`,
      `const e = "https://googleapis.com.evil.example/x";`,
    ].join('\n');
    expect(backendUrls(sample).length).toBeGreaterThanOrEqual(3);
    expect(nonGoogleHosts(sample)).toEqual([
      'abc123.execute-api.us-east-1.amazonaws.com',
      'bucket.s3.AMAZONAWS.COM',
      'googleapis.com.evil.example',
    ]);
  });

  it('allows the owner AI host (ca-central-1 execute-api) only in src/config.ts', () => {
    const ai = 'const a = "https://abc123.execute-api.ca-central-1.amazonaws.com/x";';
    expect(nonGoogleHosts(ai, AI_CONFIG_FILE)).toEqual([]);
    expect(backendUrls(ai, AI_CONFIG_FILE)).toEqual([]);
    // Any other file referencing it directly fails both checks.
    const other = path.join('src', 'adapters', 'aiClient.ts');
    expect(nonGoogleHosts(ai, other)).toEqual(['abc123.execute-api.ca-central-1.amazonaws.com']);
    expect(backendUrls(ai, other).length).toBeGreaterThan(0);
  });

  it('still rejects every other host, even in src/config.ts', () => {
    const others = [
      'https://abc123.execute-api.us-east-1.amazonaws.com',
      'https://abc123.execute-api.ca-west-1.amazonaws.com',
      'https://bucket.s3.ca-central-1.amazonaws.com',
      'https://execute-api.ca-central-1.amazonaws.com.evil.example',
      'https://evil.example.com',
    ];
    for (const url of others) {
      expect(nonGoogleHosts(`const a = "${url}";`, AI_CONFIG_FILE)).toHaveLength(1);
    }
    const wrongRegion = 'const a = "https://x.execute-api.us-east-1.amazonaws.com";';
    expect(backendUrls(wrongRegion, AI_CONFIG_FILE).length).toBeGreaterThan(0);
  });

  it('the shipped config names the AI host only as the ca-central-1 suffix', () => {
    const config = fs.readFileSync(path.join(PACKAGE_DIR, AI_CONFIG_FILE), 'utf8');
    expect(config).toContain('.execute-api.ca-central-1.amazonaws.com');
    expect(backendUrls(config, AI_CONFIG_FILE)).toEqual([]);
    expect(nonGoogleHosts(config, AI_CONFIG_FILE)).toEqual([]);
  });
});

describe('mobile/src structure (R12.6, R12.8)', () => {
  const files = scannedFiles();

  it('finds source files to scan', () => {
    expect(files.some(f => f.startsWith(SRC_DIR))).toBe(true);
  });

  it('imports no @timeblocker/infra, @aws-sdk/*, aws-sdk, or aws-cdk-lib', () => {
    const violations = files.flatMap(file =>
      forbiddenImports(fs.readFileSync(file, 'utf8')).map(spec => `${rel(file)}: ${spec}`),
    );
    expect(violations).toEqual([]);
  });

  it('contains no backend URL (execute-api, amazonaws.com) outside the AI host in src/config.ts', () => {
    const violations = files.flatMap(file =>
      backendUrls(fs.readFileSync(file, 'utf8'), rel(file)).map(hit => `${rel(file)}: ${hit}`),
    );
    expect(violations).toEqual([]);
  });

  it('production sources reference only Google http(s) hosts (plus the AI host in src/config.ts)', () => {
    // Tests may legitimately use non-Google URLs to exercise rejection paths.
    const violations = files
      .filter(file => !TEST_FILE.test(file))
      .flatMap(file => nonGoogleHosts(fs.readFileSync(file, 'utf8'), rel(file)).map(host => `${rel(file)}: ${host}`));
    expect(violations).toEqual([]);
  });
});
