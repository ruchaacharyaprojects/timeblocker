/**
 * `AiProfileService`: the "About me for applications" text (R34.2, D30).
 *
 * Stored in the `aiProfile` document on the phone only. The text is capped
 * at {@link MAX_AI_BACKGROUND_CHARS}. It is sent to the AI service only
 * inside an application-help request the user starts.
 */
import { MAX_AI_BACKGROUND_CHARS, type AiProfile } from "../models.js";
import type { Clock } from "../ports.js";
import type { Repositories } from "../repositories.js";

export class AiProfileService {
  constructor(
    private readonly repos: Repositories,
    private readonly clock: Clock,
  ) {}

  /** The saved profile, or `null` when none is saved. */
  get(): Promise<AiProfile | null> {
    return this.repos.aiProfile.get();
  }

  /**
   * Save `background` (trimmed, cut to 3,000 characters). Blank text clears
   * the profile instead. Returns what is stored.
   */
  async save(background: string): Promise<AiProfile | null> {
    const text = String(background ?? "").trim().slice(0, MAX_AI_BACKGROUND_CHARS);
    if (text.length === 0) {
      await this.clear();
      return null;
    }
    const profile: AiProfile = { background: text, updatedAt: this.clock.now() };
    await this.repos.aiProfile.save(profile);
    return profile;
  }

  /** Delete the saved background. */
  async clear(): Promise<void> {
    await this.repos.aiProfile.save(null);
  }
}
