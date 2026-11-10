/**
 * Timing editor sheet (design D26; R29.1-R29.3). Opened from a row of the plan
 * summary. Shows the task's week as day chips (Sunday to Saturday, Toronto),
 * a start-time stepper (15-minute steps, 6:00 AM to 10:45 PM, wrapping), and a
 * length stepper (5-minute steps, 5..480), prefilled with the current values.
 *
 * - Days before today are disabled (the task's week may be the current week).
 * - Save calls `blockActions.setTiming({ blockId, weekId }, { start, durationMin })`
 *   with the start built from the chosen Toronto day and time. A change is
 *   handed to `onChanged` (the summary closes the sheet, reloads, and offers
 *   Undo); a rejection or nothing-fits stays here with a plain message.
 * - Cancel closes without saving. While saving, controls are disabled.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Modal, Pressable, ScrollView, Text, View } from 'react-native';
import {
  LENGTH_STEP_MIN,
  MAX_LENGTH_MIN,
  MIN_LENGTH_MIN,
  addDaysToKey,
  formatMinutes,
  type DeviceBlock,
  type SetTimingResult,
} from '@timeblocker/app-core';
import { torontoDateKey, torontoInstant, torontoMinutesOfDay } from '@timeblocker/scheduling-engine';
import { useAppServices } from '../services/AppServices';
import { useTheme, useThemedStyles, type Theme } from '../theme';

export type TimingChanged = Extract<SetTimingResult, { kind: 'changed' }>;

export const START_STEP_MIN = 15;
/** Earliest and latest start the stepper offers, minutes after midnight. */
export const START_FIRST_MIN = 6 * 60;
export const START_LAST_MIN = 22 * 60 + 45;

export const TIMING_ERROR = "That didn't work. Try again.";
export const TIMING_SAVE_LABEL = 'Save';
export const TIMING_CANCEL_LABEL = 'Cancel';
export const TIMING_SAVING_LABEL = 'Saving…';

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;

/** "3:15 PM" for minutes after midnight. */
export function formatClock(minutes: number): string {
  const h = Math.floor(minutes / 60) % 24;
  const m = minutes % 60;
  const suffix = h >= 12 ? 'PM' : 'AM';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(m).padStart(2, '0')} ${suffix}`;
}

/**
 * One 15-minute step of the start time (snapping to the 15-minute grid),
 * wrapping within 6:00 AM to 10:45 PM.
 */
export function stepStart(minutes: number, direction: 1 | -1): number {
  const next =
    direction === 1
      ? (Math.floor(minutes / START_STEP_MIN) + 1) * START_STEP_MIN
      : (Math.ceil(minutes / START_STEP_MIN) - 1) * START_STEP_MIN;
  if (next > START_LAST_MIN) return START_FIRST_MIN;
  if (next < START_FIRST_MIN) return START_LAST_MIN;
  return next;
}

/** One 5-minute step of the length, clamped to 5..480. */
export function stepLength(minutes: number, direction: 1 | -1): number {
  return Math.min(MAX_LENGTH_MIN, Math.max(MIN_LENGTH_MIN, minutes + direction * LENGTH_STEP_MIN));
}

/** The seven `YYYY-MM-DD` keys of a week (`weekId` is its Sunday). */
export function weekDayKeys(weekId: string): string[] {
  return Array.from({ length: 7 }, (_, i) => addDaysToKey(weekId, i));
}

/** ISO instant of a Toronto day (`YYYY-MM-DD`) and minutes after midnight. */
export function buildTimingStart(dayKey: string, minutes: number): string {
  const [y, m, d] = dayKey.split('-').map(Number);
  return torontoInstant(y!, m!, d!, Math.floor(minutes / 60), minutes % 60).toISOString();
}

/** The message for a timing edit that did not change anything. */
export function timingFailureMessage(result: Exclude<SetTimingResult, { kind: 'changed' }>): string {
  switch (result.kind) {
    case 'nothing-fits':
      return `Nothing else fits if "${result.block.title}" has to move. Nothing was changed.`;
    case 'not-found':
      return TIMING_ERROR;
    case 'rejected':
      switch (result.reason) {
        case 'protected':
          return 'That time is protected (sleep, work hours or a rule). Pick another time.';
        case 'meeting':
          return `That time is taken by "${result.detail ?? 'a calendar event'}".`;
        case 'started-block':
          return "That overlaps a task you've already started or finished.";
        case 'past':
          return 'That time has already passed.';
        case 'wrong-week':
          return "Pick a day in this task's week.";
        case 'unchanged':
          return 'That is already the time.';
        case 'invalid-duration':
        case 'invalid-start':
          return 'Check the time and length.';
      }
  }
}

export interface TimingEditorProps {
  block: DeviceBlock;
  onClose: () => void;
  onChanged: (result: TimingChanged) => void;
}

export function TimingEditor({ block, onClose, onChanged }: TimingEditorProps): React.JSX.Element {
  const { blockActions, clock } = useAppServices();
  const { theme } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const startDate = new Date(block.start);
  const [dayKey, setDayKey] = useState(() => torontoDateKey(startDate));
  const [minutes, setMinutes] = useState(() => torontoMinutesOfDay(startDate));
  const [length, setLength] = useState(() => Math.max(MIN_LENGTH_MIN, Math.round((Date.parse(block.end) - Date.parse(block.start)) / 60_000)));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);
  const inFlight = useRef(false);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const todayKey = torontoDateKey(new Date(clock.now()));
  const days = weekDayKeys(block.weekId);

  const onSave = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      const result = await blockActions.setTiming(
        { blockId: block.id, weekId: block.weekId },
        { start: buildTimingStart(dayKey, minutes), durationMin: length },
      );
      if (!mounted.current) return;
      if (result.kind === 'changed') onChanged(result);
      else setError(timingFailureMessage(result));
    } catch {
      if (mounted.current) setError(TIMING_ERROR);
    } finally {
      inFlight.current = false;
      if (mounted.current) setBusy(false);
    }
  }, [blockActions, block.id, block.weekId, dayKey, minutes, length, onChanged]);

  const stepper = (
    label: string,
    value: string,
    testID: string,
    onMinus: () => void,
    onPlus: () => void,
    minusLabel: string,
    plusLabel: string,
  ) => (
    <View style={styles.field}>
      <Text style={styles.label}>{label}</Text>
      <View style={styles.stepper}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={minusLabel}
          accessibilityState={{ disabled: busy }}
          disabled={busy}
          onPress={onMinus}
          style={({ pressed }) => [styles.stepButton, (pressed || busy) && styles.dim]}
          testID={`${testID}-minus`}
        >
          <Text style={styles.stepText}>−</Text>
        </Pressable>
        <Text accessibilityLiveRegion="polite" style={styles.value} testID={`${testID}-value`}>
          {value}
        </Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={plusLabel}
          accessibilityState={{ disabled: busy }}
          disabled={busy}
          onPress={onPlus}
          style={({ pressed }) => [styles.stepButton, (pressed || busy) && styles.dim]}
          testID={`${testID}-plus`}
        >
          <Text style={styles.stepText}>+</Text>
        </Pressable>
      </View>
    </View>
  );

  return (
    <Modal transparent animationType="slide" visible onRequestClose={busy ? undefined : onClose}>
      <View style={styles.backdrop}>
        <View style={styles.sheet} testID="timing-editor">
          <ScrollView keyboardShouldPersistTaps="handled">
            <Text accessibilityRole="header" style={styles.title} testID="timing-editor-title">
              {block.title}
            </Text>

            <View style={styles.field}>
              <Text style={styles.label}>Day</Text>
              <View style={styles.days}>
                {days.map((key, index) => {
                  const selected = key === dayKey;
                  const disabled = busy || key < todayKey;
                  const date = Number(key.slice(8));
                  return (
                    <Pressable
                      key={key}
                      accessibilityRole="button"
                      accessibilityLabel={`${WEEKDAYS[index]} ${date}`}
                      accessibilityState={{ selected, disabled }}
                      disabled={disabled}
                      onPress={() => setDayKey(key)}
                      style={[styles.day, selected && styles.daySelected, disabled && !selected && styles.dayDisabled]}
                      testID={`timing-day-${key}`}
                    >
                      <Text style={[styles.dayName, selected && styles.dayTextSelected]}>{WEEKDAYS[index]}</Text>
                      <Text style={[styles.dayNumber, selected && styles.dayTextSelected]}>{date}</Text>
                    </Pressable>
                  );
                })}
              </View>
            </View>

            {stepper(
              'Start',
              formatClock(minutes),
              'timing-start',
              () => setMinutes((m) => stepStart(m, -1)),
              () => setMinutes((m) => stepStart(m, 1)),
              'Start 15 minutes earlier',
              'Start 15 minutes later',
            )}
            {stepper(
              'Length',
              formatMinutes(length),
              'timing-length',
              () => setLength((l) => stepLength(l, -1)),
              () => setLength((l) => stepLength(l, 1)),
              'Make 5 minutes shorter',
              'Make 5 minutes longer',
            )}

            {error ? (
              <Text accessibilityRole="alert" accessibilityLiveRegion="assertive" style={styles.error} testID="timing-error">
                {error}
              </Text>
            ) : null}

            <View style={styles.actions}>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={busy ? TIMING_SAVING_LABEL : TIMING_SAVE_LABEL}
                accessibilityState={{ disabled: busy, busy }}
                disabled={busy}
                onPress={() => void onSave()}
                style={({ pressed }) => [styles.primary, (pressed || busy) && styles.dim]}
                testID="timing-save"
              >
                {busy ? <ActivityIndicator color={theme.onPrimary} /> : null}
                <Text style={styles.primaryText}>{busy ? TIMING_SAVING_LABEL : TIMING_SAVE_LABEL}</Text>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={TIMING_CANCEL_LABEL}
                accessibilityState={{ disabled: busy }}
                disabled={busy}
                onPress={onClose}
                style={({ pressed }) => [styles.outlined, (pressed || busy) && styles.dim]}
                testID="timing-cancel"
              >
                <Text style={styles.outlinedText}>{TIMING_CANCEL_LABEL}</Text>
              </Pressable>
            </View>
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

const makeStyles = (theme: Theme) => ({
  backdrop: { flex: 1, justifyContent: 'flex-end' } as const,
  sheet: {
    maxHeight: '90%',
    padding: 24,
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    borderWidth: 1,
    borderColor: theme.border,
    backgroundColor: theme.surface,
  } as const,
  title: { fontSize: 20, fontWeight: '700', color: theme.text } as const,
  field: { marginTop: 20, gap: 8 } as const,
  label: { fontSize: 14, fontWeight: '600', color: theme.textMuted } as const,
  days: { flexDirection: 'row', gap: 4 } as const,
  day: {
    flex: 1,
    minHeight: 56,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: theme.border,
    backgroundColor: theme.background,
  } as const,
  daySelected: { backgroundColor: theme.primary, borderColor: theme.primary } as const,
  dayDisabled: { opacity: 0.4 } as const,
  dayName: { fontSize: 12, color: theme.textMuted } as const,
  dayNumber: { fontSize: 16, fontWeight: '600', color: theme.text } as const,
  dayTextSelected: { color: theme.onPrimary } as const,
  stepper: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 } as const,
  stepButton: {
    width: 48,
    height: 48,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 24,
    borderWidth: 1,
    borderColor: theme.outline,
    backgroundColor: theme.surface,
  } as const,
  stepText: { fontSize: 24, fontWeight: '600', color: theme.outline } as const,
  value: { flex: 1, textAlign: 'center', fontSize: 20, fontWeight: '600', color: theme.text } as const,
  error: { marginTop: 16, fontSize: 16, fontWeight: '600', color: theme.danger } as const,
  actions: { marginTop: 24, gap: 12 } as const,
  primary: {
    minHeight: 48,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    borderRadius: 24,
    paddingHorizontal: 24,
    backgroundColor: theme.primary,
  } as const,
  primaryText: { fontSize: 16, fontWeight: '600', color: theme.onPrimary } as const,
  outlined: {
    minHeight: 48,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 24,
    borderWidth: 1,
    borderColor: theme.outline,
    paddingHorizontal: 24,
    backgroundColor: theme.surface,
  } as const,
  outlinedText: { fontSize: 16, fontWeight: '600', color: theme.outline } as const,
  dim: { opacity: 0.7 } as const,
});
