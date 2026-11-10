/**
 * Display colors for the view models (R4.1, R11.7).
 *
 * Google Calendar stores an event's color as a `colorId` ("1"-"11") from its
 * standard *event* palette (Calendar API `colors.get` → `event`). The app has
 * no network call for that palette, so the hex values Google Calendar shows
 * for each id are mapped here:
 *
 * | colorId | Name      | Hex       |
 * |---------|-----------|-----------|
 * | 1       | Lavender  | `#7986CB` |
 * | 2       | Sage      | `#33B679` |
 * | 3       | Grape     | `#8E24AA` |
 * | 4       | Flamingo  | `#E67C73` |
 * | 5       | Banana    | `#F6BF26` |
 * | 6       | Tangerine | `#F4511E` |
 * | 7       | Peacock   | `#039BE5` |
 * | 8       | Graphite  | `#616161` |
 * | 9       | Blueberry | `#3F51B5` |
 * | 10      | Basil     | `#0B8043` |
 * | 11      | Tomato    | `#D50000` |
 *
 * Categories use {@link CATEGORY_COLOR_ID} from calendar-integration, so the
 * week view shows a block in the same color as its Google Calendar event:
 * fitness → Flamingo, self-care → Lavender, work → Blueberry,
 * self-development → Basil, misc → Graphite.
 *
 * Non-TimeBlocker events use {@link CALENDAR_EVENT_STYLE}: a white fill and a
 * dashed grey border labeled "Calendar", which equals no category style.
 * Meaning is never carried by color alone: every item also has a text label.
 */
import { CATEGORY_COLOR_ID } from "@timeblocker/calendar-integration";
import type { Category } from "@timeblocker/scheduling-engine";

/** One entry of Google Calendar's standard event palette. */
export interface GoogleEventColor {
  name: string;
  /** `#RRGGBB` */
  hex: string;
}

/** Google Calendar's standard event palette, keyed by `colorId`. */
export const GOOGLE_EVENT_COLORS: Readonly<Record<string, GoogleEventColor>> = {
  "1": { name: "Lavender", hex: "#7986CB" },
  "2": { name: "Sage", hex: "#33B679" },
  "3": { name: "Grape", hex: "#8E24AA" },
  "4": { name: "Flamingo", hex: "#E67C73" },
  "5": { name: "Banana", hex: "#F6BF26" },
  "6": { name: "Tangerine", hex: "#F4511E" },
  "7": { name: "Peacock", hex: "#039BE5" },
  "8": { name: "Graphite", hex: "#616161" },
  "9": { name: "Blueberry", hex: "#3F51B5" },
  "10": { name: "Basil", hex: "#0B8043" },
  "11": { name: "Tomato", hex: "#D50000" },
};

/** All categories, in display order. */
export const CATEGORIES: readonly Category[] = [
  "work",
  "self-development",
  "fitness",
  "self-care",
  "misc",
];

/** Human-readable category names (shown next to the color, R11.7, R11.8). */
export const CATEGORY_LABELS: Readonly<Record<Category, string>> = {
  fitness: "Fitness",
  "self-care": "Self-care",
  work: "Work",
  "self-development": "Self-development",
  misc: "Misc",
};

/** Hex for a Google `colorId`, or `undefined` when the id is not in the palette. */
export function hexForColorId(colorId: string): string | undefined {
  return GOOGLE_EVENT_COLORS[colorId]?.hex;
}

/** A category's display hex, from its Google `colorId` (R4.1, R11.7). */
export function categoryHex(category: Category): string {
  const hex = hexForColorId(CATEGORY_COLOR_ID[category]);
  // CATEGORY_COLOR_ID only uses palette ids; a test guards this.
  if (!hex) throw new Error(`No palette color for category ${category}`);
  return hex;
}

/** How an item is drawn in the week view. */
export interface ItemStyle {
  /** `#RRGGBB` fill. */
  fill: string;
  /** `#RRGGBB` border. */
  border: string;
  borderStyle: "solid" | "dashed";
  /** `#RRGGBB` text color with readable contrast on `fill`. */
  text: string;
}

/** A category block style: filled with the category color, white text. */
export function categoryStyle(category: Category): ItemStyle {
  const hex = categoryHex(category);
  // Banana is the only light palette color; no category uses it, but keep text readable.
  const text = hex === GOOGLE_EVENT_COLORS["5"]!.hex ? "#202124" : "#FFFFFF";
  return { fill: hex, border: hex, borderStyle: "solid", text };
}

/** The label shown on non-TimeBlocker events. */
export const CALENDAR_EVENT_LABEL = "Calendar";

/** The style of every non-TimeBlocker event: distinct from every category style (R11.7). */
export const CALENDAR_EVENT_STYLE: Readonly<ItemStyle> = {
  fill: "#FFFFFF",
  border: "#9E9E9E",
  borderStyle: "dashed",
  text: "#3C4043",
};
