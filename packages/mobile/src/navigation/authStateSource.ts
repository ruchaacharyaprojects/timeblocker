/**
 * The narrow auth-state input of {@link RootNavigator}: read the current
 * state and get told when it changes. Tests pass a fake; the composition root
 * wraps `AuthService.state()` with {@link createAuthStateStore} and calls
 * `refresh()` after `signIn()`, `signOut()`, and `onSessionEnded()`.
 */
import type { AuthState } from '@timeblocker/app-core';

export interface AuthStateSource {
  /** The current persisted state (never contains tokens). */
  current(): Promise<AuthState>;
  /** Called with each new state; returns an unsubscribe function. */
  subscribe(listener: (state: AuthState) => void): () => void;
}

export interface AuthStateStore extends AuthStateSource {
  /** Re-read the state and notify subscribers. Resolves with the new state. */
  refresh(): Promise<AuthState>;
}

/**
 * Wrap a state reader (e.g. `() => authService.state()`) as an
 * {@link AuthStateStore}. `refresh()` always notifies, so a repeated
 * `session-ended` still reaches the UI.
 */
export function createAuthStateStore(read: () => Promise<AuthState>): AuthStateStore {
  const listeners = new Set<(state: AuthState) => void>();
  return {
    current: read,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    async refresh() {
      const state = await read();
      for (const listener of [...listeners]) listener(state);
      return state;
    },
  };
}
