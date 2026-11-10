/**
 * Jest config: React Native preset (runs on Node, no device or SDK) plus
 * React Native Testing Library. Native libraries are mocked at the adapter
 * boundary inside individual tests.
 */
const path = require('node:path');

module.exports = {
  preset: '@react-native/jest-preset',
  roots: ['<rootDir>/src', '<rootDir>/__tests__'],
  // Linked packages resolve to their real paths (../<pkg>/dist). Like Metro's
  // `nodeModulesPaths`, fall back to this app's node_modules so imports from
  // inside them (including injected @babel/runtime helpers) resolve here.
  moduleDirectories: ['node_modules', path.join(__dirname, 'node_modules')],
  testMatch: ['**/?(*.)test.[jt]s?(x)'],
  // Transform RN, RN community libs, React Navigation, and the linked
  // @timeblocker packages (ESM `dist/`); leave everything else untransformed.
  transformIgnorePatterns: [
    'node_modules/(?!((jest-)?react-native|@react-native(-community)?|@react-native-async-storage|@react-navigation|@timeblocker)/)',
  ],
};
