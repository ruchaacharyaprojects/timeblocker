/**
 * Shared data contracts for TimeBlocker custom reminders (R5).
 *
 * Instants are ISO-8601 strings (absolute, timezone-aware), matching the
 * scheduling-engine and calendar-integration public surfaces. The selection
 * logic is pure and deterministic; the only impure edge (delivering a push
 * notification) is kept behind the injected {@link NotificationPort}.
 */

/**
 * The actionable buttons every custom reminder carries (R5.2, R17.4):
 *   - "im-in"  -> "I'll be there" (commit to the block/meeting)
 *   - "move-it"-> "Move to later this week" (reschedule to the next valid slot)
 *
 * "skip" stays a valid id so a notification armed by an older build, whose
 * Skip button is still on screen, keeps routing; no new reminder offers it.
 *
 * The stable action ids are what the Android actionable-notification handler
 * maps its tap callbacks to; the labels are what the user sees.
 */
export type ReminderActionId = "im-in" | "skip" | "move-it";
export interface ReminderAction {
  id: ReminderActionId;
  label: string;
}
/**
 * The fixed, ordered set of actions on a custom reminder (R5.2, R17.4).
 * Exported as a constant so both the selection logic and the native handler
 * agree on the exact ids and labels.
 */
export const REMINDER_ACTIONS: readonly ReminderAction[] = [
  { id: "im-in", label: "I'll be there" },
  { id: "move-it", label: "Move to later this week" },
] as const;
/**
 * The three-button set the retained AWS backend scheduler still delivers
 * (R5.2). Device reminders use {@link REMINDER_ACTIONS} (R17.4).
 */
export const LEGACY_REMINDER_ACTIONS: readonly ReminderAction[] = [
  { id: "im-in", label: "I'm in" },
  { id: "skip", label: "Skip" },
  { id: "move-it", label: "Move it" },
] as const;
/** What a reminder is about: one of our own blocks, or a calendar meeting. */
export type ReminderKind = "block" | "meeting";

/**
 * A TimeBlocker-authored block, as persisted in DynamoDB and read back for
 * reminders. `start`/`end` are absolute ISO instants.
 */
export interface ReminderBlock {
  id: string;
  /** Human-readable title (without the 🧱 prefix). */
  title: string;
  start: string;
  end: string;
}

/**
 * A real calendar event (meeting) read from Google. `withOthers` marks events
 * that include attendees besides the owner — only those get a reminder (R5.1).
 */
export interface ReminderMeeting {
  id: string;
  summary: string;
  start: string;
  end: string;
  /** True when the event includes other people. */
  withOthers: boolean;
}

/**
 * A fully-formed custom notification ready for delivery. The selection logic
 * produces these; the notification port delivers them (R5.1, R5.2).
 */
export interface ReminderNotification {
  /** Stable id: `${kind}:${sourceId}` so repeat ticks can dedupe downstream. */
  id: string;
  kind: ReminderKind;
  /** The source block/meeting id this reminder is for. */
  sourceId: string;
  title: string;
  /** Short body, e.g. "Starts in 15 minutes". */
  body: string;
  /** The event start this reminder fires ahead of (ISO instant). */
  startsAt: string;
  /** The three actionable buttons (R5.2). */
  actions: readonly ReminderAction[];
}
