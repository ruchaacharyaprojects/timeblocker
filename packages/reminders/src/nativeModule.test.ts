import { afterEach, describe, expect, it } from "vitest";
import {
  getTimeBlockerAlarmsNative,
  setTimeBlockerAlarmsNative,
  TIMEBLOCKER_ALARMS_HEADLESS_TASK_KEY,
  type TimeBlockerAlarmsNativeModule,
} from "./index.js";

const fake: TimeBlockerAlarmsNativeModule = {
  schedule: async () => {},
  showNow: async () => {},
  cancel: async () => {},
  listPending: async () => [],
  canScheduleExactAlarms: async () => true,
  notificationPermission: async () => "granted",
};

afterEach(() => {
  setTimeBlockerAlarmsNative(undefined);
  delete (globalThis as { nativeModuleProxy?: unknown }).nativeModuleProxy;
});

describe("TimeBlockerAlarms bridge", () => {
  it("throws when nothing is linked or injected", () => {
    expect(() => getTimeBlockerAlarmsNative()).toThrow(/TimeBlockerAlarms/);
  });

  it("prefers the injected module, then the RN global", () => {
    const linked = { ...fake };
    (globalThis as { nativeModuleProxy?: unknown }).nativeModuleProxy = {
      TimeBlockerAlarms: linked,
    };
    expect(getTimeBlockerAlarmsNative()).toBe(linked);
    setTimeBlockerAlarmsNative(fake);
    expect(getTimeBlockerAlarmsNative()).toBe(fake);
  });

  it("matches the Kotlin headless task key", () => {
    expect(TIMEBLOCKER_ALARMS_HEADLESS_TASK_KEY).toBe("TimeBlockerNotificationAction");
  });
});
