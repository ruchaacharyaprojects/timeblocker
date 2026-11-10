/**
 * Guard for R26.1: every color comes from the theme. Scans the screen and
 * navigation sources for hex color literals and rgb()/rgba() calls.
 */
import * as fs from 'fs';
import * as path from 'path';

const SRC = path.resolve(__dirname, '..');
const SCAN_DIRS = ['screens', 'navigation'];
/** Files not yet migrated. Keep each entry with a reason; remove when migrated. */
const ALLOW_LIST: readonly string[] = [
  // TODO: replace the pure-black shadowColor (shadows are not text/background colors) with a theme token.
  'screens/DashboardScreen.tsx',
];
const HEX = /#[0-9a-fA-F]{3,8}\b/;
const RGB = /\brgba?\s*\(/;

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? walk(full) : [full];
  });
}

const files = SCAN_DIRS.flatMap((d) => walk(path.join(SRC, d)))
  .map((f) => path.relative(SRC, f).split(path.sep).join('/'))
  .filter((f) => /\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f) && !ALLOW_LIST.includes(f));

describe('no hard-coded colors (R26.1)', () => {
  it('scans the screen and navigation sources', () => {
    expect(files.length).toBeGreaterThan(10);
    expect(files).toContain('screens/IntakeScreen.tsx');
    expect(files).toContain('navigation/RootNavigator.tsx');
    expect(files).toContain('screens/PlanSummaryScreen.tsx');
    expect(files).toContain('screens/TimingEditor.tsx');
  });

  it.each(files)('%s has no hex or rgb() color literals', (file) => {
    const lines = fs.readFileSync(path.join(SRC, file), 'utf8').split('\n');
    const hits = lines
      .map((line, i) => ({ line, n: i + 1 }))
      .filter(({ line }) => !line.trim().startsWith('*') && !line.trim().startsWith('//'))
      .filter(({ line }) => HEX.test(line) || RGB.test(line))
      .map(({ line, n }) => `${file}:${n}: ${line.trim()}`);
    expect(hits).toEqual([]);
  });
});
