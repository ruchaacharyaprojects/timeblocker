/**
 * `IdGenerator` and the per-process runtime id (R14.8, sync lease owners).
 *
 * Hermes has no `crypto.getRandomValues` without a polyfill, and these ids
 * are not secrets, so `Math.random` plus the clock and a counter is enough:
 * the counter makes ids unique within a runtime, and time + randomness make
 * them unique across runtimes (UI process restarts, headless tasks).
 */
import { BASE32HEX_ALPHABET, type IdGenerator } from '@timeblocker/app-core';

/** Length of generated Calendar event ids (Google accepts 5-1024 base32hex chars). */
export const CALENDAR_EVENT_ID_LENGTH = 26;

/** `length` random characters from `alphabet`. */
function randomChars(alphabet: string, length: number, random: () => number): string {
  let out = '';
  for (let i = 0; i < length; i += 1) {
    out += alphabet.charAt(Math.floor(random() * alphabet.length) % alphabet.length);
  }
  return out;
}

const BASE36 = '0123456789abcdefghijklmnopqrstuvwxyz';

export class RandomIdGenerator implements IdGenerator {
  private counter = 0;

  constructor(
    private readonly now: () => number = Date.now,
    private readonly random: () => number = Math.random,
  ) {}

  /** `<time36>-<counter36>-<random>`, unique within and across runtimes. */
  next(): string {
    this.counter += 1;
    return `${this.now().toString(36)}-${this.counter.toString(36)}-${randomChars(BASE36, 8, this.random)}`;
  }

  /** A base32hex id: the counter (for in-runtime uniqueness) then random characters. */
  calendarEventId(): string {
    this.counter += 1;
    const prefix = this.counter.toString(32);
    return prefix + randomChars(BASE32HEX_ALPHABET, CALENDAR_EVENT_ID_LENGTH - prefix.length, this.random);
  }
}

/** A random id for this JS runtime; sync lease owners are `<runtimeId>#<run>`. */
export function createRuntimeId(now: () => number = Date.now, random: () => number = Math.random): string {
  return `rt-${now().toString(36)}-${randomChars(BASE36, 10, random)}`;
}
