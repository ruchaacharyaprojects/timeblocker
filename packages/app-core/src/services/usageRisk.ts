/**
 * `UsageRiskService`: the usage-signal "Will you miss this block?" prompt
 * (design: "Sync algorithm" step 7; R6.1, R7.1, R7.3, R12.9).
 *
 * Called from the sync completion step. One pass:
 * 1. find `scheduled` blocks with `now < start ≤ now + 30 min` that were not
 *    usage-prompted yet and have no open prompt (current and next week, so a
 *    block just after the Saturday/Sunday boundary is covered);
 * 2. if the usage permission is denied, stop: no usage is read, no prompt is
 *    raised, and the caller's sync simply continues;
 * 3. read on-device usage once for the recent lookback window
 *    (`[now - lookback, now)`) and compute `missRiskSignal` per block against
 *    the distraction list in settings;
 * 4. for each at-risk block, persist `usagePrompted = true` and the
 *    `openPrompts` / `notifRegistry` entries first (at-most-once even if the
 *    process dies mid-way), then show the same `miss:<blockId>` Yes/No prompt
 *    the meeting-conflict path uses.
 *
 * Raw usage records stay inside this function: they are never persisted,
 * returned, or sent anywhere (R7.3, R12.9). The result carries only block ids.
 * The pass never throws for a usage or notification failure, so sync keeps
 * going.
 */
import { buildMissPrompt } from "@timeblocker/flows";
import {
  DEFAULT_MISS_RISK_LOOKBACK_MS,
  effectiveDistractionApps,
  missRiskSignal,
  type AppUsageRecordWithWindow,
  type UsageWindow,
} from "@timeblocker/usage-metrics";
import type { DeviceBlock, OpenPrompt, RegistryEntry } from "../models.js";
import type { Clock, NotificationPayload, Notifier, UsageSource } from "../ports.js";
import type { DocWrite, Repositories } from "../repositories.js";
import { weekIdAt } from "../notifications/service.js";

/** Blocks starting within this horizon are checked for usage risk. */
export const USAGE_RISK_HORIZON_MS = 30 * 60_000;

/** How a pass ended; every status other than `evaluated` raised no prompt. */
export type UsageRiskStatus =
  /** Usage was evaluated (possibly with no block at risk). */
  | "evaluated"
  /** No block qualified, so usage was not read. */
  | "no-candidates"
  /** The usage-access permission is denied: no usage prompts (R7.1). */
  | "permission-denied"
  /** Reading usage failed; no prompts this pass, sync continues. */
  | "usage-error";

/** What one pass did. Contains block ids only, never usage data (R7.3). */
export interface UsageRiskResult {
  status: UsageRiskStatus;
  /** Blocks that qualified for a check, in start order. */
  candidates: string[];
  /** Blocks a usage prompt was raised for. */
  prompted: string[];
  /** Prompts whose `showNow` failed (state was already persisted). */
  failed: Array<{ blockId: string; error: string }>;
}

export interface UsageRiskServiceDeps {
  repos: Repositories;
  usage: UsageSource;
  notifier: Notifier;
  clock: Clock;
}

export interface UsageRiskOptions {
  /** How far back usage is read. Defaults to usage-metrics' 10 minutes. */
  lookbackMs?: number;
  /** Distraction minutes in the lookback that count as at risk. Defaults to usage-metrics' 5. */
  thresholdMin?: number;
}

/** The notification payload for a usage-triggered miss prompt (R6.1). */
export function usageMissPromptPayload(block: DeviceBlock): NotificationPayload {
  const prompt = buildMissPrompt({
    blockId: block.id,
    weekId: block.weekId,
    title: block.title,
    trigger: "usage-signal",
  });
  return {
    id: prompt.id,
    kind: "miss-prompt",
    channel: "prompts",
    title: prompt.title,
    body: prompt.body,
    actions: prompt.actions.map((a) => ({ id: a.id, label: a.label })),
    sourceId: block.id,
    weekId: block.weekId,
    deepLink: `timeblocker://block/${block.id}`,
  };
}

/**
 * Blocks eligible for a usage check at `now`: `scheduled`, not yet
 * usage-prompted, no open prompt, and `now < start ≤ now + 30 min`. Sorted by
 * start then id. Pure.
 */
export function usageRiskCandidates(
  blocks: readonly DeviceBlock[],
  openPromptBlockIds: ReadonlySet<string>,
  now: number,
): DeviceBlock[] {
  return blocks
    .filter((b) => {
      if (b.status !== "scheduled" || b.usagePrompted || openPromptBlockIds.has(b.id)) {
        return false;
      }
      const start = Date.parse(b.start);
      return Number.isFinite(start) && start > now && start <= now + USAGE_RISK_HORIZON_MS;
    })
    .sort((a, b) => Date.parse(a.start) - Date.parse(b.start) || a.id.localeCompare(b.id));
}

const errorMessage = (e: unknown) => (e instanceof Error ? e.message : String(e));

export class UsageRiskService {
  private readonly lookbackMs: number;
  private readonly thresholdMin: number | undefined;

  constructor(
    private readonly deps: UsageRiskServiceDeps,
    options: UsageRiskOptions = {},
  ) {
    this.lookbackMs = options.lookbackMs ?? DEFAULT_MISS_RISK_LOOKBACK_MS;
    this.thresholdMin = options.thresholdMin;
  }

  /** Run one usage-risk pass (sync step 7). Never throws for usage or notifier failures. */
  async checkUpcoming(): Promise<UsageRiskResult> {
    const { repos, usage, notifier, clock } = this.deps;
    const now = clock.now();
    const result: UsageRiskResult = { status: "evaluated", candidates: [], prompted: [], failed: [] };

    const weekIds = [...new Set([weekIdAt(now), weekIdAt(now + USAGE_RISK_HORIZON_MS)])];
    const blocksByWeek = new Map<string, DeviceBlock[]>();
    for (const weekId of weekIds) blocksByWeek.set(weekId, await repos.blocks.get(weekId));

    const openPrompts = await repos.openPrompts.get();
    const openIds = new Set(openPrompts.map((p) => p.blockId));
    const candidates = usageRiskCandidates([...blocksByWeek.values()].flat(), openIds, now);
    result.candidates = candidates.map((b) => b.id);
    if (candidates.length === 0) return { ...result, status: "no-candidates" };

    const distractionApps = effectiveDistractionApps((await repos.settings.get()).distractionApps);

    if ((await usage.permission()) !== "granted") {
      return { ...result, status: "permission-denied" };
    }

    // Raw usage: read once, used only for the signal below, then dropped.
    const window: UsageWindow = { startMs: now - this.lookbackMs, endMs: now };
    let records: AppUsageRecordWithWindow[];
    try {
      records = (await usage.readUsage(window)).map((r) => ({ ...r, ...window }));
    } catch {
      return { ...result, status: "usage-error" };
    }

    const atRisk = candidates.filter((b) => {
      const startMs = Date.parse(b.start);
      // Look back from the block's start far enough to cover the read window,
      // so the signal is the recent distraction time just before the block.
      const signal = missRiskSignal(records, distractionApps, startMs, {
        lookbackMs: startMs - window.startMs,
        thresholdMin: this.thresholdMin,
      });
      return signal.atRisk;
    });
    if (atRisk.length === 0) return result;

    // Persist first: usagePrompted, openPrompts, registry (one atomic commit).
    const atRiskIds = new Set(atRisk.map((b) => b.id));
    const writes: DocWrite[] = [];
    for (const [weekId, blocks] of blocksByWeek) {
      if (!blocks.some((b) => atRiskIds.has(b.id))) continue;
      writes.push(
        repos.blocks.write(
          weekId,
          blocks.map((b) => (atRiskIds.has(b.id) ? { ...b, usagePrompted: true, updatedAt: now } : b)),
        ),
      );
    }
    const payloads = atRisk.map((b) => ({ block: b, payload: usageMissPromptPayload(b) }));
    const newPrompts: OpenPrompt[] = payloads.map(({ block, payload }) => ({
      promptId: payload.id,
      blockId: block.id,
      meetingIds: [],
      shownAt: now,
    }));
    writes.push(repos.openPrompts.write([...openPrompts, ...newPrompts]));

    const registry = await repos.notifRegistry.get();
    const newIds = new Set(payloads.map((p) => p.payload.id));
    const entries: RegistryEntry[] = payloads.map(({ block, payload }) => ({
      id: payload.id,
      kind: "miss-prompt",
      sourceId: block.id,
      startMs: Date.parse(block.start),
      fireAtMs: now,
      exact: false,
      state: "shown",
    }));
    writes.push(repos.notifRegistry.write([...registry.filter((e) => !newIds.has(e.id)), ...entries]));
    await repos.commit(writes);

    for (const { block, payload } of payloads) {
      try {
        await notifier.showNow(payload);
        result.prompted.push(block.id);
      } catch (error) {
        result.failed.push({ blockId: block.id, error: errorMessage(error) });
      }
    }
    return result;
  }
}
