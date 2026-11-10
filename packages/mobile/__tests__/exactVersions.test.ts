/**
 * @jest-environment node
 *
 * D10: package.json uses only exact versions (no ^, ~, ranges, tags, or URLs),
 * except `file:` links to the sibling pure packages.
 */
import fs from 'node:fs';
import path from 'node:path';

type DepMap = Record<string, string>;
interface PackageJson {
  dependencies?: DepMap;
  devDependencies?: DepMap;
  optionalDependencies?: DepMap;
  peerDependencies?: DepMap;
}

const pkg = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', 'package.json'), 'utf8')) as PackageJson;

const EXACT = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;
const LINKED = /^file:\.\.\/[a-z-]+$/;

const LINKED_PACKAGES = [
  '@timeblocker/app-core',
  '@timeblocker/calendar-integration',
  '@timeblocker/flows',
  '@timeblocker/reminders',
  '@timeblocker/scheduling-engine',
  '@timeblocker/usage-metrics',
];

function allDeps(): Array<[string, string]> {
  return [pkg.dependencies, pkg.devDependencies, pkg.optionalDependencies, pkg.peerDependencies].flatMap(map =>
    Object.entries(map ?? {}),
  );
}

describe('package.json versions', () => {
  it('pins every non-linked dependency to an exact version', () => {
    const loose = allDeps().filter(([name, spec]) => !name.startsWith('@timeblocker/') && !EXACT.test(spec));
    expect(loose).toEqual([]);
  });

  it('links every @timeblocker package with a file: dependency', () => {
    const timeblocker = allDeps().filter(([name]) => name.startsWith('@timeblocker/'));
    for (const [, spec] of timeblocker) {
      expect(spec).toMatch(LINKED);
    }
    expect(Object.keys(pkg.dependencies ?? {}).filter(n => n.startsWith('@timeblocker/')).sort()).toEqual(
      LINKED_PACKAGES,
    );
  });

  it('pins the React Native and React versions from the design', () => {
    expect(pkg.dependencies?.['react-native']).toBe('0.88.1');
    expect(pkg.dependencies?.react).toBe('19.3.1');
  });

  it('does not depend on the backend or AWS', () => {
    const names = allDeps().map(([name]) => name);
    expect(names).not.toContain('@timeblocker/infra');
    expect(names.filter(n => n.startsWith('@aws-sdk/') || n === 'aws-cdk-lib')).toEqual([]);
  });
});
