/**
 * SignIn screen (design: "Google OAuth on device", "Navigation and screens";
 * R11.2, R11.3, R12.1, R12.5, R12.11).
 *
 * - "Sign in with Google" calls `auth.signIn()`. While it runs the button is
 *   disabled and shows a spinner, so the flow cannot start twice.
 * - Failure shows the service's message ("Sign-in didn't complete. Try
 *   again." or "TimeBlocker needs Calendar access to work.") and the button
 *   stays available for a retry. A thrown error is treated as incomplete.
 * - After a session end (`useAuthState().status === 'session-ended'`) the
 *   screen shows "Your Google session ended" until a sign-in attempt.
 * - Success calls `authState.refresh()`; the navigator then swaps to the app
 *   routes. Tokens are never touched here.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { SESSION_ENDED_MESSAGE, SIGN_IN_INCOMPLETE_MESSAGE } from '@timeblocker/app-core';
import { useAuthState } from '../navigation/authContext';
import type { RootScreenProps } from '../navigation/types';
import { useAppServices } from '../services/AppServices';
import { useTheme, useThemedStyles, type Theme } from '../theme';

export const SIGN_IN_BUTTON_LABEL = 'Sign in with Google';

export function SignInScreen(_props: RootScreenProps<'SignIn'>): React.JSX.Element {
  const { auth, authState } = useAppServices();
  const { theme } = useTheme();
  const styles = useThemedStyles(createStyles);
  const { status } = useAuthState();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [attempted, setAttempted] = useState(false);
  const mounted = useRef(true);
  const inFlight = useRef(false);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const onSignIn = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    setAttempted(true);
    let failure: string | null = null;
    try {
      const result = await auth.signIn();
      if (result.ok) await authState.refresh();
      else failure = result.message;
    } catch {
      failure = SIGN_IN_INCOMPLETE_MESSAGE;
    } finally {
      inFlight.current = false;
    }
    // On success the navigator unmounts this screen; skip state updates then.
    if (mounted.current) {
      setError(failure);
      setBusy(false);
    }
  }, [auth, authState]);

  const sessionEnded = status === 'session-ended' && !attempted;

  return (
    <View style={styles.container} testID="screen-SignIn">
      <Text accessibilityRole="header" style={styles.title}>
        TimeBlocker
      </Text>
      <Text style={styles.subtitle}>Sign in with your Google account to plan your week on your calendar.</Text>
      {sessionEnded ? (
        <Text accessibilityRole="alert" accessibilityLiveRegion="polite" style={styles.notice} testID="sign-in-session-ended">
          {SESSION_ENDED_MESSAGE}
        </Text>
      ) : null}
      {error ? (
        <Text accessibilityRole="alert" accessibilityLiveRegion="assertive" style={styles.error} testID="sign-in-error">
          {error}
        </Text>
      ) : null}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={SIGN_IN_BUTTON_LABEL}
        accessibilityHint="Opens Google sign-in in your browser"
        accessibilityState={{ disabled: busy, busy }}
        disabled={busy}
        onPress={onSignIn}
        style={({ pressed }) => [styles.button, (pressed || busy) && styles.buttonPressed]}
        testID="sign-in-button"
      >
        {busy ? <ActivityIndicator color={theme.onPrimary} accessibilityLabel="Signing in" /> : null}
        <Text style={styles.buttonText}>{busy ? 'Signing in…' : SIGN_IN_BUTTON_LABEL}</Text>
      </Pressable>
    </View>
  );
}

const createStyles = (theme: Theme) => StyleSheet.create({
  container: { flex: 1, justifyContent: 'center', backgroundColor: theme.background, padding: 24 },
  title: { fontSize: 28, fontWeight: '700', color: theme.text, textAlign: 'center' },
  subtitle: { marginTop: 8, marginBottom: 24, fontSize: 16, color: theme.textMuted, textAlign: 'center' },
  notice: { marginBottom: 16, fontSize: 16, color: theme.text, textAlign: 'center', fontWeight: '600' },
  error: { marginBottom: 16, fontSize: 16, color: theme.danger, textAlign: 'center', fontWeight: '600' },
  button: {
    minHeight: 48,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    borderRadius: 24,
    paddingHorizontal: 24,
    backgroundColor: theme.primary,
  },
  buttonPressed: { opacity: 0.8 },
  buttonText: { fontSize: 16, fontWeight: '600', color: theme.onPrimary },
});
