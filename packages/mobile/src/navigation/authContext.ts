/**
 * The auth-state context `RootNavigator` provides to its screens. Kept in its
 * own module so screens can import {@link useAuthState} without importing
 * `RootNavigator` (which imports the screens), avoiding an import cycle.
 */
import { createContext, useContext } from 'react';
import type { AuthState } from '@timeblocker/app-core';

export const AuthStateContext = createContext<AuthState | null>(null);

/** The current auth state, for screens rendered by `RootNavigator`. */
export function useAuthState(): AuthState {
  const state = useContext(AuthStateContext);
  if (!state) throw new Error('useAuthState must be used inside RootNavigator');
  return state;
}
