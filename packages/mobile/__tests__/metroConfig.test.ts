/**
 * @jest-environment node
 *
 * Smoke test: the monorepo Metro config watches every linked sibling package,
 * resolves through this app's single node_modules, enables symlinks and package
 * exports, and blocks each sibling's own node_modules.
 */
import path from 'node:path';

interface LoadedMetroConfig {
  watchFolders: string[];
  resolver: {
    nodeModulesPaths: string[];
    unstable_enableSymlinks: boolean;
    unstable_enablePackageExports: boolean;
    blockList: RegExp | RegExp[];
  };
}

const mobileRoot = path.resolve(__dirname, '..');
const packagesRoot = path.resolve(mobileRoot, '..');
const SIBLINGS = ['scheduling-engine', 'calendar-integration', 'reminders', 'usage-metrics', 'flows', 'app-core'];

const config = require('../metro.config.js') as LoadedMetroConfig;

function isBlocked(file: string): boolean {
  const list = Array.isArray(config.resolver.blockList) ? config.resolver.blockList : [config.resolver.blockList];
  return list.some(re => re.test(file));
}

describe('metro.config.js', () => {
  it('watches every linked sibling package root', () => {
    for (const name of SIBLINGS) {
      expect(config.watchFolders).toContain(path.join(packagesRoot, name));
    }
  });

  it('resolves only through the app node_modules', () => {
    expect(config.resolver.nodeModulesPaths).toEqual([path.join(mobileRoot, 'node_modules')]);
  });

  it('enables symlinks and package exports explicitly', () => {
    expect(config.resolver.unstable_enableSymlinks).toBe(true);
    expect(config.resolver.unstable_enablePackageExports).toBe(true);
  });

  it("blocks each sibling's own node_modules but not its dist or the app's node_modules", () => {
    for (const name of SIBLINGS) {
      expect(isBlocked(path.join(packagesRoot, name, 'node_modules', 'typescript', 'lib', 'typescript.js'))).toBe(true);
      expect(isBlocked(path.join(packagesRoot, name, 'dist', 'index.js'))).toBe(false);
    }
    expect(isBlocked(path.join(mobileRoot, 'node_modules', 'react', 'index.js'))).toBe(false);
  });
});
