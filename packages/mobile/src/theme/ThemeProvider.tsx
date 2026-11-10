/**
 * Theme provider (design D22; R26.2).
 *
 * Reads `themeMode` from the settings service (`system` when missing), follows
 * the phone's color scheme for `system`, renders the matching status bar, and
 * persists a change through `settings.setThemeMode`. If the settings service
 * fails, the light theme is used. Outside a provider `useTheme()` returns the
 * light theme, so screens and their tests work without one.
 *
 * Screens build styles with `useThemedStyles((theme) => ({ ... }))`.
 */
import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { StatusBar, StyleSheet, useColorScheme, type ImageStyle, type TextStyle, type ViewStyle } from 'react-native';
import type { ThemeMode } from '@timeblocker/app-core';
import { useAppServices } from '../services/AppServices';
import { darkTheme, lightTheme, type Theme } from './tokens';

export interface ThemeContextValue {
  theme: Theme;
  /** The user's choice. */
  mode: ThemeMode;
  /** What is actually shown. */
  resolved: 'light' | 'dark';
  /** The status bar style matching `resolved`. */
  statusBarStyle: 'light-content' | 'dark-content';
  /** Apply immediately and save. */
  setMode(mode: ThemeMode): void;
}

const DEFAULT_VALUE: ThemeContextValue = {
  theme: lightTheme,
  mode: 'system',
  resolved: 'light',
  statusBarStyle: 'dark-content',
  setMode: () => {},
};

const ThemeContext = createContext<ThemeContextValue>(DEFAULT_VALUE);

/** Resolve a mode against the phone's scheme. Exported for tests. */
export function resolveTheme(mode: ThemeMode, scheme: string | null | undefined): 'light' | 'dark' {
  if (mode === 'light' || mode === 'dark') return mode;
  return scheme === 'dark' ? 'dark' : 'light';
}

export function ThemeProvider({ children }: { children?: React.ReactNode }): React.JSX.Element {
  const { settings } = useAppServices();
  const scheme = useColorScheme();
  const [mode, setModeState] = useState<ThemeMode>('system');
  const [failed, setFailed] = useState(false);
  const mounted = useRef(true);
  /** Set once the user picks a mode so a slower initial read cannot overwrite it. */
  const touched = useRef(false);

  useEffect(() => {
    mounted.current = true;
    settings
      .get()
      .then((s) => {
        if (mounted.current && !touched.current) setModeState(s.themeMode ?? 'system');
      })
      .catch(() => {
        if (mounted.current) setFailed(true);
      });
    return () => {
      mounted.current = false;
    };
  }, [settings]);

  const setMode = useCallback(
    (next: ThemeMode) => {
      touched.current = true;
      setModeState(next);
      setFailed(false);
      settings.setThemeMode(next).catch(() => {
        // The choice still applies for this session.
      });
    },
    [settings],
  );

  const value = useMemo<ThemeContextValue>(() => {
    const resolved = failed ? 'light' : resolveTheme(mode, scheme);
    return {
      theme: resolved === 'dark' ? darkTheme : lightTheme,
      mode,
      resolved,
      statusBarStyle: resolved === 'dark' ? 'light-content' : 'dark-content',
      setMode,
    };
  }, [failed, mode, scheme, setMode]);

  // Imperative so no <StatusBar> element (and its timer-based prop stack) is rendered.
  useEffect(() => {
    try {
      StatusBar.setBarStyle(value.statusBarStyle, true);
    } catch {
      // Not available on this platform.
    }
  }, [value.statusBarStyle]);

  return (
    <ThemeContext.Provider value={value}>
      {children}
    </ThemeContext.Provider>
  );
}

/** The current theme and mode. Light defaults outside {@link ThemeProvider}. */
export function useTheme(): ThemeContextValue {
  return useContext(ThemeContext);
}

type NamedStyles = Record<string, ViewStyle | TextStyle | ImageStyle>;

/** Styles rebuilt only when the theme changes. */
export function useThemedStyles<T extends NamedStyles>(factory: (theme: Theme) => T): T {
  const { theme } = useTheme();
  // eslint-disable-next-line react-hooks/exhaustive-deps -- factories are module-level pure functions
  return useMemo(() => StyleSheet.create(factory(theme)) as unknown as T, [theme]);
}
