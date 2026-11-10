/**
 * Root component: the composed services in context, the auth-gated
 * navigator, and the lifecycle hooks (task 25.1; R14.1).
 *
 * - On mount: `lifecycle.onLaunch()` (auth gate, permission once, background
 *   job, launch sync, reconcile).
 * - Each time `AppState` becomes `active` again: `lifecycle.onForeground()`
 *   (foreground sync, exact-alarm refresh).
 * - After either, the auth state is re-read so a session that ended during
 *   the sync sends the navigator back to SignIn.
 */
import React, { useEffect } from 'react';
import { AppState } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { getAppRuntime, type AppRuntime } from './bootstrap';
import { RootNavigator } from './navigation/RootNavigator';
import { AppServicesProvider } from './services/AppServices';
import { ThemeProvider } from './theme';

/** The parts of the runtime the root component uses. */
export type AppRootRuntime = {
  services: AppRuntime['services'];
  lifecycle: Pick<AppRuntime['lifecycle'], 'onLaunch' | 'onForeground'>;
};

export interface AppProps {
  /** Defaults to the process-wide runtime (tests inject one). */
  runtime?: AppRootRuntime;
}

/** Run a lifecycle step, then re-read the auth state. Never rejects. */
async function runStep(runtime: AppRootRuntime, step: () => Promise<unknown>): Promise<void> {
  try {
    await step();
  } catch {
    // Lifecycle steps record their own failures; the UI keeps working.
  }
  await runtime.services.authState.refresh().catch(() => undefined);
}

export function useAppLifecycle(runtime: AppRootRuntime): void {
  useEffect(() => {
    let previous: string | null | undefined = AppState.currentState;
    void runStep(runtime, () => runtime.lifecycle.onLaunch());
    const subscription = AppState.addEventListener('change', (next) => {
      // Only a transition into `active` is a foreground (R14.1).
      if (next === 'active' && previous !== 'active') {
        void runStep(runtime, () => runtime.lifecycle.onForeground());
      }
      previous = next;
    });
    return () => subscription.remove();
  }, [runtime]);
}

export default function App({ runtime }: AppProps): React.JSX.Element {
  const resolved = runtime ?? getAppRuntime();
  useAppLifecycle(resolved);
  return (
    <SafeAreaProvider>
      <AppServicesProvider services={resolved.services}>
        <ThemeProvider>
          <RootNavigator authState={resolved.services.authState} />
        </ThemeProvider>
      </AppServicesProvider>
    </SafeAreaProvider>
  );
}
