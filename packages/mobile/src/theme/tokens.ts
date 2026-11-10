/**
 * Theme tokens (design D22; R26). The one place colors are defined: screens
 * read them through `useTheme()` and never hard-code a color.
 *
 * - Light: sage/mint background, near-white cards, dark charcoal text, light amber
 *   primary with dark text on it (white would only reach about 2.4:1).
 * - Dark: deep green-grey background, lighter card surfaces, light text, the
 *   same light amber primary.
 * - `surfaceStrong` is the dark green surface of a great-progress card (R26.4);
 *   `great` (lightning yellow) and `textOnStrong` are the readable text colors
 *   on it, in both modes.
 * - `outline` is the light amber that is readable as text/border on `background` and
 *   `surface` (outlined buttons, links); `primary` is for fills only.
 *
 * Every text/background pairing is checked at >= 4.5:1 in `tokens.test.ts`.
 */

export interface IconTint {
  /** The round badge fill. */
  tint: string;
  /** The glyph drawn on it. */
  glyph: string;
}

export interface Theme {
  /** Screen background. */
  background: string;
  /** Card and input surface. */
  surface: string;
  /** Dark green surface of a great-progress card. */
  surfaceStrong: string;
  text: string;
  textMuted: string;
  /** Text on `surfaceStrong`. */
  textOnStrong: string;
  border: string;
  /** Fill for primary buttons (never text on a light surface). */
  primary: string;
  /** Text on `primary`. */
  onPrimary: string;
  /** Light amber text/border/links that pass on `background` and `surface`. */
  outline: string;
  accent: string;
  /** Lightning yellow, for text on `surfaceStrong`. */
  great: string;
  danger: string;
  warning: string;
  /** Pale press highlight. */
  pressed: string;
  icons: {
    check: IconTint;
    moon: IconTint;
    run: IconTint;
    'double-arrow': IconTint;
  };
}

export const lightTheme: Theme = {
  background: '#D9ECD6',
  surface: '#F5FAF3',
  surfaceStrong: '#14301F',
  text: '#1E2A22',
  textMuted: '#4F6256',
  textOnStrong: '#F5FAF3',
  border: '#B9D1B5',
  primary: '#FFC94D',
  onPrimary: '#1E2A22',
  outline: '#8A5A00',
  accent: '#FFC94D',
  great: '#FFEE33',
  danger: '#C5221F',
  warning: '#9A5200',
  pressed: '#C9E0C5',
  icons: {
    check: { tint: '#DCEBFF', glyph: '#1A5FD0' },
    moon: { tint: '#E6E0FA', glyph: '#4B3FB5' },
    run: { tint: '#D5F2DC', glyph: '#1E7A3C' },
    'double-arrow': { tint: '#FFE6D0', glyph: '#B35400' },
  },
};

export const darkTheme: Theme = {
  background: '#101814',
  surface: '#1B2820',
  surfaceStrong: '#0E2A18',
  text: '#E6F0E8',
  textMuted: '#A8BBAE',
  textOnStrong: '#E6F0E8',
  border: '#2E4034',
  primary: '#FFC94D',
  onPrimary: '#1E2A22',
  outline: '#FFD27A',
  accent: '#FFC94D',
  great: '#FFEE33',
  danger: '#FF8A80',
  warning: '#FFB74D',
  pressed: '#26382D',
  icons: {
    check: { tint: '#1F3350', glyph: '#8FB8FF' },
    moon: { tint: '#2E2A52', glyph: '#B7AEFF' },
    run: { tint: '#1E4630', glyph: '#7FDC9C' },
    'double-arrow': { tint: '#4A301C', glyph: '#FFB074' },
  },
};
