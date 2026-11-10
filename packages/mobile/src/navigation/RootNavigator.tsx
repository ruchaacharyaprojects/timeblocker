/**
 * `RootNavigator`: the auth-gated conditional stack (design D9, "Navigation
 * and screens"; R11.2, R12.5, R14.12).
 *
 * Contract (stable for tasks 24.2-24.8 and the composition root, 25.1):
 *
 * - Props: `authState` (an {@link AuthStateSource}), optional `screens`
 *   (overrides per route, merged over `DEFAULT_SCREENS`), optional `linking`
 *   (defaults to {@link LINKING}; tests override `getInitialURL`).
 * - Until the first auth state is read, nothing is rendered.
 * - `signed-out` and `session-ended` render only `SignIn`. `signed-in`
 *   renders only the app routes, with `Dashboard` first. Switching state
 *   swaps the route set, so a session end returns to SignIn and drops the
 *   app stack (local data is untouched; that is AuthService's job).
 * - Screens read the current {@link AuthState} with {@link useAuthState}
 *   (SignIn uses `status === 'session-ended'` to show the session-ended
 *   message, R12.5).
 * - A deep link opened while signed out is kept and applied once the user
 *   signs in (`UNSTABLE_routeNamesChangeBehavior="lastUnhandled"`).
 */
import React, { useEffect, useMemo, useState } from 'react';
import { NavigationContainer, type LinkingOptions, DefaultTheme, type Theme as NavTheme } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import type { AuthState } from '@timeblocker/app-core';
import { AuthStateContext } from './authContext';
import type { AuthStateSource } from './authStateSource';
import { useTheme, type Theme } from '../theme';
import { LINKING } from './linking';
import { DEFAULT_SCREENS } from './screens';
import { ROUTE_TITLES, type RootScreenMap, type RootStackParamList } from './types';

// Screens import `useAuthState` from './authContext' directly: importing it
// from here would cycle through the screens map. Re-exported for callers.
export { useAuthState } from './authContext';

const Stack = createNativeStackNavigator<RootStackParamList>();

/**
 * Subscribe to `source` and read its current state. A pushed update that
 * arrives before the initial read resolves wins over that read.
 */
export function useAuthStateFrom(source: AuthStateSource): AuthState | null {
  const [state, setState] = useState<AuthState | null>(null);
  useEffect(() => {
    let active = true;
    let pushed = false;
    const unsubscribe = source.subscribe((next) => {
      pushed = true;
      if (active) setState(next);
    });
    source.current().then(
      (initial) => {
        if (active && !pushed) setState(initial);
      },
      () => {
        // Unreadable state: treat as signed out so only SignIn shows (R11.2).
        if (active && !pushed) setState({ status: 'signed-out' });
      },
    );
    return () => {
      active = false;
      unsubscribe();
    };
  }, [source]);
  return state;
}

/** Map theme tokens onto the navigation theme so transitions never flash white (R26). */
export function toNavigationTheme(theme: Theme, dark: boolean): NavTheme {
  return {
    dark,
    colors: {
      primary: theme.outline,
      background: theme.background,
      card: theme.background,
      text: theme.text,
      border: theme.border,
      notification: theme.danger,
    },
    fonts: DefaultTheme.fonts,
  };
}
export interface RootNavigatorProps {
  authState: AuthStateSource;
  screens?: Partial<RootScreenMap>;
  linking?: LinkingOptions<RootStackParamList>;
}

export function RootNavigator({
  authState,
  screens: overrides,
  linking = LINKING,
}: RootNavigatorProps): React.JSX.Element | null {
  const state = useAuthStateFrom(authState);
  const { theme, resolved } = useTheme();
  const navTheme = useMemo(() => toNavigationTheme(theme, resolved === 'dark'), [theme, resolved]);
  const screens = useMemo<RootScreenMap>(() => ({ ...DEFAULT_SCREENS, ...overrides }), [overrides]);
  if (!state) return null;
  const signedIn = state.status === 'signed-in';

  return (
    <AuthStateContext.Provider value={state}>
      <NavigationContainer linking={linking} theme={navTheme}>
        <Stack.Navigator
          UNSTABLE_routeNamesChangeBehavior="lastUnhandled"
          screenOptions={{
            headerStyle: { backgroundColor: theme.background },
            headerTintColor: theme.text,
            headerTitleStyle: { color: theme.text },
            contentStyle: { backgroundColor: theme.background },
          }}
        >
          {signedIn ? (
            <Stack.Group>
              <Stack.Screen name="Dashboard" component={screens.Dashboard} options={{ title: ROUTE_TITLES.Dashboard, headerShown: false }} />
              <Stack.Screen name="WeekView" component={screens.WeekView} options={{ title: ROUTE_TITLES.WeekView }} />
              <Stack.Screen name="Intake" component={screens.Intake} options={{ title: ROUTE_TITLES.Intake }} />
              <Stack.Screen name="BlockDetail" component={screens.BlockDetail} options={{ title: ROUTE_TITLES.BlockDetail }} />
              <Stack.Screen
                name="ApplicationHelper"
                component={screens.ApplicationHelper}
                options={{ title: ROUTE_TITLES.ApplicationHelper }}
              />
              <Stack.Screen name="NothingFits" component={screens.NothingFits} options={{ title: ROUTE_TITLES.NothingFits }} />
              <Stack.Screen name="PlanSummary" component={screens.PlanSummary} options={{ title: ROUTE_TITLES.PlanSummary }} />
              <Stack.Screen
                name="SaturdayReview"
                component={screens.SaturdayReview}
                options={{ title: ROUTE_TITLES.SaturdayReview }}
              />
              <Stack.Screen name="Settings" component={screens.Settings} options={{ title: ROUTE_TITLES.Settings }} />
            </Stack.Group>
          ) : (
            <Stack.Screen name="SignIn" component={screens.SignIn} options={{ headerShown: false }} />
          )}
        </Stack.Navigator>
      </NavigationContainer>
    </AuthStateContext.Provider>
  );
}
