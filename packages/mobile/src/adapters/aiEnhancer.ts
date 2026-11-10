/**
 * Intake enhancer backed by the AI service (R33, D30).
 *
 * Sends ONLY the task titles (up to 40, never anything else) to `parseTasks`
 * and applies the reply to `kind` and, where allowed, `category`:
 * - `kind` is always set from a valid reply;
 * - `category` is replaced only when the built-in source for that line is
 *   `default` and the model proposes a valid category other than `misc`
 *   (R33.4);
 * - title, duration, dates, priority and count are never touched (R33.1).
 * Any failure returns the candidates unchanged (R33.3).
 */
import { CATEGORIES, type IntakeCandidate } from '@timeblocker/flows';
import { AI_MAX_TITLES, type AiPort, type IntakeEnhancer } from '@timeblocker/app-core';

export function createAiEnhancer(ai: AiPort): IntakeEnhancer {
  return async (candidates: IntakeCandidate[]): Promise<IntakeCandidate[]> => {
    try {
      // Only the first 40 lines are sent; the rest stay as parsed.
      const batch = candidates.slice(0, AI_MAX_TITLES);
      if (batch.length === 0) return candidates;
      if ((await ai.availability()) !== 'ready') return candidates;
      const result = await ai.parseTasks(batch.map(c => c.text));
      if (!result.ok || result.value.length !== batch.length) return candidates;
      return candidates.map((c, i) => {
        const item = i < batch.length ? result.value[i] : undefined;
        if (!item) return c;
        const next: IntakeCandidate = { ...c, kind: item.kind };
        if (c.source?.category === 'default' && item.category !== 'misc' && CATEGORIES.includes(item.category)) {
          next.category = item.category;
        }
        return next;
      });
    } catch {
      return candidates;
    }
  };
}
