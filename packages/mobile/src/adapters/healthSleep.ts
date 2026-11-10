/**
 * `SleepSource` over the HealthSleep native module (R25): sleep sessions that
 * Samsung Health writes into Android Health Connect. Read-only; nothing leaves
 * the device (R25.6). Also `HealthDemoWriter`, the debug-only demo-data helper
 * (release builds reject with DEMO_UNAVAILABLE).
 */
import { NativeModules } from 'react-native';
import type {
  SleepAvailability,
  SleepPermission,
  SleepSession,
  SleepSource,
} from '@timeblocker/app-core';
import type { UsageWindow } from '@timeblocker/usage-metrics';

/** Contract implemented by `HealthSleepModule.kt`. */
export interface HealthSleepNativeModule {
  availability(): Promise<string>;
  permission(): Promise<string>;
  requestPermission(): Promise<string>;
  readSessions(window: UsageWindow): Promise<unknown>;
  requestDemoWritePermission?(): Promise<string>;
  writeDemoSessions?(sessions: DemoSleepInput[]): Promise<number>;
  deleteDemoSessions?(): Promise<number>;
}

export interface DemoSleepInput {
  startMs: number;
  endMs: number;
  awakeMin: number;
}

export const DEMO_UNAVAILABLE = 'DEMO_UNAVAILABLE';

/** `NativeModules.HealthSleep` when linked, else undefined. */
export function resolveHealthSleepNative(): HealthSleepNativeModule | undefined {
  return (NativeModules as Record<string, unknown>).HealthSleep as
    | HealthSleepNativeModule
    | undefined;
}

const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);

export class HealthConnectSleepSource implements SleepSource {
  constructor(
    private readonly resolve: () => HealthSleepNativeModule | undefined = resolveHealthSleepNative,
  ) {}

  async availability(): Promise<SleepAvailability> {
    const mod = this.resolve();
    if (!mod) return 'unsupported';
    try {
      const v = await mod.availability();
      return v === 'available' || v === 'needs-install' ? v : 'unsupported';
    } catch {
      return 'unsupported';
    }
  }

  async permission(): Promise<SleepPermission> {
    const mod = this.resolve();
    if (!mod) return 'denied';
    try {
      return (await mod.permission()) === 'granted' ? 'granted' : 'denied';
    } catch {
      return 'denied';
    }
  }

  async requestPermission(): Promise<SleepPermission> {
    const mod = this.resolve();
    if (!mod) return 'denied';
    try {
      return (await mod.requestPermission()) === 'granted' ? 'granted' : 'denied';
    } catch {
      return 'denied';
    }
  }

  async readSessions(window: UsageWindow): Promise<SleepSession[]> {
    const mod = this.resolve();
    if (!mod) return [];
    let raw: unknown;
    try {
      raw = await mod.readSessions(window);
    } catch {
      return [];
    }
    if (!Array.isArray(raw)) return [];
    const out: SleepSession[] = [];
    for (const item of raw) {
      if (typeof item !== 'object' || item === null) continue;
      const { startMs, endMs, asleepMin } = item as Record<string, unknown>;
      if (!finite(startMs) || !finite(endMs) || !finite(asleepMin)) continue;
      if (endMs <= startMs || asleepMin < 0) continue;
      out.push({ startMs, endMs, asleepMin });
    }
    return out.sort((a, b) => a.startMs - b.startMs);
  }
}

/** Debug-only: writes/removes demo sleep sessions in Health Connect (R25.5). */
export class HealthDemoWriter {
  constructor(
    private readonly resolve: () => HealthSleepNativeModule | undefined = resolveHealthSleepNative,
  ) {}

  /**
   * Requests write permission when needed, then writes the sessions. Resolves
   * the number written, or `false` when unavailable (release build, missing
   * module) or the permission was not granted.
   */
  async writeDemoSessions(sessions: readonly DemoSleepInput[]): Promise<number | false> {
    const mod = this.resolve();
    if (!mod?.writeDemoSessions || !mod.requestDemoWritePermission) return false;
    try {
      if ((await mod.requestDemoWritePermission()) !== 'granted') return false;
      return await mod.writeDemoSessions(sessions.map(s => ({ ...s })));
    } catch (e) {
      if (isCode(e, DEMO_UNAVAILABLE) || isCode(e, 'PERMISSION_DENIED')) return false;
      throw e;
    }
  }

  /** Resolves the number of demo sessions removed, or `false` when unavailable. */
  async deleteDemoSessions(): Promise<number | false> {
    const mod = this.resolve();
    if (!mod?.deleteDemoSessions) return false;
    try {
      return await mod.deleteDemoSessions();
    } catch (e) {
      if (isCode(e, DEMO_UNAVAILABLE) || isCode(e, 'PERMISSION_DENIED')) return false;
      throw e;
    }
  }
}

function isCode(e: unknown, code: string): boolean {
  return typeof e === 'object' && e !== null && (e as { code?: unknown }).code === code;
}
