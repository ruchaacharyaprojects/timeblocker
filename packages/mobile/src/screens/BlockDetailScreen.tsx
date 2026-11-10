/**
 * BlockDetail screen (design: "Navigation and screens", "Action handling";
 * R11.8, R11.9, R13.4, R13.13, R6.2).
 *
 * - Reads the block from `repos.blocks` and renders `buildBlockDetail`:
 *   title, category (color swatch + name), start, end (Toronto), and status.
 * - `weekId` may be absent (deep links carry only the id): the block is then
 *   looked up in the previous, current, and next Toronto week, like
 *   `BlockActionService` does. A block that no longer exists shows a
 *   "no longer exists" message with a way back, never a crash.
 * - "I'm in" / "Skip" call `blockActions.imIn` / `skip` (R13.4).
 * - "Move it" calls `blockActions.moveIt`. `moved` shows the Undo snackbar for
 *   the token's remaining window (10 s) with a live seconds countdown; it
 *   disappears at expiry (R11.9). `nothing-fits` leaves the block unchanged
 *   and opens NothingFits { blockId, weekId } (R13.13).
 * - "Change length" (R15.9): a 5-minute stepper (5..480) and "Save length",
 *   enabled only for scheduled blocks that have not started. It calls
 *   `blockActions.changeLength`; success shows the same Undo snackbar,
 *   nothing-fits leaves the block unchanged with a message.
 * - "Undo" calls `blockActions.undo({ blockId })`, which restores the
 *   previous slot and status (R11.9, R6.2).
 * - Only one action runs at a time; buttons are disabled while it does.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { AccessibilityInfo, ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import {
  LENGTH_STEP_MIN,
  MAX_LENGTH_MIN,
  MIN_LENGTH_MIN,
  buildBlockDetail,
  formatDurationMin,
  movedToLabel,
  weekIdAt,
  type BlockActionId,
  type DeviceBlock,
  type OpenPrompt,
  type UndoToken,
} from '@timeblocker/app-core';
import type { RootScreenProps } from '../navigation/types';
import { useAppServices } from '../services/AppServices';
import { useTheme, useThemedStyles, type Theme } from '../theme';

/** Title words that suggest the AI "Help me start" button (R34.1). */
const HELP_TITLE_WORDS = /\b(apply|application|applications|email|e-mail|draft|write|outline|plan|cover letter|resume)\b/i;
export const HELP_ME_START_LABEL = 'Help me start';

/** True when a block's kind or title suggests AI help (R34.1). Availability is checked separately. */
export function shouldOfferHelp(block: Pick<DeviceBlock, 'kind' | 'title'>): boolean {
  if (block.kind === 'application' || block.kind === 'email' || block.kind === 'study') return true;
  return HELP_TITLE_WORDS.test(block.title ?? '');
}

const WEEK_MS = 7 * 24 * 3_600_000;

export const BLOCK_MISSING_MESSAGE = 'This block no longer exists. It may have been deleted or moved to another week.';
export const ACTION_FAILED_MESSAGE = "That didn't save. Try again.";
export const UNDO_UNAVAILABLE_MESSAGE = 'Undo is no longer available.';
export const UNDONE_MESSAGE = 'Move undone.';
export const LENGTH_NO_ROOM_MESSAGE = 'No room for that length this week. The block is unchanged.';
export const LENGTH_REJECTED_MESSAGE = "The length couldn't be changed. The block is unchanged.";
export const SHORTER_LABEL = 'Make shorter by 5 minutes';
export const LONGER_LABEL = 'Make longer by 5 minutes';
export const SAVE_LENGTH_LABEL = 'Save length';

type Loaded =
  | { kind: 'loading' }
  | { kind: 'missing' }
  | { kind: 'ready'; weekId: string; block: DeviceBlock; undo: UndoToken | null; openPrompts: OpenPrompt[] };

/** Seconds shown for `ms` remaining (rounded up, so 10 000 ms → 10). */
export const undoSeconds = (ms: number): number => Math.max(0, Math.ceil(ms / 1000));

export function BlockDetailScreen({ navigation, route }: RootScreenProps<'BlockDetail'>): React.JSX.Element {
  const { blockActions, repos, clock, ai } = useAppServices();
  const { theme } = useTheme();
  const styles = useThemedStyles(createStyles);
  const { blockId, weekId: weekIdParam } = route.params;
  const [loaded, setLoaded] = useState<Loaded>({ kind: 'loading' });
  const [busy, setBusy] = useState<BlockActionId | 'undo' | 'length' | null>(null);
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);
  /** Remaining Undo window, ms; null when no Undo is offered. */
  const [undoLeftMs, setUndoLeftMs] = useState<number | null>(null);
  /** The window the countdown runs for; a new object restarts it. */
  const [undoWindow, setUndoWindow] = useState<{ leftMs: number } | null>(null);
  /** The length shown in the stepper, minutes; saved by "Save length". */
  const [lengthDraft, setLengthDraft] = useState<number | null>(null);
  /** Snackbar text for the latest change; null falls back to the move text. */
  const [undoNote, setUndoNote] = useState<string | null>(null);
  const [aiReady, setAiReady] = useState(false);
  const mounted = useRef(true);
  const inFlight = useRef(false);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  /** Read the block (searching nearby weeks when no weekId), the Undo token, and open prompts. */
  const load = useCallback(async (): Promise<Loaded> => {
    const now = clock.now();
    const weekIds = weekIdParam
      ? [weekIdParam]
      : [...new Set([weekIdAt(now - WEEK_MS), weekIdAt(now), weekIdAt(now + WEEK_MS)])];
    for (const weekId of weekIds) {
      const blocks = await repos.blocks.get(weekId);
      const block = blocks.find((b) => b.id === blockId);
      if (block) {
        const [undo, openPrompts] = await Promise.all([repos.undo.get(), repos.openPrompts.get()]);
        return { kind: 'ready', weekId, block, undo, openPrompts };
      }
    }
    return { kind: 'missing' };
  }, [blockId, weekIdParam, repos, clock]);

  /** Load and show; also (re)starts or clears the Undo countdown from the token. */
  const refresh = useCallback(async () => {
    let next: Loaded;
    try {
      next = await load();
    } catch {
      next = { kind: 'missing' };
    }
    if (!mounted.current) return;
    setLoaded(next);
    const aiState = await ai.availability().catch(() => 'disabled' as const);
    if (!mounted.current) return;
    setAiReady(aiState === 'ready');
    if (next.kind === 'ready') {
      const detail = buildBlockDetail({ block: next.block, now: clock.now(), undo: next.undo });
      setLengthDraft(detail.durationMin);
      const leftMs = detail.undo ? detail.undo.remainingMs : null;
      setUndoLeftMs(leftMs);
      setUndoWindow(leftMs === null ? null : { leftMs });
    } else {
      setUndoLeftMs(null);
      setUndoWindow(null);
    }
  }, [load, clock, ai]);

  useEffect(() => {
    setLoaded({ kind: 'loading' });
    setMessage(null);
    refresh();
  }, [refresh]);

  // Live countdown: tick on each whole second; hide exactly at expiry (R11.9).
  // Timers are chained inside callbacks (not per render) so they keep pace.
  useEffect(() => {
    if (!undoWindow) return;
    let left = undoWindow.leftMs;
    let interval: ReturnType<typeof setInterval> | undefined;
    const tick = (step: number) => {
      left -= step;
      if (left <= 0) {
        if (interval) clearInterval(interval);
        setUndoLeftMs(null);
        setUndoWindow(null);
      } else {
        setUndoLeftMs(left);
      }
    };
    const first = left % 1000 || 1000;
    const timeout = setTimeout(() => {
      tick(first);
      if (left > 0) interval = setInterval(() => tick(1000), 1000);
    }, first);
    return () => {
      clearTimeout(timeout);
      if (interval) clearInterval(interval);
    };
  }, [undoWindow]);

  /** Run one action at a time; a thrown error shows a retry message. */
  const run = useCallback(
    async (id: BlockActionId | 'undo' | 'length', action: (weekId: string) => Promise<void>) => {
      if (inFlight.current || loaded.kind !== 'ready') return;
      inFlight.current = true;
      setBusy(id);
      setMessage(null);
      try {
        await action(loaded.weekId);
      } catch {
        if (mounted.current) setMessage({ text: ACTION_FAILED_MESSAGE, error: true });
      } finally {
        inFlight.current = false;
        if (mounted.current) setBusy(null);
      }
    },
    [loaded],
  );

  const onStatus = useCallback(
    (id: 'im-in' | 'skip') =>
      run(id, async (weekId) => {
        const ref = { weekId, blockId };
        const result = id === 'im-in' ? await blockActions.imIn(ref) : await blockActions.skip(ref);
        await refresh();
        if (result.kind === 'not-found' && mounted.current) setLoaded({ kind: 'missing' });
      }),
    [run, blockActions, blockId, refresh],
  );

  const onMove = useCallback(
    () =>
      run('move', async (weekId) => {
        const result = await blockActions.moveIt({ weekId, blockId });
        if (!mounted.current) return;
        setUndoNote(null);
        if (result.kind === 'nothing-fits') {
          // The block stays where it is; the nothing-fits flow decides (R13.13).
          navigation.navigate('NothingFits', { blockId, weekId: result.block.weekId || weekId });
          return;
        }
        await refresh();
        if (result.kind === 'not-found' && mounted.current) setLoaded({ kind: 'missing' });
      }),
    [run, blockActions, blockId, navigation, refresh],
  );

  const onSaveLength = useCallback(
    () =>
      run('length', async (weekId) => {
        if (lengthDraft === null) return;
        const result = await blockActions.changeLength({ weekId, blockId }, lengthDraft);
        if (!mounted.current) return;
        if (result.kind === 'resized') {
          setUndoNote(
            result.moved
              ? `Moved to ${movedToLabel(result.block.start)} to fit ${formatDurationMin(result.durationMin)}`
              : `Length changed to ${formatDurationMin(result.durationMin)}`,
          );
          await refresh();
          return;
        }
        await refresh();
        if (!mounted.current) return;
        if (result.kind === 'not-found') setLoaded({ kind: 'missing' });
        else if (result.kind === 'nothing-fits') setMessage({ text: LENGTH_NO_ROOM_MESSAGE, error: true });
        else setMessage({ text: LENGTH_REJECTED_MESSAGE, error: true });
      }),
    [run, blockActions, blockId, lengthDraft, refresh],
  );

  const step = useCallback(
    (delta: number) => {
      if (lengthDraft === null) return;
      const next = Math.min(MAX_LENGTH_MIN, Math.max(MIN_LENGTH_MIN, lengthDraft + delta));
      if (next === lengthDraft) return;
      setLengthDraft(next);
      AccessibilityInfo.announceForAccessibility(`Length ${formatDurationMin(next)}`);
    },
    [lengthDraft],
  );

  const onUndo = useCallback(
    () =>
      run('undo', async () => {
        const result = await blockActions.undo({ blockId });
        await refresh();
        if (!mounted.current) return;
        setUndoLeftMs(null);
        setUndoWindow(null);
        setUndoNote(null);
        setMessage(
          result.kind === 'undone'
            ? { text: UNDONE_MESSAGE, error: false }
            : { text: UNDO_UNAVAILABLE_MESSAGE, error: true },
        );
      }),
    [run, blockActions, blockId, refresh],
  );

  if (loaded.kind === 'loading') {
    return (
      <View style={[styles.container, styles.centered]} testID="screen-BlockDetail">
        <ActivityIndicator accessibilityLabel="Loading block" color={theme.outline} />
      </View>
    );
  }

  if (loaded.kind === 'missing') {
    return (
      <View style={[styles.container, styles.centered]} testID="screen-BlockDetail">
        <Text accessibilityRole="header" style={styles.title}>
          Block not found
        </Text>
        <Text accessibilityRole="alert" style={styles.body} testID="block-missing">
          {BLOCK_MISSING_MESSAGE}
        </Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Back to this week"
          onPress={() => navigation.navigate('WeekView')}
          style={({ pressed }) => [styles.button, styles.primary, pressed && styles.primaryPressed]}
          testID="block-missing-back"
        >
          <Text style={styles.primaryText}>Back to this week</Text>
        </Pressable>
      </View>
    );
  }

  const detail = buildBlockDetail({
    block: loaded.block,
    now: clock.now(),
    undo: loaded.undo,
    openPrompts: loaded.openPrompts,
  });
  const draftMin = lengthDraft ?? detail.durationMin;
  const lengthControlsOff = !detail.lengthEditable || busy !== null;
  const canSaveLength = detail.lengthEditable && busy === null && draftMin !== detail.durationMin;
  const undoVisible = undoLeftMs !== null && undoLeftMs > 0;
  const seconds = undoVisible ? undoSeconds(undoLeftMs) : 0;

  return (
    <View style={styles.container} testID="screen-BlockDetail">
      <ScrollView contentContainerStyle={styles.content}>
        <Text accessibilityRole="header" style={styles.title} testID="block-title">
          {detail.title}
        </Text>

        <View style={styles.row} accessible accessibilityLabel={`Category: ${detail.categoryLabel}`} testID="block-category">
          <View style={[styles.swatch, { backgroundColor: detail.color }]} testID="block-category-color" />
          <Text style={styles.body}>{detail.categoryLabel}</Text>
        </View>

        <View style={styles.field} accessible accessibilityLabel={`Starts ${detail.startLabel}`}>
          <Text style={styles.label}>Start</Text>
          <Text style={styles.body} testID="block-start">
            {detail.startLabel}
          </Text>
        </View>
        <View style={styles.field} accessible accessibilityLabel={`Ends ${detail.endLabel}`}>
          <Text style={styles.label}>End</Text>
          <Text style={styles.body} testID="block-end">
            {detail.endLabel}
          </Text>
        </View>
        <View style={styles.field} accessible accessibilityLabel={`Status: ${detail.statusLabel}`}>
          <Text style={styles.label}>Status</Text>
          <Text style={styles.body} testID="block-status">
            {detail.statusLabel}
          </Text>
        </View>
        {detail.moveReason ? (
          <Text style={styles.note} testID="block-move-reason">
            {detail.moveReason}
          </Text>
        ) : null}
        {detail.hasOpenPrompt ? (
          <Text style={styles.note} testID="block-open-prompt">
            A "Will you miss this block?" reminder is waiting for your answer.
          </Text>
        ) : null}

        {aiReady && shouldOfferHelp(loaded.block) ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={HELP_ME_START_LABEL}
            accessibilityHint="Opens the AI helper for a draft or talking points"
            onPress={() => navigation.navigate('ApplicationHelper', { blockId, weekId: loaded.weekId })}
            style={({ pressed }) => [styles.button, styles.outlined, pressed && styles.outlinedPressed]}
            testID="block-help-me-start"
          >
            <Text style={styles.outlinedText}>{HELP_ME_START_LABEL}</Text>
          </Pressable>
        ) : null}
        {loaded.block.notes ? (
          <View style={styles.notesCard} testID="block-notes">
            <Text accessibilityRole="header" style={styles.label}>
              Notes
            </Text>
            <Text selectable style={styles.body} testID="block-notes-text">
              {loaded.block.notes}
            </Text>
          </View>
        ) : null}
        {message ? (
          <Text
            accessibilityRole="alert"
            accessibilityLiveRegion={message.error ? 'assertive' : 'polite'}
            style={message.error ? styles.error : styles.notice}
            testID="block-message"
          >
            {message.text}
          </Text>
        ) : null}

        <View style={styles.actions}>
          {detail.actions.map((action) => {
            const running = busy === action.id;
            const disabled = busy !== null;
            const onPress = action.id === 'move' ? onMove : () => onStatus(action.id as 'im-in' | 'skip');
            return (
              <Pressable
                key={action.id}
                accessibilityRole="button"
                accessibilityLabel={action.label}
                accessibilityState={{ disabled, busy: running }}
                disabled={disabled}
                onPress={onPress}
                style={({ pressed }) => [styles.button, styles.primary, (pressed || running) && styles.primaryPressed, disabled && !running && styles.dimmed]}
                testID={`block-action-${action.id}`}
              >
                {running ? <ActivityIndicator color={theme.onPrimary} /> : null}
                <Text style={styles.primaryText}>{action.label}</Text>
              </Pressable>
            );
          })}
        </View>

        <View style={styles.lengthSection} testID="block-length-section">
          <Text accessibilityRole="header" style={styles.label}>
            Change length
          </Text>
          <View style={styles.stepper}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={SHORTER_LABEL}
              accessibilityState={{ disabled: lengthControlsOff || draftMin <= MIN_LENGTH_MIN }}
              disabled={lengthControlsOff || draftMin <= MIN_LENGTH_MIN}
              onPress={() => step(-LENGTH_STEP_MIN)}
              style={({ pressed }) => [
                styles.stepButton,
                pressed && styles.primaryPressed,
                (lengthControlsOff || draftMin <= MIN_LENGTH_MIN) && styles.dimmed,
              ]}
              testID="block-length-minus"
            >
              <Text style={styles.primaryText}>−</Text>
            </Pressable>
            <Text
              accessibilityLiveRegion="polite"
              accessibilityLabel={`Length ${formatDurationMin(draftMin)}`}
              style={styles.lengthValue}
              testID="block-length-value"
            >
              {formatDurationMin(draftMin)}
            </Text>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={LONGER_LABEL}
              accessibilityState={{ disabled: lengthControlsOff || draftMin >= MAX_LENGTH_MIN }}
              disabled={lengthControlsOff || draftMin >= MAX_LENGTH_MIN}
              onPress={() => step(LENGTH_STEP_MIN)}
              style={({ pressed }) => [
                styles.stepButton,
                pressed && styles.primaryPressed,
                (lengthControlsOff || draftMin >= MAX_LENGTH_MIN) && styles.dimmed,
              ]}
              testID="block-length-plus"
            >
              <Text style={styles.primaryText}>+</Text>
            </Pressable>
          </View>
          {detail.lengthDisabledReason ? (
            <Text style={styles.note} testID="block-length-reason">
              {detail.lengthDisabledReason}
            </Text>
          ) : null}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={SAVE_LENGTH_LABEL}
            accessibilityState={{ disabled: !canSaveLength, busy: busy === 'length' }}
            disabled={!canSaveLength}
            onPress={onSaveLength}
            style={({ pressed }) => [
              styles.button,
              styles.primary,
              (pressed || busy === 'length') && styles.primaryPressed,
              !canSaveLength && styles.dimmed,
            ]}
            testID="block-length-save"
          >
            {busy === 'length' ? <ActivityIndicator color={theme.onPrimary} /> : null}
            <Text style={styles.primaryText}>{SAVE_LENGTH_LABEL}</Text>
          </Pressable>
        </View>
      </ScrollView>

      {undoVisible ? (
        <View style={styles.snackbar} testID="undo-snackbar">
          <Text accessibilityLiveRegion="polite" style={styles.snackbarText}>
            {undoNote ?? `Moved to ${movedToLabel(loaded.block.start)}`}
          </Text>
          <Text style={styles.snackbarCountdown} testID="undo-countdown" accessibilityLabel={`${seconds} seconds left to undo`}>
            {seconds} s
          </Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Undo"
            accessibilityHint={`Puts the block back where it was. ${seconds} seconds left.`}
            accessibilityState={{ disabled: busy !== null, busy: busy === 'undo' }}
            disabled={busy !== null}
            onPress={onUndo}
            style={({ pressed }) => [styles.undoButton, pressed && styles.undoPressed]}
            testID="undo-button"
          >
            <Text style={styles.undoText}>Undo</Text>
          </Pressable>
        </View>
      ) : null}
    </View>
  );
}

const createStyles = (theme: Theme) => StyleSheet.create({
  container: { flex: 1, backgroundColor: theme.background },
  centered: { justifyContent: 'center', padding: 24, gap: 16 },
  content: { padding: 24, gap: 12 },
  title: { fontSize: 24, fontWeight: '700', color: theme.text },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  swatch: { width: 16, height: 16, borderRadius: 8 },
  field: { gap: 2 },
  label: { fontSize: 14, color: theme.textMuted },
  body: { fontSize: 16, color: theme.text },
  note: { fontSize: 14, color: theme.textMuted },
  notice: { fontSize: 16, color: theme.text, fontWeight: '600' },
  error: { fontSize: 16, color: theme.danger, fontWeight: '600' },
  actions: { marginTop: 16, gap: 12 },
  button: {
    minHeight: 48,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    borderRadius: 24,
    paddingHorizontal: 24,
  },
  primary: { backgroundColor: theme.primary },
  outlined: { borderWidth: 2, borderColor: theme.primary },
  outlinedPressed: { backgroundColor: theme.pressed },
  outlinedText: { fontSize: 16, fontWeight: '600', color: theme.outline },
  notesCard: { gap: 4, padding: 12, borderRadius: 8, borderWidth: 1, borderColor: theme.border, backgroundColor: theme.surface },
  primaryPressed: { opacity: 0.8 },
  dimmed: { opacity: 0.6 },
  primaryText: { fontSize: 16, fontWeight: '600', color: theme.onPrimary },
  lengthSection: { marginTop: 24, gap: 12 },
  stepper: { flexDirection: 'row', alignItems: 'center', gap: 16 },
  stepButton: {
    minHeight: 48,
    minWidth: 48,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 24,
    backgroundColor: theme.primary,
  },
  lengthValue: { minWidth: 96, textAlign: 'center', fontSize: 20, fontWeight: '600', color: theme.text },
  snackbar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    margin: 16,
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 8,
    backgroundColor: theme.surfaceStrong,
  },
  snackbarText: { flex: 1, fontSize: 15, color: theme.textOnStrong },
  snackbarCountdown: { fontSize: 15, color: theme.textOnStrong },
  undoButton: { minHeight: 48, minWidth: 64, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 12 },
  undoPressed: { opacity: 0.7 },
  undoText: { fontSize: 15, fontWeight: '700', color: theme.great },
});
