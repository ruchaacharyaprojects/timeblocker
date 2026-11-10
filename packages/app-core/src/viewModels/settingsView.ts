/**
 * `buildSettingsView`: the pure settings-screen model (R11.11, R11.12, R13.10).
 *
 * - planning mode as a two-option radio group with exactly one selected;
 * - holiday dates (sorted, unique) and distraction apps, each removable;
 * - usage-access and notification permission rows, each "Granted" or
 *   "Not granted" with an "Open settings" action for the matching Android
 *   system screen;
 * - "Reminder timing may vary" while exact alarms are unavailable.
 */
import type { PlanningMode } from "@timeblocker/scheduling-engine";
import type { DeviceSettings } from "../models.js";
import {
  REMINDER_TIMING_MAY_VARY,
  type ExactAlarmState,
} from "../notifications/service.js";
import type { NotificationPermission, SystemSettings, UsagePermission } from "../ports.js";
import { PLANNING_MODES } from "../repositories.js";
import { formatDateKey } from "./format.js";

export const PLANNING_MODE_LABELS: Readonly<Record<PlanningMode, string>> = {
  "earliest-fit": "Earliest free time",
  spread: "Spread across days",
};

export type PermissionId = "usage-access" | "notifications";

export interface PermissionRow {
  id: PermissionId;
  label: string;
  granted: boolean;
  statusLabel: "Granted" | "Not granted";
  action: {
    label: "Open settings";
    /** The {@link SystemSettings} method that opens the matching screen. */
    target: keyof Pick<SystemSettings, "openUsageAccess" | "openNotificationSettings">;
  };
}

export interface SettingsViewInput {
  settings: DeviceSettings;
  usagePermission: UsagePermission;
  notificationPermission: NotificationPermission;
  exactAlarm: ExactAlarmState;
}

export interface SettingsView {
  planningMode: {
    selected: PlanningMode;
    options: Array<{ value: PlanningMode; label: string; selected: boolean }>;
  };
  /** Sorted, unique. */
  holidays: Array<{ date: string; label: string }>;
  distractionApps: Array<{ packageName: string }>;
  permissions: PermissionRow[];
  /** {@link REMINDER_TIMING_MAY_VARY} while reminders are inexact, else null. */
  reminderTimingNote: string | null;
}

function permissionRow(
  id: PermissionId,
  label: string,
  granted: boolean,
  target: PermissionRow["action"]["target"],
): PermissionRow {
  return {
    id,
    label,
    granted,
    statusLabel: granted ? "Granted" : "Not granted",
    action: { label: "Open settings", target },
  };
}

/** Build the settings view. Pure. */
export function buildSettingsView(input: SettingsViewInput): SettingsView {
  const { settings } = input;
  const selected = PLANNING_MODES.includes(settings.planningMode)
    ? settings.planningMode
    : PLANNING_MODES[0]!;
  return {
    planningMode: {
      selected,
      options: PLANNING_MODES.map((value) => ({
        value,
        label: PLANNING_MODE_LABELS[value],
        selected: value === selected,
      })),
    },
    holidays: [...new Set(settings.holidays)].sort().map((date) => ({ date, label: formatDateKey(date) })),
    distractionApps: [...new Set(settings.distractionApps)].map((packageName) => ({ packageName })),
    permissions: [
      permissionRow("usage-access", "Usage access", input.usagePermission === "granted", "openUsageAccess"),
      permissionRow(
        "notifications",
        "Notifications",
        input.notificationPermission === "granted",
        "openNotificationSettings",
      ),
    ],
    reminderTimingNote: input.exactAlarm.reminderTimingMayVary ? REMINDER_TIMING_MAY_VARY : null,
  };
}
