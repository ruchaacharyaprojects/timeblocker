module.exports = {
  presets: ['module:@react-native/babel-preset'],
  // The linked packages' ESM `dist/` uses `export * as ns from` (e.g. @timeblocker/flows),
  // which the RN preset does not transform. Needed by both Metro and Jest.
  plugins: ['@babel/plugin-transform-export-namespace-from'],
};
