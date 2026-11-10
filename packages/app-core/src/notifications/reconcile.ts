/**
 * The pure notification reconcile plan (design: "Reconcile").
 *
 * Diffs the desired set ({@link desiredNotifications}) against the stored
 * `notifRegistry` and the native pending set (`Notifier.listPending()`), and
 * returns one decision per notification id: the native call to make (if any)
 * and the registry entry to keep when that call succeeds or fails.
 *
 * Rules (R13.1, R13.2, R13.7, R13.10, R13.11, R14.7):
 * - A registry entry that is no longer desired is cancelled when its source
 *   still starts in the future (block moved, skipped, or deleted in Google
 *   Calendar), and dropped from the registry.
 * - An entry whose source start has passed is pruned from the registry; it is
 *   only cancelled when its alarm is still armed natively (no reminder may
 *   fire for something that already started). A posted reminder for a block
 *   that just started is left visible.
 * - A desired entry that is absent, or `pending` with a different
 *   `fireAtMs`/`exact`/content (title, body, actions: R17.5), is (re)scheduled. A `pending` entry missing from the
 *   native pending set is re-armed (force-stop clears alarms on Android).
 * - A `pending` entry missing natively whose `fireAtMs ≤ now` already fired:
 *   it is recorded as `shown` and not shown again.
 * - A desired entry whose `fireAtMs ≤ now` is delivered with `showNow` (after
 *   cancelling any armed alarm for the same id) and recorded as `shown`.
 * - `shown` entries that are still desired are left alone, so repeated
 *   reconciles never re-show an immediate reminder.
 * - Armed alarms with a TimeBlocker-managed id (`rem:`, `nudge:`) that are
 *   neither desired nor in the registry are cancelled.
 * - Registry entries of kinds reconcile does not own (`miss-prompt`,
 *   `status`) are never touched natively; they are pruned from the registry
 *   once their `startMs` has passed.
 *
 * Applying the plan and then planning again with the same inputs yields no
 * native calls (idempotence, R13.7).
 */
import type { RegistryEntry, RegistryKind } from "../models.js";
import type { DesiredNotification } from "./desired.js";

/** Kinds whose lifecycle reconcile owns (the desired set's kinds). */
export const RECONCILED_KINDS: ReadonlySet<RegistryKind> = new Set<RegistryKind>([
  "block-reminder",
  "meeting-reminder",
  "weekly-nudge",
]);

/** Id prefixes of notifications reconcile owns (see `desired.ts`). */
const RECONCILED_ID_PREFIXES = ["rem:block:", "rem:meeting:", "nudge:"] as const;

/** Whether `id` belongs to a notification kind reconcile owns. */
export function isReconciledId(id: string): boolean {
  return RECONCILED_ID_PREFIXES.some((p) => id.startsWith(p));
}

/** The native call a decision makes. */
export type ReconcileAction =
  | { type: "schedule"; desired: DesiredNotification }
  /** `cancelFirst` when an alarm for the same id is still armed. */
  | { type: "show"; desired: DesiredNotification; cancelFirst: boolean }
  | { type: "cancel" };

/** One id's outcome: an optional action and the registry entry to keep. */
export interface ReconcileDecision {
  id: string;
  action?: ReconcileAction;
  /** Registry entry to keep when the action succeeds (or when there is none). */
  onSuccess: RegistryEntry | null;
  /** Registry entry to keep when the action throws. */
  onFailure: RegistryEntry | null;
}

export interface ReconcilePlanInput {
  desired: readonly DesiredNotification[];
  registry: readonly RegistryEntry[];
  /** Ids from `Notifier.listPending()`. */
  pending: readonly string[];
  /** epoch ms */
  now: number;
}

/**
 * A short, stable hash of what the user sees in a notification (title, body,
 * actions, deep link). Same id with a different key means the armed
 * notification is stale and must be replaced (R17.5).
 */
export function contentKeyOf(desired: DesiredNotification): string {
  const { title, body, actions, deepLink } = desired.payload;
  const text = JSON.stringify([title, body, actions.map((a) => [a.id, a.label]), deepLink ?? null]);
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

/** The registry entry describing a desired notification in `state`. */
export function registryEntryFor(
  desired: DesiredNotification,
  state: RegistryEntry["state"],
  exact = desired.exact,
): RegistryEntry {
  return {
    id: desired.payload.id,
    kind: desired.kind,
    sourceId: desired.sourceId,
    startMs: desired.startMs,
    fireAtMs: desired.fireAtMs,
    exact,
    state,
    contentKey: contentKeyOf(desired),
  };
}

/**
 * Show now. On failure the id leaves the registry, so the next pass treats it
 * as absent and shows it then (an armed alarm may already be cancelled).
 */
function deliverNow(desired: DesiredNotification, armed: boolean): ReconcileDecision {
  return {
    id: desired.payload.id,
    action: { type: "show", desired, cancelFirst: armed },
    onSuccess: registryEntryFor(desired, "shown"),
    onFailure: null,
  };
}

function schedule(desired: DesiredNotification, onFailure: RegistryEntry | null): ReconcileDecision {
  return {
    id: desired.payload.id,
    action: { type: "schedule", desired },
    onSuccess: registryEntryFor(desired, "pending"),
    onFailure,
  };
}

const keep = (entry: RegistryEntry): ReconcileDecision => ({
  id: entry.id,
  onSuccess: entry,
  onFailure: entry,
});

/** Decide what to do for a registry entry that has a desired counterpart. */
function decideDesired(
  entry: RegistryEntry,
  desired: DesiredNotification,
  armed: boolean,
  now: number,
): ReconcileDecision {
  if (entry.state === "shown") return keep(entry);
  if (!armed && entry.fireAtMs <= now) {
    // The alarm fired and was posted; record it so it is not shown again.
    return keep({ ...entry, state: "shown" });
  }
  if (desired.fireAtMs <= now) return deliverNow(desired, armed);
  if (
    !armed ||
    entry.fireAtMs !== desired.fireAtMs ||
    entry.exact !== desired.exact ||
    entry.contentKey !== contentKeyOf(desired)
  ) {
    return schedule(desired, entry);
  }
  return keep(entry);
}

/** Decide what to do for a reconciled-kind registry entry that is no longer desired. */
function decideUndesired(entry: RegistryEntry, armed: boolean, now: number): ReconcileDecision {
  const started = entry.startMs <= now;
  if (started && !armed) return { id: entry.id, onSuccess: null, onFailure: null };
  // Keep the entry on a failed cancel so the next reconcile retries it.
  return { id: entry.id, action: { type: "cancel" }, onSuccess: null, onFailure: entry };
}

/**
 * Plan one reconcile pass. Pure and deterministic: decisions for registry
 * entries come first (registry order), then new desired entries (desired
 * order), then orphaned native alarms (pending order). Duplicate ids in the
 * registry are merged (first wins).
 */
export function planReconcile(input: ReconcilePlanInput): ReconcileDecision[] {
  const { now } = input;
  const desiredById = new Map<string, DesiredNotification>();
  for (const d of input.desired) {
    if (!desiredById.has(d.payload.id)) desiredById.set(d.payload.id, d);
  }
  const armed = new Set(input.pending);
  const seen = new Set<string>();
  const decisions: ReconcileDecision[] = [];

  for (const entry of input.registry) {
    if (seen.has(entry.id)) continue;
    seen.add(entry.id);
    if (!RECONCILED_KINDS.has(entry.kind)) {
      // Owned by other services (prompts, status): prune only.
      decisions.push(
        entry.startMs > now ? keep(entry) : { id: entry.id, onSuccess: null, onFailure: null },
      );
      continue;
    }
    const desired = desiredById.get(entry.id);
    decisions.push(
      desired
        ? decideDesired(entry, desired, armed.has(entry.id), now)
        : decideUndesired(entry, armed.has(entry.id), now),
    );
  }

  for (const [id, desired] of desiredById) {
    if (seen.has(id)) continue;
    seen.add(id);
    decisions.push(
      desired.fireAtMs <= now ? deliverNow(desired, armed.has(id)) : schedule(desired, null),
    );
  }

  for (const id of input.pending) {
    if (seen.has(id) || !isReconciledId(id)) continue;
    seen.add(id);
    decisions.push({ id, action: { type: "cancel" }, onSuccess: null, onFailure: null });
  }

  return decisions;
}
