/**
 * `SettingsService`: the settings screen's mutations (R11.11, R7.2, R12.7).
 *
 * - exactly one planning mode (`earliest-fit` or `spread`);
 * - the appearance (`themeMode`, R26.2); "spread" is the planning default
 *   until the user picks a mode (R30.1). Holidays come from the holiday
 *   service, not from settings (R30.2);
 * - the distraction app list, edited only through usage-metrics'
 *   `addDistractionApp` / `removeDistractionApp` (normalized, de-duplicated).
 *
 * Every accepted change is persisted to the device store immediately, so it
 * is still shown after the app is closed and reopened. A rejected or no-op
 * request writes nothing.
 */
import type { PlanningMode } from "@timeblocker/scheduling-engine";
import {
  addDistractionApp,
  normalizePackageName,
  removeDistractionApp,
} from "@timeblocker/usage-metrics";
import type { DeviceSettings, ThemeMode } from "../models.js";
import { PLANNING_MODES, type Repositories } from "../repositories.js";

/** Why a settings change was rejected. */
export type SettingsError =
  | "invalid-planning-mode"
  | "invalid-theme-mode"
  | "invalid-app"
  | "invalid-ai-enabled";

/**
 * Outcome of a settings change. `changed` is false when the request was valid
 * but left settings as they were (e.g. adding a duplicate), in which case
 * nothing was written.
 */
export type SettingsResult =
  | { ok: true; changed: boolean; settings: DeviceSettings }
  | { ok: false; error: SettingsError; settings: DeviceSettings };

const THEME_MODES: readonly ThemeMode[] = ["system", "light", "dark"];

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Whether `value` is a strict `YYYY-MM-DD` string naming a real calendar date. */
export function isIsoDate(value: string): boolean {
  const match = ISO_DATE.exec(value);
  if (!match) return false;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  if (month < 1 || month > 12 || day < 1) return false;
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return day <= daysInMonth;
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

export class SettingsService {
  constructor(private readonly repos: Repositories) {}

  /** Current settings (defaults when nothing is stored). */
  async get(): Promise<DeviceSettings> {
    const stored = await this.repos.settings.get();
    // R30.1: "spread" unless the user picked a mode themselves.
    return stored.planningModeSetByUser === true ? stored : { ...stored, planningMode: "spread" };
  }

  /** Select exactly one planning mode. */
  async setPlanningMode(mode: PlanningMode): Promise<SettingsResult> {
    const current = await this.get();
    if (!PLANNING_MODES.includes(mode)) {
      return { ok: false, error: "invalid-planning-mode", settings: current };
    }
    return this.apply(current, { ...current, planningMode: mode, planningModeSetByUser: true });
  }

  /** Choose the appearance (R26.2). */
  async setThemeMode(mode: ThemeMode): Promise<SettingsResult> {
    const current = await this.get();
    if (!THEME_MODES.includes(mode)) {
      return { ok: false, error: "invalid-theme-mode", settings: current };
    }
    return this.apply(current, { ...current, themeMode: mode });
  }

  /** Switch the AI assistant on or off (R35.1); off by default. */
  async setAiEnabled(enabled: boolean): Promise<SettingsResult> {
    const current = await this.get();
    if (typeof enabled !== "boolean") {
      return { ok: false, error: "invalid-ai-enabled", settings: current };
    }
    return this.apply(current, { ...current, aiEnabled: enabled });
  }

  /** Add an Android package to the distraction list. A duplicate is a no-op. */
  async addDistractionApp(pkg: string): Promise<SettingsResult> {
    const current = await this.get();
    if (normalizePackageName(pkg).length === 0) {
      return { ok: false, error: "invalid-app", settings: current };
    }
    const distractionApps = addDistractionApp(current.distractionApps, pkg);
    return this.apply(current, { ...current, distractionApps });
  }

  /** Remove an Android package from the distraction list. */
  async removeDistractionApp(pkg: string): Promise<SettingsResult> {
    const current = await this.get();
    if (normalizePackageName(pkg).length === 0) {
      return { ok: false, error: "invalid-app", settings: current };
    }
    const distractionApps = removeDistractionApp(current.distractionApps, pkg);
    return this.apply(current, { ...current, distractionApps });
  }

  /** Persist `next` immediately unless it equals `current`. */
  private async apply(
    current: DeviceSettings,
    next: DeviceSettings,
  ): Promise<SettingsResult> {
    const changed =
      current.planningMode !== next.planningMode ||
      current.themeMode !== next.themeMode ||
      current.planningModeSetByUser !== next.planningModeSetByUser ||
      (current.aiEnabled === true) !== (next.aiEnabled === true) ||
      !sameList(current.holidays, next.holidays) ||
      !sameList(current.distractionApps, next.distractionApps);
    if (changed) await this.repos.settings.save(next);
    return { ok: true, changed, settings: changed ? next : current };
  }
}
