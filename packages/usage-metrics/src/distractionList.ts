/**
 * The user-editable distraction app list (R7.2).
 *
 * Pure, immutable operations over a set of Android package names. The list is
 * the single source of truth for which apps count as "distraction" when
 * aggregating usage. Callers persist the returned array (e.g. in Settings /
 * DynamoDB) themselves; this module does no I/O so it stays testable.
 *
 * Package names are normalized (trimmed, lower-cased) and de-duplicated so the
 * list behaves like a set regardless of casing or stray whitespace from the
 * UI.
 */

/**
 * Built-in social media apps that always count as distraction apps (R30.3),
 * in addition to whatever the user adds. Android package names.
 */
export const DEFAULT_DISTRACTION_APPS: readonly string[] = [
  "com.instagram.android", // Instagram
  "com.instagram.barcelona", // Threads
  "com.facebook.katana", // Facebook
  "com.facebook.lite", // Facebook Lite
  "com.facebook.orca", // Messenger
  "com.twitter.android", // X (Twitter)
  "com.twitter.android.lite", // X (Twitter) Lite
  "com.zhiliaoapp.musically", // TikTok
  "com.ss.android.ugc.trill", // TikTok (Asia)
  "com.reddit.frontpage", // Reddit
  "com.snapchat.android", // Snapchat
  "com.pinterest", // Pinterest
  "com.tumblr", // Tumblr
  "com.linkedin.android", // LinkedIn
  "com.discord", // Discord
  "org.telegram.messenger", // Telegram
  "com.google.android.youtube", // YouTube
  "xyz.blueskyweb.app", // Bluesky
  "org.joinmastodon.android", // Mastodon
  "com.bereal.ft", // BeReal
];

/**
 * The apps that count as distraction: the built-ins first, then the user's
 * own, normalized and unique.
 */
export function effectiveDistractionApps(userApps: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const app of [...DEFAULT_DISTRACTION_APPS, ...userApps]) {
    const norm = normalizePackageName(app);
    if (norm.length > 0 && !seen.has(norm)) {
      seen.add(norm);
      out.push(norm);
    }
  }
  return out;
}

/** Normalize a single package name for storage/comparison. */
export function normalizePackageName(pkg: string): string {
  return pkg.trim().toLowerCase();
}

/**
 * Build a canonical distraction list from arbitrary input: normalize each
 * entry, drop empties, de-duplicate, and sort for stable output.
 */
export function normalizeDistractionList(apps: readonly string[]): string[] {
  const set = new Set<string>();
  for (const app of apps) {
    const norm = normalizePackageName(app);
    if (norm.length > 0) set.add(norm);
  }
  return [...set].sort();
}

/** Add an app to the list. Returns a new list; no-ops if already present. */
export function addDistractionApp(
  apps: readonly string[],
  pkg: string,
): string[] {
  return normalizeDistractionList([...apps, pkg]);
}

/** Remove an app from the list. Returns a new list. */
export function removeDistractionApp(
  apps: readonly string[],
  pkg: string,
): string[] {
  const target = normalizePackageName(pkg);
  return normalizeDistractionList(apps).filter((a) => a !== target);
}

/** Whether a package name is on the (normalized) distraction list. */
export function isDistractionApp(
  apps: readonly string[],
  pkg: string,
): boolean {
  const target = normalizePackageName(pkg);
  return normalizeDistractionList(apps).includes(target);
}

/** A reusable membership predicate over a pre-normalized set. */
export function distractionMatcher(
  apps: readonly string[],
): (pkg: string) => boolean {
  const set = new Set(normalizeDistractionList(apps));
  return (pkg: string) => set.has(normalizePackageName(pkg));
}
