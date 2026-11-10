/**
 * The "Will you miss this block?" actionable-prompt surface (R6.1).
 *
 * Moved from `packages/infra/lambda/reschedule/prompt.ts` into
 * `@timeblocker/flows`. The decision/flow logic lives in `reschedule.ts`; this
 * module defines the prompt payload, the stable Yes/No action ids, and the
 * mapping from a tap to a {@link RescheduleRequest}.
 *
 * Unlike the infra original, there is no `globalThis.nativeModuleProxy`
 * lookup here: flows stays free of React Native. A host injects an
 * implementation with {@link setMissPromptNative}; the device uses its
 * `Notifier` port instead.
 *
 * Routing: the reminders "Move it" action (R5.2) and a "Yes" tap on this
 * prompt both resolve to the {@link RescheduleRequest} that `runReschedule`
 * consumes. Meeting-conflict detection and the Saturday review raise the same
 * prompt, so this surface is shared by all three.
 */

import type { PromptAnswer, RescheduleRequest } from "./reschedule.js";

/**
 * The two actionable buttons the "Will you miss this block?" prompt carries
 * (R6.1). Stable ids are what the Android handler maps its tap callbacks to;
 * the labels are what the user sees.
 */
export type PromptActionId = "yes" | "no";

export interface PromptAction {
  id: PromptActionId;
  label: string;
}

/** The fixed, ordered Yes/No actions of the prompt (R6.1). */
export const PROMPT_ACTIONS: readonly PromptAction[] = [
  { id: "yes", label: "Yes" },
  { id: "no", label: "No" },
] as const;

/** Why the prompt is being raised — a calendar overlap or a usage signal (R6.1). */
export type PromptTrigger = "meeting-overlap" | "usage-signal" | "move-it";

/** The payload the native side needs to render the Yes/No prompt. */
export interface NativeMissPrompt {
  /** Stable id, e.g. `miss:<blockId>`. */
  id: string;
  blockId: string;
  weekId: string;
  title: string;
  body: string;
  trigger: PromptTrigger;
  actions: readonly PromptAction[];
}

/** The event emitted to JS when the user taps Yes or No. */
export interface PromptAnswerEvent {
  promptId: string;
  blockId: string;
  weekId: string;
  answer: PromptAnswer;
}

/** Unsubscribe handle returned by {@link MissPromptNativeModule.addAnswerListener}. */
export interface PromptSubscription {
  remove(): void;
}

/**
 * The methods a native prompt surface exposes to JS for the Yes/No prompt.
 * Presenting and cancelling are async because they cross the native bridge;
 * the answer listener is a synchronous subscribe that returns an unsubscribe
 * handle.
 */
export interface MissPromptNativeModule {
  /** Render the "Will you miss this block?" prompt with Yes/No (R6.1). */
  presentPrompt(prompt: NativeMissPrompt): Promise<void>;
  /** Cancel a previously-presented prompt by id. */
  cancelPrompt(promptId: string): Promise<void>;
  /** Subscribe to Yes/No taps. */
  addAnswerListener(
    listener: (event: PromptAnswerEvent) => void,
  ): PromptSubscription;
}

/**
 * Build the native prompt payload for a block (R6.1). Shared by the
 * meeting-conflict watcher and the Saturday review.
 */
export function buildMissPrompt(args: {
  blockId: string;
  weekId: string;
  title: string;
  trigger: PromptTrigger;
}): NativeMissPrompt {
  return {
    id: `miss:${args.blockId}`,
    blockId: args.blockId,
    weekId: args.weekId,
    title: "Will you miss this block?",
    body: args.title,
    trigger: args.trigger,
    actions: PROMPT_ACTIONS,
  };
}

/**
 * Map a prompt answer event (or a reminders "Move it" tap) to the request
 * `runReschedule` consumes. A "Move it" tap is equivalent to answering "yes".
 */
export function toRescheduleRequest(
  event: PromptAnswerEvent,
  now?: string,
): RescheduleRequest {
  return {
    blockId: event.blockId,
    weekId: event.weekId,
    answer: event.answer,
    now,
  };
}

let injected: MissPromptNativeModule | undefined;

/** Inject a native-module implementation (tests, or a custom host). */
export function setMissPromptNative(
  mod: MissPromptNativeModule | undefined,
): void {
  injected = mod;
}

/**
 * Get the injected native module. Throws when none was injected so a missing
 * implementation surfaces loudly rather than silently no-opping.
 */
export function getMissPromptNative(): MissPromptNativeModule {
  if (injected) return injected;
  throw new Error(
    "MissPrompt native module is unavailable. Inject one via " +
      "setMissPromptNative() (flows does not look up React Native modules).",
  );
}
