import { contrastRatio, parseHex } from './contrast';
import { darkTheme, lightTheme, type Theme } from './tokens';

describe('contrastRatio', () => {
  it('is 21 for black on white and 1 for identical colors', () => {
    expect(contrastRatio('#000000', '#FFFFFF')).toBeCloseTo(21, 5);
    expect(contrastRatio('#FFFFFF', '#000')).toBeCloseTo(21, 5);
    expect(contrastRatio('#336699', '#336699')).toBeCloseTo(1, 5);
  });
  it('is symmetric', () => {
    expect(contrastRatio('#FFC94D', '#1E2A22')).toBeCloseTo(contrastRatio('#1E2A22', '#FFC94D'), 10);
  });
  it('rejects non-hex input', () => {
    expect(() => parseHex('red')).toThrow();
  });
});

const themes: Array<[string, Theme]> = [
  ['light', lightTheme],
  ['dark', darkTheme],
];

describe.each(themes)('%s theme contrast (R26.3)', (_name, t) => {
  const textPairs: Array<[string, string, string]> = [
    ['text / background', t.text, t.background],
    ['text / surface', t.text, t.surface],
    ['textMuted / background', t.textMuted, t.background],
    ['textMuted / surface', t.textMuted, t.surface],
    ['onPrimary / primary', t.onPrimary, t.primary],
    ['outline / background', t.outline, t.background],
    ['outline / surface', t.outline, t.surface],
    ['great / surfaceStrong', t.great, t.surfaceStrong],
    ['textOnStrong / surfaceStrong', t.textOnStrong, t.surfaceStrong],
    ['danger / background', t.danger, t.background],
    ['danger / surface', t.danger, t.surface],
    ['warning / background', t.warning, t.background],
    ['warning / surface', t.warning, t.surface],
  ];
  it.each(textPairs)('%s is at least 4.5:1', (_label, fg, bg) => {
    expect(contrastRatio(fg, bg)).toBeGreaterThanOrEqual(4.5);
  });

  it.each(['check', 'moon', 'run', 'double-arrow'] as const)('the %s glyph is at least 3:1 on its tint', (icon) => {
    expect(contrastRatio(t.icons[icon].glyph, t.icons[icon].tint)).toBeGreaterThanOrEqual(3);
  });

  it('the card border is visible against the background without being text', () => {
    expect(contrastRatio(t.border, t.background)).toBeGreaterThan(1);
  });

  it('uses the same light amber primary and dark text on it in both modes', () => {
    expect(t.primary).toBe(lightTheme.primary);
    expect(t.onPrimary).toBe(lightTheme.onPrimary);
  });

  it('great is lightning yellow', () => {
    expect(t.great).toBe('#FFEE33');
  });
});

describe('theme palettes', () => {
  it('light has a sage background and near-white cards; dark has a deep background', () => {
    expect(lightTheme.background).toBe('#D9ECD6');
    expect(contrastRatio(lightTheme.surface, '#FFFFFF')).toBeLessThan(1.15);
    expect(contrastRatio(darkTheme.background, '#000000')).toBeLessThan(2);
  });
  it('white text on light amber would fail, so onPrimary is dark', () => {
    expect(contrastRatio('#FFFFFF', lightTheme.primary)).toBeLessThan(4.5);
  });
});
