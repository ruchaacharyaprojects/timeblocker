/**
 * Intake screen (design: "Intake validation", "Navigation and screens", D12;
 * R1.1, R11.4-R11.6, R15.1, R15.8).
 *
 * - A multiline paste box (`maxLength={MAX_INTAKE_CHARS}`, 20,000) with a
 *   live character counter. It accepts a JSON item array or one item per line.
 * - On open, the saved intake draft's text is restored (unless the user has
 *   already typed), so a paste survives an app kill (R1.3).
 * - Submit calls `intake.submit(text, review.currentWeekId())`: validate,
 *   estimate lengths and categories, and plan in one step. On success the
 *   stack is reset to `[Dashboard, PlanSummary]` (block ids, unplaced item ids,
 *   ignored sleep lines; R21), so Back returns to the dashboard.
 *   Rejected input stays here with an inline reason and the exact text
 *   (R11.6); any other failure shows a retry message and keeps the text.
 * - "Clear this week's tasks" (R22.3) asks first, then calls `weekReset.clear`
 *   and reports what was removed and kept.
 * - The first visible text is the instruction line (R20.1); there is no
 *   separate review step (R20.7).
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, Pressable, ScrollView, Text, TextInput } from 'react-native';
import { MAX_INTAKE_CHARS, MAX_INTAKE_ITEMS, type IntakeRejectionReason } from '@timeblocker/flows';
import type { PlanSummaryReason, PlanSummaryWeek, RootScreenProps } from '../navigation/types';
import { useAppServices } from '../services/AppServices';
import { useTheme, useThemedStyles, type Theme } from '../theme';

export const INTAKE_SUBMIT_LABEL = 'Submit';
export const INTAKE_INPUT_LABEL = 'To-do list';

/** "20000" → "20,000" (no locale dependence). */
export function formatCount(n: number): string {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** The inline error for each rejection reason (R11.6). */
export const INTAKE_REJECTION_MESSAGES: Readonly<Record<IntakeRejectionReason, string>> = {
  'too-long': `Your list is over ${formatCount(MAX_INTAKE_CHARS)} characters. Shorten it and submit again.`,
  empty: 'Your list is empty. Paste or type at least one item.',
  'malformed-json':
    "Your list starts like JSON but couldn't be read. Check the brackets, commas, and quotes, or put one item per line.",
  'no-items': 'No items were found. Put each item on its own line.',
  'too-many-items': `Your list has more than ${MAX_INTAKE_ITEMS} items. Split it into smaller lists.`,
};

/** Shown when validation itself fails (e.g. storage error). */
export const INTAKE_FAILED_MESSAGE = "Your list couldn't be planned. Your text is still here. Try again.";

/** Shown first, above the input (R20.1). */
export const INTAKE_INSTRUCTION = 'Provide a list of your tasks this week, one on each line.';
export const INTAKE_HELPER_TEXT =
  'Add how many times or how long if you like, for example "Gym 3x" or "Read 45 min". Anything else is estimated from your past blocks.';
export const INTAKE_PLACEHOLDER = 'Gym 3x\nEmail the client 30 min\nBuy a gift';
export const INTAKE_BUSY_LABEL = 'Planning…';
export const CLEAR_WEEK_LABEL = "Clear this week's tasks";
export const CLEAR_WEEK_BUSY_LABEL = 'Clearing…';
export const CLEAR_WEEK_CONFIRM_TITLE = "Clear this week's tasks?";
export const CLEAR_WEEK_CONFIRM_MESSAGE =
  'This removes tasks that have not happened yet, including their Google Calendar events and reminders. Tasks you completed, missed, or skipped stay as history.';
export const CLEAR_WEEK_FAILED_MESSAGE = "Couldn't clear this week. Try again.";

/** "Removed 3 tasks. Kept 2 as history." (R22.3) */
export function clearResultMessage(removedTasks: number, keptAsHistory: number): string {
  if (removedTasks === 0 && keptAsHistory === 0) return 'Nothing to clear.';
  const tasks = removedTasks === 1 ? 'task' : 'tasks';
  return `Removed ${removedTasks} ${tasks}. Kept ${keptAsHistory} as history.`;
}

/** The summary ids (and the reasons planning gave) for one week's plan. */
function summaryWeek(
  weekId: string,
  plan: { blocks: { id: string }[]; unplaced: { id: string; reason?: PlanSummaryReason }[] },
): PlanSummaryWeek {
  const reasons: Record<string, PlanSummaryReason> = {};
  for (const item of plan.unplaced) if (item.reason) reasons[item.id] = item.reason;
  return {
    weekId,
    blockIds: plan.blocks.map((b) => b.id),
    unplacedItemIds: plan.unplaced.map((item) => item.id),
    ...(Object.keys(reasons).length > 0 ? { reasons } : {}),
  };
}

export function IntakeScreen({ navigation }: RootScreenProps<'Intake'>): React.JSX.Element {
  const { intake, review, weekReset } = useAppServices();
  const { theme } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [clearMessage, setClearMessage] = useState<{ text: string; failed: boolean } | null>(null);
  const mounted = useRef(true);
  const touched = useRef(false);
  const inFlight = useRef(false);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // Restore the saved draft text once, unless the user already started typing.
  useEffect(() => {
    let active = true;
    intake.draft().then(
      (draft) => {
        if (active && !touched.current && draft?.text) setText(draft.text);
      },
      () => {
        // No readable draft: start with an empty box.
      },
    );
    return () => {
      active = false;
    };
  }, [intake]);

  const onChangeText = useCallback((next: string) => {
    touched.current = true;
    setText(next);
  }, []);

  const onSubmit = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    touched.current = true;
    setBusy(true);
    setError(null);
    setClearMessage(null);
    let failure: string | null = null;
    let reset: Parameters<typeof navigation.reset>[0] | null = null;
    try {
      const result = await intake.submit(text, review.currentWeekId());
      if (result.ok) {
        reset = {
          index: 1,
          routes: [
            { name: 'Dashboard' },
            {
              name: 'PlanSummary',
              params: {
                ...summaryWeek(result.weekId, result.plan),
                ignored: result.ignored,
                ...(result.notes && result.notes.length > 0 ? { notes: result.notes } : {}),
                ...(result.otherPlans && result.otherPlans.length > 0
                  ? { otherWeeks: result.otherPlans.map((p) => summaryWeek(p.weekId, p)) }
                  : {}),
              },
            },
          ],
        };
      } else if (result.error === 'rejected') {
        failure = INTAKE_REJECTION_MESSAGES[result.reason];
      } else {
        failure = INTAKE_FAILED_MESSAGE;
      }
    } catch {
      failure = INTAKE_FAILED_MESSAGE;
    } finally {
      inFlight.current = false;
    }
    if (!mounted.current) return;
    if (reset) {
      navigation.reset(reset);
      return;
    }
    setError(failure);
    setBusy(false);
  }, [intake, navigation, review, text]);

  const runClear = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setClearing(true);
    setClearMessage(null);
    let message: { text: string; failed: boolean };
    try {
      const result = await weekReset.clear(review.currentWeekId());
      touched.current = true;
      if (mounted.current) setText('');
      message = { text: clearResultMessage(result.removedTasks, result.keptAsHistory), failed: false };
    } catch {
      message = { text: CLEAR_WEEK_FAILED_MESSAGE, failed: true };
    } finally {
      inFlight.current = false;
    }
    if (!mounted.current) return;
    setClearMessage(message);
    setClearing(false);
  }, [review, weekReset]);

  const onClear = useCallback(() => {
    if (inFlight.current) return;
    Alert.alert(CLEAR_WEEK_CONFIRM_TITLE, CLEAR_WEEK_CONFIRM_MESSAGE, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Clear', style: 'destructive', onPress: () => void runClear() },
    ]);
  }, [runClear]);

  const atLimit = text.length >= MAX_INTAKE_CHARS;

  return (
    <ScrollView
      style={styles.scroll}
      contentContainerStyle={styles.container}
      keyboardShouldPersistTaps="handled"
      testID="screen-Intake"
    >
      <Text accessibilityRole="header" style={styles.title} testID="intake-instruction">
        {INTAKE_INSTRUCTION}
      </Text>
      <TextInput
        accessibilityLabel={INTAKE_INPUT_LABEL}
        accessibilityHint={`Up to ${formatCount(MAX_INTAKE_CHARS)} characters`}
        multiline
        maxLength={MAX_INTAKE_CHARS}
        value={text}
        onChangeText={onChangeText}
        editable={!busy}
        placeholder={INTAKE_PLACEHOLDER}
        placeholderTextColor={theme.textMuted}
        selectionColor={theme.outline}
        cursorColor={theme.outline}
        textAlignVertical="top"
        autoCorrect={false}
        style={[styles.input, error ? styles.inputError : null]}
        testID="intake-input"
      />
      <Text style={styles.helper} testID="intake-helper">
        {INTAKE_HELPER_TEXT}
      </Text>
      <Text
        style={[styles.counter, atLimit && styles.counterLimit]}
        accessibilityLabel={`${formatCount(text.length)} of ${formatCount(MAX_INTAKE_CHARS)} characters used`}
        testID="intake-counter"
      >
        {formatCount(text.length)} / {formatCount(MAX_INTAKE_CHARS)}
      </Text>
      {error ? (
        <Text accessibilityRole="alert" accessibilityLiveRegion="assertive" style={styles.error} testID="intake-error">
          {error}
        </Text>
      ) : null}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={busy ? INTAKE_BUSY_LABEL : INTAKE_SUBMIT_LABEL}
        accessibilityHint="Plans your list into this week"
        accessibilityState={{ disabled: busy, busy }}
        disabled={busy}
        onPress={onSubmit}
        style={({ pressed }) => [styles.button, (pressed || busy) && styles.buttonPressed]}
        testID="intake-submit"
      >
        {busy ? <ActivityIndicator color={theme.onPrimary} accessibilityLabel={INTAKE_BUSY_LABEL} /> : null}
        <Text style={styles.buttonText}>{busy ? INTAKE_BUSY_LABEL : INTAKE_SUBMIT_LABEL}</Text>
      </Pressable>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={clearing ? CLEAR_WEEK_BUSY_LABEL : CLEAR_WEEK_LABEL}
        accessibilityState={{ disabled: busy || clearing, busy: clearing }}
        disabled={busy || clearing}
        onPress={onClear}
        style={({ pressed }) => [styles.clearButton, (pressed || busy || clearing) && styles.clearButtonPressed]}
        testID="clear-week"
      >
        {clearing ? <ActivityIndicator color={theme.danger} accessibilityLabel={CLEAR_WEEK_BUSY_LABEL} /> : null}
        <Text style={styles.clearButtonText}>{clearing ? CLEAR_WEEK_BUSY_LABEL : CLEAR_WEEK_LABEL}</Text>
      </Pressable>
      {clearMessage ? (
        <Text
          accessibilityRole={clearMessage.failed ? 'alert' : undefined}
          accessibilityLiveRegion="polite"
          style={clearMessage.failed ? styles.error : styles.clearMessage}
          testID="clear-week-result"
        >
          {clearMessage.text}
        </Text>
      ) : null}
    </ScrollView>
  );
}

const makeStyles = (theme: Theme) => ({
  scroll: { flex: 1, backgroundColor: theme.background } as const,
  container: { padding: 24 } as const,
  title: { marginBottom: 16, fontSize: 18, fontWeight: '600', color: theme.text } as const,
  helper: { marginTop: 8, fontSize: 14, color: theme.textMuted } as const,
  input: {
    minHeight: 220,
    borderWidth: 1,
    borderColor: theme.border,
    borderRadius: 14,
    padding: 12,
    fontSize: 16,
    color: theme.text,
    backgroundColor: theme.surface,
  } as const,
  inputError: { borderColor: theme.danger, borderWidth: 2 } as const,
  counter: { marginTop: 4, fontSize: 14, color: theme.textMuted, textAlign: 'right' } as const,
  counterLimit: { color: theme.danger, fontWeight: '600' } as const,
  error: { marginTop: 12, fontSize: 16, color: theme.danger, fontWeight: '600' } as const,
  button: {
    marginTop: 20,
    minHeight: 48,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    borderRadius: 24,
    paddingHorizontal: 24,
    backgroundColor: theme.primary,
  } as const,
  buttonPressed: { opacity: 0.8 } as const,
  buttonText: { fontSize: 16, fontWeight: '600', color: theme.onPrimary } as const,
  clearButton: {
    marginTop: 12,
    minHeight: 48,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    borderRadius: 24,
    borderWidth: 1,
    borderColor: theme.danger,
    paddingHorizontal: 24,
    backgroundColor: theme.surface,
  } as const,
  clearButtonPressed: { opacity: 0.6 } as const,
  clearButtonText: { fontSize: 16, fontWeight: '600', color: theme.danger } as const,
  clearMessage: { marginTop: 12, fontSize: 14, color: theme.text } as const,
});
