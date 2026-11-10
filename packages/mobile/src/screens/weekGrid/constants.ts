/** Layout constants for the week time grid (R16, design D13). */
export const HOUR_HEIGHT = 48;
export const HOURS_PER_DAY = 24;
export const GRID_HEIGHT = HOURS_PER_DAY * HOUR_HEIGHT;
export const GUTTER_WIDTH = 44;
/** Vertical gap (dp) trimmed from each rectangle so adjacent items stay distinct. */
export const ITEM_GAP = 2;
export const MIN_ITEM_HEIGHT = 8;
export const BELL_LABEL = 'Needs attention';


export const EMPTY_WEEK_HINT = 'Nothing scheduled this week. Tap Plan your week to add a list.';

/** Y offset (dp) for a minute-of-day value. */
export const minToY = (min: number): number => (min / 60) * HOUR_HEIGHT;

/** "1 AM" … "11 PM"; hour 0 has no label. */
export function hourLabel(hour: number): string {
  if (hour <= 0) return '';
  const h12 = hour % 12 === 0 ? 12 : hour % 12;
  return `${h12} ${hour < 12 ? 'AM' : 'PM'}`;
}
