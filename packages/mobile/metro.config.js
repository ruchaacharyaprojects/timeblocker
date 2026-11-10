/**
 * Metro configuration for the TimeBlocker monorepo (no root workspace).
 *
 * The pure packages are `file:` dependencies, installed as symlinks under
 * `node_modules/@timeblocker/*`. Metro must watch their real folders, resolve
 * their imports against this app's single `node_modules`, and never bundle a
 * sibling package's own `node_modules` (which would duplicate dependencies).
 * Linked packages are consumed from their built `dist/` (run `npm run prebundle`).
 *
 * https://reactnative.dev/docs/metro
 */
const path = require('node:path');
const { getDefaultConfig, mergeConfig } = require('@react-native/metro-config');

const projectRoot = __dirname;
const packagesRoot = path.resolve(projectRoot, '..');

/** Sibling packages linked into the app with `file:` dependencies. */
const LINKED_PACKAGES = [
  'scheduling-engine',
  'calendar-integration',
  'reminders',
  'usage-metrics',
  'flows',
  'app-core',
];

const linkedRoots = LINKED_PACKAGES.map(name => path.join(packagesRoot, name));

/** Escape a filesystem path for use inside a RegExp (paths may contain spaces, dots, parens). */
function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** One pattern per sibling: anything under `<sibling>/node_modules/`. */
const siblingNodeModulesBlockList = linkedRoots.map(
  root => new RegExp(`^${escapeRegExp(path.join(root, 'node_modules'))}[/\\\\].*$`),
);

const defaultConfig = getDefaultConfig(projectRoot);
const defaultBlockList = defaultConfig.resolver.blockList;
const inheritedBlockList =
  defaultBlockList == null ? [] : Array.isArray(defaultBlockList) ? defaultBlockList : [defaultBlockList];

/** @type {import('@react-native/metro-config').MetroConfig} */
const config = {
  watchFolders: linkedRoots,
  resolver: {
    nodeModulesPaths: [path.resolve(projectRoot, 'node_modules')],
    unstable_enableSymlinks: true,
    unstable_enablePackageExports: true,
    blockList: [...inheritedBlockList, ...siblingNodeModulesBlockList],
  },
};

module.exports = mergeConfig(defaultConfig, config);
