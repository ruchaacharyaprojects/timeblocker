/**
 * `BackgroundJobs` over react-native-background-fetch 4.4.2 (D8, R14.3).
 *
 * A periodic Android job (default 30 min from app-core's
 * `BACKGROUND_SYNC_INTERVAL_MIN`) that survives app termination and reboot
 * and runs headless when the app is killed. Every event calls `onSync` and
 * always signals `finish(taskId)`, so the OS keeps scheduling us.
 */
import BackgroundFetch, { type BackgroundFetchConfig, type HeadlessEvent } from 'react-native-background-fetch';
import type { BackgroundJobs } from '@timeblocker/app-core';

/** The work run on each background event (a `"background"` sync). */
export type SyncHandler = () => Promise<void>;

/** Library configuration for the periodic sync job. */
export function backgroundFetchConfig(intervalMin: number): BackgroundFetchConfig {
  return {
    minimumFetchInterval: intervalMin,
    stopOnTerminate: false,
    startOnBoot: true,
    enableHeadless: true,
  };
}

/** Run `onSync`, swallowing its failure, then always finish the task. */
async function runAndFinish(taskId: string, onSync: SyncHandler): Promise<void> {
  try {
    await onSync();
  } catch {
    // A failed sync is recorded by the sync service; the job must still finish.
  } finally {
    BackgroundFetch.finish(taskId);
  }
}

export class BackgroundFetchJobs implements BackgroundJobs {
  constructor(private readonly onSync: SyncHandler) {}

  async startPeriodicSync(intervalMin: number): Promise<void> {
    // `configure` also starts the job; reconfiguring replaces the listener.
    await BackgroundFetch.configure(
      backgroundFetchConfig(intervalMin),
      taskId => {
        void runAndFinish(taskId, this.onSync);
      },
      taskId => BackgroundFetch.finish(taskId),
    );
  }

  async stopPeriodicSync(): Promise<void> {
    await BackgroundFetch.stop();
  }
}

/**
 * The headless task for `BackgroundFetch.registerHeadlessTask` (registered in
 * `index.js`), used when the app has been terminated.
 */
export function createHeadlessSyncTask(onSync: SyncHandler): (event: HeadlessEvent) => Promise<void> {
  return async event => {
    if (event.timeout) {
      BackgroundFetch.finish(event.taskId);
      return;
    }
    await runAndFinish(event.taskId, onSync);
  };
}
