/**
 * Plan summary (design D19; R21.1-R21.3, R22.3, R20.7). Shown after Submit in
 * place of NothingFits.
 *
 * - Header: "Added N tasks to this week" (or "next week"), "Nothing fits this
 *   week" when nothing was added but some items are unplaced, or "Nothing to
 *   add" when there is nothing at all (for example only sleep lines).
 * - The added tasks (title, Toronto day and time range, category chip), sorted
 *   by start.
 * - Unplaced items with their minutes, then "Move these to next week" (hidden
 *   once this already is the next-week summary) and "Leave them out".
 * - Ignored sleep lines in a muted section.
 * - Each added task opens the TimingEditor (R29); after a change the list is
 *   re-read and an Undo line stays for the service's undo window (10 s).
 * - Unplaced items show why they were left out (R28.2, R28.5); notes (R28.7)
 *   and tasks dated in other weeks ("Also added to ...") get their own sections.
 * - "View my week" resets to [Dashboard, WeekView].
 *
 * Data comes from the stores (`repos.blocks`, `repos.items`); the route only
 * carries ids.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, Text, ToastAndroid, View } from 'react-native';
import {
  addDaysToKey,
  categoryStyle,
  describeSetTiming,
  formatDateKey,
  formatMinutes,
  formatTimeRange,
  formatTorontoDate,
  formatTorontoDateTime,
  shiftWeekId,
  type DeviceBlock,
} from '@timeblocker/app-core';
import type { IntakeItem } from '@timeblocker/flows';
import type { PlanSummaryReason, RootScreenProps } from '../navigation/types';
import { useAppServices } from '../services/AppServices';
import { useTheme, useThemedStyles, type Theme } from '../theme';
import { TimingEditor, type TimingChanged } from './TimingEditor';

export const PLAN_SUMMARY_LOADING_TEXT = 'Loading your plan';
export const PLAN_SUMMARY_LOAD_ERROR = "Couldn't load this summary. Open your week to see your tasks.";
export const PLAN_SUMMARY_ACTION_ERROR = "That didn't work. Try again.";
export const PLAN_SUMMARY_MOVE_LABEL = 'Move these to next week';
export const PLAN_SUMMARY_LEAVE_LABEL = 'Leave them out';
export const PLAN_SUMMARY_VIEW_WEEK_LABEL = 'View my week';
export const PLAN_SUMMARY_STILL_NOTE = "These still don't fit next week";
export const PLAN_SUMMARY_NEXT_WEEK_CAPTION =
  'Your next-week tasks are in Google Calendar and appear here when that week starts.';
export const PLAN_SUMMARY_IGNORED_TITLE = 'Skipped: sleep is already protected';

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

/** The header line for a summary (R21.1). */
export function summaryHeader(added: number, unplaced: number, nextWeek: boolean): string {
  const when = nextWeek ? 'next week' : 'this week';
  if (added > 0) return `Added ${added} ${plural(added, 'task', 'tasks')} to ${when}`;
  if (unplaced > 0) return nextWeek ? 'Nothing fits next week either' : 'Nothing fits this week';
  return 'Nothing to add';
}

/** "Fri 5:00 PM – 5:45 PM", in Toronto time. */
export function blockWhen(block: Pick<DeviceBlock, 'start' | 'end'>): string {
  const day = formatTorontoDate(block.start).split(',')[0] ?? '';
  return `${day} ${formatTimeRange(block.start, block.end)}`;
}

const confirmLeft = (n: number) => `Left out ${n} ${plural(n, 'task', 'tasks')}.`;


export const PLAN_SUMMARY_DEADLINE_TEXT = 'No time before the deadline';
export const PLAN_SUMMARY_EDIT_HINT = 'Edit the time in your list and add it again.';
export const PLAN_SUMMARY_UNDONE = 'Move undone.';
export const PLAN_SUMMARY_UNDO_GONE = 'Undo is no longer available.';
export const PLAN_SUMMARY_NOTES_TITLE = 'Notes';

/** "Jan 12 – Jan 18" for the week starting on `weekId`. */
export function weekRangeLabel(weekId: string): string {
  const monthDay = (key: string) => formatDateKey(key).split(', ')[1] ?? key;
  return `${monthDay(weekId)} – ${monthDay(addDaysToKey(weekId, 6))}`;
}

/**
 * Why an item was left out, or null when there is nothing extra to say.
 * Without a reason, an item with a deadline is read as "no time before the
 * deadline" (the dashboard deep link carries only the item id).
 */
export function unplacedReasonText(item: IntakeItem, reason: PlanSummaryReason | undefined): string | null {
  const effective = reason ?? (item.dueAt ? 'no-time-before-deadline' : undefined);
  const at = item.fixedStart ? formatTorontoDateTime(item.fixedStart) : 'the time you asked for';
  switch (effective) {
    case 'clash':
      return `Couldn't schedule at ${at}: that time is taken`;
    case 'past':
      return `Couldn't schedule at ${at}: that time has passed`;
    case 'no-time-before-deadline':
      return PLAN_SUMMARY_DEADLINE_TEXT;
    default:
      return null;
  }
}

/** One week of the summary as read from the stores. */
interface WeekData {
  weekId: string;
  blocks: DeviceBlock[];
  unplaced: IntakeItem[];
  reasons: Record<string, PlanSummaryReason | undefined>;
}

interface UndoOffer {
  text: string;
  blockId: string;
  expiresAt: number;
}

export function PlanSummaryScreen({ navigation, route }: RootScreenProps<'PlanSummary'>): React.JSX.Element {
  const { weekId, blockIds, unplacedItemIds, ignored, mode, notes, reasons, otherWeeks } = route.params;
  const nextWeek = mode === 'next-week';
  const { repos, planning, blockActions, clock } = useAppServices();
  const styles = useThemedStyles(makeStyles);
  const [weeks, setWeeks] = useState<WeekData[] | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [busy, setBusy] = useState<'move' | 'leave' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<DeviceBlock | null>(null);
  const [undoOffer, setUndoOffer] = useState<UndoOffer | null>(null);
  const [undoBusy, setUndoBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const mounted = useRef(true);
  const inFlight = useRef(false);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const loadAll = useCallback(async (): Promise<WeekData[]> => {
    const specs = [{ weekId, blockIds, unplacedItemIds, reasons }, ...(otherWeeks ?? [])];
    return Promise.all(
      specs.map(async (spec) => {
        const [blocks, items] = await Promise.all([repos.blocks.get(spec.weekId), repos.items.get(spec.weekId)]);
        const wantedBlocks = new Set(spec.blockIds);
        const wantedItems = new Set(spec.unplacedItemIds);
        return {
          weekId: spec.weekId,
          blocks: blocks
            .filter((b) => wantedBlocks.has(b.id))
            .sort((a, b) => Date.parse(a.start) - Date.parse(b.start)),
          unplaced: items.filter((i) => wantedItems.has(i.id)),
          reasons: spec.reasons ?? {},
        };
      }),
    );
    // Route params are fixed for a screen instance.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repos, weekId]);

  useEffect(() => {
    let active = true;
    setLoadError(false);
    loadAll().then(
      (data) => {
        if (active) setWeeks(data);
      },
      () => {
        if (active) setLoadError(true);
      },
    );
    return () => {
      active = false;
    };
  }, [loadAll]);

  // The Undo line disappears when the service's undo window ends.
  useEffect(() => {
    if (!undoOffer) return;
    const timer = setTimeout(() => setUndoOffer(null), Math.max(0, undoOffer.expiresAt - clock.now()));
    return () => clearTimeout(timer);
  }, [undoOffer, clock]);

  const refresh = useCallback(async () => {
    try {
      const data = await loadAll();
      if (mounted.current) setWeeks(data);
    } catch {
      // Keep the list that is showing.
    }
  }, [loadAll]);

  const onChanged = useCallback(
    (result: TimingChanged) => {
      setEditing(null);
      setNote(null);
      setUndoOffer({ text: describeSetTiming(result), blockId: result.block.id, expiresAt: result.undo.expiresAt });
      void refresh();
    },
    [refresh],
  );

  const onUndo = useCallback(async () => {
    if (!undoOffer || undoBusy) return;
    setUndoBusy(true);
    try {
      const result = await blockActions.undo({ blockId: undoOffer.blockId });
      if (!mounted.current) return;
      setNote(result.kind === 'undone' ? PLAN_SUMMARY_UNDONE : PLAN_SUMMARY_UNDO_GONE);
      setUndoOffer(null);
      await refresh();
    } catch {
      if (mounted.current) setNote(PLAN_SUMMARY_ACTION_ERROR);
    } finally {
      if (mounted.current) setUndoBusy(false);
    }
  }, [blockActions, refresh, undoBusy, undoOffer]);

  const resetToWeek = useCallback(() => {
    navigation.reset({ index: 1, routes: [{ name: 'Dashboard' }, { name: 'WeekView' }] });
  }, [navigation]);

  const run = useCallback(
    async (kind: 'move' | 'leave') => {
      if (inFlight.current) return;
      inFlight.current = true;
      setBusy(kind);
      setError(null);
      try {
        if (kind === 'move') {
          const result = await planning.rollToNextWeek(weekId, unplacedItemIds);
          const nextReasons: Record<string, PlanSummaryReason> = {};
          for (const item of result.unplaced) if (item.reason) nextReasons[item.id] = item.reason;
          navigation.replace('PlanSummary', {
            weekId: shiftWeekId(weekId, -1),
            blockIds: result.blocks.map((b) => b.id),
            unplacedItemIds: result.unplaced.map((i) => i.id),
            mode: 'next-week',
            ...(Object.keys(nextReasons).length > 0 ? { reasons: nextReasons } : {}),
          });
          return;
        }
        await planning.dropUnplaced(weekId, unplacedItemIds);
        try {
          ToastAndroid.show(confirmLeft(unplacedItemIds.length), ToastAndroid.SHORT);
        } catch {
          // The confirmation is a courtesy; never fail the action over it.
        }
        resetToWeek();
      } catch {
        if (mounted.current) setError(PLAN_SUMMARY_ACTION_ERROR);
      } finally {
        inFlight.current = false;
        if (mounted.current) setBusy(null);
      }
    },
    [navigation, planning, resetToWeek, unplacedItemIds, weekId],
  );

  const loaded = weeks !== null;
  const main = weeks?.[0];
  const extraWeeks = weeks?.slice(1) ?? [];
  const added = main?.blocks ?? [];
  const unplaced = main?.unplaced ?? [];
  const hasUnplaced = unplacedItemIds.length > 0;
  const ignoredLines = ignored ?? [];
  const noteLines = notes ?? [];
  const otherAdded = extraWeeks.reduce((n, w) => n + w.blocks.length, 0);
  const headerText =
    added.length === 0 && unplacedItemIds.length === 0 && otherAdded > 0
      ? 'Nothing added to this week'
      : summaryHeader(added.length, unplacedItemIds.length, nextWeek);
  const showEditHint = unplaced.some((i) => {
    const r = main?.reasons[i.id];
    return r === 'clash' || r === 'past';
  });

  const blockRow = (block: DeviceBlock) => {
    const style = categoryStyle(block.category);
    const when = blockWhen(block);
    return (
      <Pressable
        key={block.id}
        accessibilityRole="button"
        accessibilityLabel={`${block.title}, ${when}, ${block.category}`}
        accessibilityHint="Change time"
        onPress={() => setEditing(block)}
        style={({ pressed }) => [styles.row, pressed && styles.pressed]}
        testID={`plan-summary-block-${block.id}`}
      >
        <View style={styles.rowText}>
          <Text style={styles.rowTitle}>{block.title}</Text>
          <Text style={styles.rowWhen}>{when}</Text>
        </View>
        <View style={[styles.chip, { backgroundColor: style.fill, borderColor: style.border }]}>
          <Text style={[styles.chipText, { color: style.text }]}>{block.category}</Text>
        </View>
      </Pressable>
    );
  };

  const unplacedRow = (week: WeekData, item: IntakeItem) => {
    const why = unplacedReasonText(item, week.reasons[item.id]);
    return (
      <View
        key={item.id}
        accessible
        accessibilityLabel={`${item.text}, ${formatMinutes(item.durationMin)}${why ? `, ${why}` : ''}`}
        style={styles.row}
        testID={`plan-summary-item-${item.id}`}
      >
        <View style={styles.rowText}>
          <Text style={styles.rowTitle}>{item.text}</Text>
          {why ? (
            <Text style={styles.rowWhen} testID={`plan-summary-reason-${item.id}`}>
              {why}
            </Text>
          ) : null}
        </View>
        <Text style={styles.rowWhen}>{formatMinutes(item.durationMin)}</Text>
      </View>
    );
  };

  return (
    <ScrollView style={styles.scroll} contentContainerStyle={styles.container} testID="screen-PlanSummary">
      {loaded ? (
        <Text accessibilityRole="header" style={styles.title} testID="plan-summary-header">
          {headerText}
        </Text>
      ) : loadError ? null : (
        <Text accessibilityLiveRegion="polite" style={styles.muted} testID="plan-summary-loading">
          {PLAN_SUMMARY_LOADING_TEXT}
        </Text>
      )}
      {loadError ? (
        <Text accessibilityRole="alert" style={styles.error} testID="plan-summary-load-error">
          {PLAN_SUMMARY_LOAD_ERROR}
        </Text>
      ) : null}

      {undoOffer ? (
        <View style={styles.undoBar} testID="plan-summary-undo-bar">
          <Text accessibilityLiveRegion="polite" style={styles.undoText} testID="plan-summary-undo-text">
            {undoOffer.text}
          </Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Undo"
            accessibilityState={{ disabled: undoBusy, busy: undoBusy }}
            disabled={undoBusy}
            onPress={() => void onUndo()}
            style={({ pressed }) => [styles.undoButton, (pressed || undoBusy) && styles.pressed]}
            testID="plan-summary-undo"
          >
            <Text style={styles.undoButtonText}>Undo</Text>
          </Pressable>
        </View>
      ) : null}
      {note ? (
        <Text accessibilityLiveRegion="polite" style={styles.muted} testID="plan-summary-note">
          {note}
        </Text>
      ) : null}

      {loaded && added.length > 0 ? (
        <View style={styles.section} testID="plan-summary-added">
          {added.map(blockRow)}
        </View>
      ) : null}

      {loaded && hasUnplaced ? (
        <View style={styles.section} testID="plan-summary-unplaced">
          <Text accessibilityRole="header" style={styles.sectionTitle}>
            {nextWeek ? "Didn't fit next week" : "Didn't fit this week"}
          </Text>
          {main ? unplaced.map((item) => unplacedRow(main, item)) : null}
          {showEditHint ? (
            <Text style={styles.muted} testID="plan-summary-edit-hint">
              {PLAN_SUMMARY_EDIT_HINT}
            </Text>
          ) : null}
          {nextWeek ? (
            <Text style={styles.muted} testID="plan-summary-still-note">
              {PLAN_SUMMARY_STILL_NOTE}
            </Text>
          ) : null}
          {error ? (
            <Text accessibilityRole="alert" accessibilityLiveRegion="assertive" style={styles.error} testID="plan-summary-error">
              {error}
            </Text>
          ) : null}
          <View style={styles.actions}>
            {nextWeek ? null : (
              <SummaryButton
                label={PLAN_SUMMARY_MOVE_LABEL}
                busy={busy === 'move'}
                disabled={busy !== null}
                onPress={() => void run('move')}
                testID="plan-summary-move"
                primary
              />
            )}
            <SummaryButton
              label={PLAN_SUMMARY_LEAVE_LABEL}
              busy={busy === 'leave'}
              disabled={busy !== null}
              onPress={() => void run('leave')}
              testID="plan-summary-leave"
            />
          </View>
        </View>
      ) : null}

      {extraWeeks.map((week) =>
        week.blocks.length > 0 || week.unplaced.length > 0 ? (
          <View key={week.weekId} style={styles.section} testID={`plan-summary-week-${week.weekId}`}>
            <Text accessibilityRole="header" style={styles.sectionTitle}>
              {`Also added to ${weekRangeLabel(week.weekId)}`}
            </Text>
            {week.blocks.map(blockRow)}
            {week.unplaced.length > 0 ? (
              <Text style={styles.mutedTitle}>{"Didn't fit"}</Text>
            ) : null}
            {week.unplaced.map((item) => unplacedRow(week, item))}
          </View>
        ) : null,
      )}

      {noteLines.length > 0 ? (
        <View style={styles.section} testID="plan-summary-notes">
          <Text accessibilityRole="header" style={styles.mutedTitle}>
            {PLAN_SUMMARY_NOTES_TITLE}
          </Text>
          {noteLines.map((line, index) => (
            <Text key={`${index}-${line}`} style={styles.muted}>
              {line}
            </Text>
          ))}
        </View>
      ) : null}

      {ignoredLines.length > 0 ? (
        <View style={styles.section} testID="plan-summary-ignored">
          <Text accessibilityRole="header" style={styles.mutedTitle}>
            {PLAN_SUMMARY_IGNORED_TITLE}
          </Text>
          {ignoredLines.map((line, index) => (
            <Text key={`${index}-${line.text}`} style={styles.muted}>
              {line.text}
            </Text>
          ))}
        </View>
      ) : null}

      <View style={styles.footer}>
        {nextWeek ? (
          <Text style={styles.muted} testID="plan-summary-caption">
            {PLAN_SUMMARY_NEXT_WEEK_CAPTION}
          </Text>
        ) : null}
        <SummaryButton
          label={PLAN_SUMMARY_VIEW_WEEK_LABEL}
          disabled={busy !== null}
          onPress={resetToWeek}
          testID="plan-summary-view-week"
          primary={!hasUnplaced || nextWeek}
        />
      </View>

      {editing ? <TimingEditor block={editing} onClose={() => setEditing(null)} onChanged={onChanged} /> : null}
    </ScrollView>
  );
}

function SummaryButton({
  label,
  onPress,
  testID,
  primary,
  busy,
  disabled,
}: {
  label: string;
  onPress: () => void;
  testID: string;
  primary?: boolean;
  busy?: boolean;
  disabled?: boolean;
}): React.JSX.Element {
  const { theme } = useTheme();
  const styles = useThemedStyles(makeStyles);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: !!disabled, busy: !!busy }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        primary && styles.buttonPrimary,
        (pressed || disabled) && styles.pressed,
      ]}
      testID={testID}
    >
      {busy ? <ActivityIndicator color={primary ? theme.onPrimary : theme.outline} /> : null}
      <Text style={[styles.buttonText, primary && styles.buttonTextPrimary]}>{label}</Text>
    </Pressable>
  );
}

const makeStyles = (theme: Theme) => ({
  scroll: { flex: 1, backgroundColor: theme.background } as const,
  container: { padding: 24, paddingBottom: 40 } as const,
  title: { fontSize: 28, fontWeight: '700', color: theme.text } as const,
  section: { marginTop: 24, gap: 8 } as const,
  sectionTitle: { fontSize: 18, fontWeight: '600', color: theme.text } as const,
  mutedTitle: { fontSize: 14, fontWeight: '600', color: theme.textMuted } as const,
  muted: { fontSize: 14, color: theme.textMuted } as const,
  error: { marginTop: 12, fontSize: 16, color: theme.danger, fontWeight: '600' } as const,
  row: {
    minHeight: 56,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: theme.border,
    backgroundColor: theme.surface,
    paddingHorizontal: 16,
    paddingVertical: 10,
  } as const,
  rowText: { flex: 1 } as const,
  rowTitle: { flexShrink: 1, fontSize: 16, fontWeight: '600', color: theme.text } as const,
  rowWhen: { marginTop: 2, fontSize: 14, color: theme.textMuted } as const,
  chip: { borderRadius: 12, borderWidth: 1, paddingHorizontal: 10, paddingVertical: 4 } as const,
  chipText: { fontSize: 12, fontWeight: '600' } as const,
  actions: { marginTop: 8, gap: 12 } as const,
  footer: { marginTop: 32, gap: 12 } as const,
  undoBar: {
    marginTop: 16,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: theme.border,
    backgroundColor: theme.surface,
    paddingHorizontal: 16,
    paddingVertical: 10,
  } as const,
  undoText: { flex: 1, fontSize: 14, color: theme.text } as const,
  undoButton: {
    minHeight: 48,
    minWidth: 64,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 24,
    borderWidth: 1,
    borderColor: theme.outline,
    paddingHorizontal: 16,
  } as const,
  undoButtonText: { fontSize: 16, fontWeight: '600', color: theme.outline } as const,
  button: {
    minHeight: 48,
    flexDirection: 'row',
    gap: 8,
    borderRadius: 24,
    borderWidth: 1,
    borderColor: theme.outline,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 24,
    backgroundColor: theme.surface,
  } as const,
  buttonPrimary: { backgroundColor: theme.primary, borderColor: theme.primary } as const,
  pressed: { opacity: 0.7 } as const,
  buttonText: { fontSize: 16, fontWeight: '600', color: theme.outline } as const,
  buttonTextPrimary: { color: theme.onPrimary } as const,
});
