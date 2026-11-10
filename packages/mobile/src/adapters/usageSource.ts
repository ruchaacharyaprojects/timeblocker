/**
 * `UsageSource` over the existing UsageMetrics native module (R7.1, R12.9).
 *
 * Uses the `UsageMetricsNativeModule` contract from `@timeblocker/usage-metrics`
 * (implemented by `UsageMetricsModule.kt`). Raw per-app records are returned
 * to on-device aggregation only and never leave the device.
 */
import { NativeModules } from 'react-native';
import type { UsagePermission, UsageSource } from '@timeblocker/app-core';
import {
  getUsageMetricsNative,
  type AppUsageRecord,
  type UsageMetricsNativeModule,
  type UsageWindow,
} from '@timeblocker/usage-metrics';

/** `NativeModules.UsageMetrics` when linked, else the package's resolver (which throws). */
export function resolveUsageMetricsNative(): UsageMetricsNativeModule {
  const linked = (NativeModules as Record<string, unknown>).UsageMetrics as
    | UsageMetricsNativeModule
    | undefined;
  return linked ?? getUsageMetricsNative();
}

export class NativeUsageSource implements UsageSource {
  constructor(
    private readonly resolve: () => UsageMetricsNativeModule = resolveUsageMetricsNative,
  ) {}

  async permission(): Promise<UsagePermission> {
    const status = await this.resolve().getPermissionStatus();
    return status === 'granted' ? 'granted' : 'denied';
  }

  async readUsage(window: UsageWindow): Promise<AppUsageRecord[]> {
    const records = await this.resolve().queryUsage(window);
    return Array.isArray(records) ? records : [];
  }
}
