/**
 * `IntakeService`: the intake and item-review screens (R1.1-R1.3, R11.4-R11.6).
 *
 * - `validate(raw)` stores the exact submitted text in the `intakeDraft`
 *   document and returns either the normalized candidates or the typed
 *   rejection from `validateIntakeInput`. The draft survives an app kill, so
 *   the paste box (and, on success, the review rows) can be restored (R1.3,
 *   R11.6). Nothing is written to `items:<weekId>` here.
 * - `confirm(weekId, edits)` turns the draft's candidates (with the user's
 *   review edits) into confirmed items via `confirmItems`, persists them, and
 *   only then calls the injected planner. Nothing is planned before confirm
 *   (R1.3, R11.5).
 *
 * Planning is injected as a small {@link IntakePlanner} so `PlanningService`
 * can plug in without this module depending on it.
 */
import {
  CATEGORIES,
  TASK_KINDS,
  MAX_INTAKE_ITEMS,
  confirmItems,
  validateIntakeInput,
  type IgnoredLine,
  type IntakeCandidate,
  type IntakeItem,
  type IntakeRejectionReason,
  type ItemEdit,
} from "@timeblocker/flows";
import type { Category } from "@timeblocker/scheduling-engine";
import type { IntakeDraft } from "../models.js";
import type { Clock, IdGenerator } from "../ports.js";
import type { Repositories } from "../repositories.js";
import { weekIdAt } from "../notifications/service.js";
import type { HistorySource, IntakeHistory } from "./history.js";

// app-core compiles with no host types; React Native and Node provide these timers.
declare function setTimeout(callback: () => void, ms: number): unknown;
declare function clearTimeout(handle: unknown): void;
/** Toronto Sunday week id of a `YYYY-MM-DD` day. */
function weekIdOfDay(day: string): string | undefined {
  const ms = /^\d{4}-\d{2}-\d{2}$/.test(day) ? Date.parse(`${day}T12:00:00Z`) : NaN;
  return Number.isFinite(ms) ? weekIdAt(ms) : undefined;
}

/** The week an item belongs to: its fixed start, else its day, else `fallback`. */
function targetWeekId(c: IntakeCandidate, fallback: string): string {
  if (c.fixedStart !== undefined) {
    const ms = Date.parse(c.fixedStart);
    if (Number.isFinite(ms)) return weekIdAt(ms);
  }
  if (c.onDay !== undefined) return weekIdOfDay(c.onDay) ?? fallback;
  return fallback;
}

/** The planning step run after confirmation (implemented by `PlanningService`). */
export interface IntakePlanner<P = unknown> {
  plan(weekId: string): Promise<P>;
}

export interface IntakeServiceDeps<P = unknown> {
  repos: Repositories;
  clock: Clock;
  ids: IdGenerator;
  planner: IntakePlanner<P>;
  /** Past blocks and events for estimation; without it `submit` estimates from empty history. */
  history?: HistorySource;
  /**
   * Optional smarter list reader (R33): may adjust `category` and `kind` only.
   * Failures, timeouts and invalid output leave the candidates unchanged.
   */
  enhancer?: IntakeEnhancer;
}

/** Candidates in, candidates out; see {@link IntakeServiceDeps.enhancer}. */
export type IntakeEnhancer = (candidates: IntakeCandidate[]) => Promise<IntakeCandidate[]>;

/** The longest `validate` waits for the enhancer (R33.3). */
export const INTAKE_ENHANCER_TIMEOUT_MS = 6000;

/** Result of submitting the intake screen. `text` is always the exact input. */
export type IntakeValidateResult =
  | { ok: true; text: string; candidates: IntakeCandidate[]; ignored?: IgnoredLine[] }
  | { ok: false; text: string; reason: IntakeRejectionReason };

/**
 * A review-screen edit to one draft candidate, addressed by its position in
 * the draft's candidate list. Omitted fields keep the parsed suggestion.
 */
export interface CandidateEdit {
  index: number;
  text?: string;
  durationMin?: number;
  priority?: number;
  category?: Category;
}

/** Why `confirm` did nothing. */
export type IntakeConfirmError = "no-draft";

export type IntakeConfirmResult<P = unknown> =
  | {
      ok: true;
      weekId: string;
      confirmed: IntakeItem[];
      /** Plan of the requested week (empty when no item belongs to it). */
      plan: P;
      /** Plans of other weeks that received dated items, ascending by week. */
      otherPlans?: P[];
      /** Schedule notes, prefixed with the task title ("Dentist: ..."). */
      notes?: string[];
      ignored?: IgnoredLine[];
    }
  | { ok: false; error: IntakeConfirmError }
  /** The expanded item total exceeds the limit (e.g. a draft from an older version). */
  | { ok: false; error: "rejected"; reason: "too-many-items" };

/** Result of `submit`: the `confirm` result, or the validation rejection. */
export type IntakeSubmitResult<P = unknown> =
  | IntakeConfirmResult<P>
  | { ok: false; error: "rejected"; reason: IntakeRejectionReason };

export class IntakeService<P = unknown> {
  constructor(private readonly deps: IntakeServiceDeps<P>) {}

  /** The saved draft, if any (restores the paste box / review rows). */
  draft(): Promise<IntakeDraft | null> {
    return this.deps.repos.intakeDraft.get();
  }

  /**
   * Validate a submission and save it as the draft. On rejection the draft
   * keeps the exact text with no candidates, so a stale review list can never
   * be confirmed.
   */
  async validate(raw: string, history?: IntakeHistory): Promise<IntakeValidateResult> {
    const result = validateIntakeInput(raw, history, this.deps.clock.now());
    const draft: IntakeDraft = { text: raw, updatedAt: this.deps.clock.now() };
    if (result.ok) {
      result.candidates = await this.enhance(result.candidates);
      draft.candidates = result.candidates;
      if (result.ignored.length > 0) draft.ignored = result.ignored;
    }
    await this.deps.repos.intakeDraft.save(draft);
    if (!result.ok) return { ok: false, text: raw, reason: result.reason };
    // `ignored` is only present when something was skipped.
    return result.ignored.length > 0
      ? { ok: true, text: raw, candidates: result.candidates, ignored: result.ignored }
      : { ok: true, text: raw, candidates: result.candidates };
  }

  /**
   * Run the optional enhancer behind a 6 s race. The enhancer's output is
   * accepted only when it is the same length and every entry keeps the
   * built-in title, duration, priority, count and schedule fields.
   */
  private async enhance(candidates: IntakeCandidate[]): Promise<IntakeCandidate[]> {
    const enhancer = this.deps.enhancer;
    if (!enhancer || candidates.length === 0) return candidates;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const copy = candidates.map((c) => ({ ...c }));
      const timeout = new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), INTAKE_ENHANCER_TIMEOUT_MS);
      });
      const out = await Promise.race([enhancer(copy), timeout]);
      if (!Array.isArray(out) || out.length !== candidates.length) return candidates;
      const merged: IntakeCandidate[] = [];
      for (let i = 0; i < candidates.length; i++) {
        const base = candidates[i]!;
        const next = out[i];
        if (typeof next !== "object" || next === null) return candidates;
        const merge: IntakeCandidate = { ...base };
        if (next.kind !== undefined && TASK_KINDS.includes(next.kind)) merge.kind = next.kind;
        if (CATEGORIES.includes(next.category)) merge.category = next.category;
        merged.push(merge);
      }
      return merged;
    } catch {
      return candidates;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  /**
   * Validate `raw` with the last 26 weeks of history (R15.3, R15.4), save the
   * draft, then confirm and plan `weekId` in one step (R15.7, R15.8). A
   * history read failure falls back to empty history.
   */
  async submit(raw: string, weekId: string): Promise<IntakeSubmitResult<P>> {
    let history: IntakeHistory = { blocks: [], events: [] };
    try {
      if (this.deps.history) history = await this.deps.history.load(weekId);
    } catch {
      // Estimate from keywords and defaults instead.
    }
    const validated = await this.validate(raw, history);
    if (!validated.ok) return { ok: false, error: "rejected", reason: validated.reason };
    const confirmed = await this.confirm(weekId);
    return confirmed.ok ? { ...confirmed, ignored: validated.ignored ?? [] } : confirmed;
  }

  /**
   * Confirm every draft candidate for `weekId`, applying `edits`, then plan.
   * Confirmed items are appended to the week's items and the draft is cleared
   * in one atomic write, which lands before the planner is called. Edits whose
   * index is out of range are ignored.
   */
  async confirm(
    weekId: string,
    edits: readonly CandidateEdit[] = [],
  ): Promise<IntakeConfirmResult<P>> {
    const { repos, ids, planner } = this.deps;
    const draft = await repos.intakeDraft.get();
    const candidates = draft?.candidates ?? [];
    if (candidates.length === 0) return { ok: false, error: "no-draft" };

    // Drafts saved before counted tasks have no `count`: treat it as 1.
    const counts = candidates.map((c) => {
      const n = Math.floor(Number(c.count));
      return Number.isFinite(n) && n >= 1 ? n : 1;
    });
    // R20.6: the limit applies to the expanded total (also guards stored drafts).
    if (counts.reduce((a, b) => a + b, 0) > MAX_INTAKE_ITEMS) {
      return { ok: false, error: "rejected", reason: "too-many-items" };
    }

    const pending: IntakeItem[] = [];
    const itemEdits: ItemEdit[] = [];
    candidates.forEach((c, index) => {
      const count = counts[index] ?? 1;
      const seriesId = count > 1 ? ids.next() : undefined;
      // Review edits are tied to the draft candidate and apply to its whole series.
      const fields: Partial<CandidateEdit> = {};
      for (const edit of edits) {
        if (edit.index !== index) continue;
        const { index: _index, ...rest } = edit;
        Object.assign(fields, rest);
      }
      // Ignore a blank text edit rather than confirming an empty item.
      if (fields.text !== undefined && fields.text.trim().length === 0) delete fields.text;
      for (let i = 1; i <= count; i++) {
        const item: IntakeItem = {
          id: ids.next(),
          text: c.text,
          durationMin: c.durationMin,
          priority: c.priority,
          category: c.category,
          confirmed: false,
          // Series items never carry a fixed time or day (R28.4).
          weekId: count > 1 ? weekId : targetWeekId(c, weekId),
        };
        if (count === 1) {
          if (c.fixedStart !== undefined) item.fixedStart = c.fixedStart;
          if (c.onDay !== undefined) item.onDay = c.onDay;
        }
        if (c.dueAt !== undefined) item.dueAt = c.dueAt;
        if (c.kind !== undefined) item.kind = c.kind;
        const edit: ItemEdit = { id: item.id, ...fields };
        if (seriesId !== undefined) {
          // A text edit renames the series title; the "(i of n)" suffix is added here.
          const title = (fields.text ?? c.text).trim();
          item.text = `${title} (${i} of ${count})`;
          item.seriesId = seriesId;
          item.seriesIndex = i;
          item.seriesSize = count;
          delete edit.text;
        }
        pending.push(item);
        itemEdits.push(edit);
      }
    });

    const existing = await repos.items.get(weekId);
    let planResult: P | undefined;
    const otherPlans: P[] = [];
    const touched: string[] = [];
    const result = await confirmItems(
      { weekId, edits: itemEdits },
      {
        ids,
        items: {
          readItems: async () => [...existing, ...pending],
          putItems: async (confirmed) => {
            // Every pending item has an edit entry, so all of them are confirmed.
            const done = new Set(confirmed.map((i) => i.id));
            const byWeek = new Map<string, IntakeItem[]>();
            for (const i of confirmed) {
              const w = i.weekId || weekId;
              byWeek.set(w, [...(byWeek.get(w) ?? []), i]);
            }
            const writes: Array<Parameters<Repositories["commit"]>[0][number]> = [];
            // The requested week is always written (it may receive no new items).
            writes.push(
              repos.items.write(weekId, [
                ...existing.filter((i) => !done.has(i.id)),
                ...(byWeek.get(weekId) ?? []),
              ]),
            );
            for (const w of [...byWeek.keys()].filter((k) => k !== weekId).sort()) {
              const prior = await repos.items.get(w);
              writes.push(repos.items.write(w, [...prior.filter((i) => !done.has(i.id)), ...(byWeek.get(w) ?? [])]));
              touched.push(w);
            }
            writes.push(repos.intakeDraft.write(null));
            await repos.commit(writes);
          },
        },
        planning: {
          triggerPlanning: async (id) => {
            planResult = await planner.plan(id);
            for (const w of touched) otherPlans.push(await planner.plan(w));
          },
        },
      },
    );
    const notes: string[] = [];
    for (const c of candidates) {
      for (const n of c.scheduleNotes ?? []) notes.push(`${c.text}: ${n}`);
    }
    return {
      ok: true,
      weekId,
      confirmed: result.confirmed,
      plan: planResult as P,
      ...(otherPlans.length > 0 ? { otherPlans } : {}),
      ...(notes.length > 0 ? { notes } : {}),
    };
  }
}
