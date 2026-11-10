/**
 * Dashboard (home) screen (design D17, D22, D23; R18.1, R18.5, R18.6, R26,
 * R27).
 *
 * - A large greeting (`Hi <name>!` / `Hi there!`), a muted motivation line,
 *   and a 2x2 grid of rounded cards (tasks, sleep, fitness, moved). Each card
 *   is one accessible element read from its `a11yLabel` and shows a colored
 *   round icon, the big value, the bold label, the caption, and (sleep) a
 *   smaller source line.
 * - A card with great progress (`widget.great`) uses the dark green
 *   `surfaceStrong` with lightning-yellow text (R26.4).
 * - An "Important deadlines" block (up to 3 rows, "+N more", or "No deadlines
 *   coming up"); a row opens its block or the plan summary.
 * - Four full-width pill rows: Week calendar (filled), Add this week's tasks,
 *   Saturday review, Settings (outlined).
 * - Pull to refresh runs `sync.sync('pull')` (the service bounds it at 14 s;
 *   a 15 s guard here clears the spinner regardless), then reloads. A failed
 *   sync shows a small non-blocking note.
 * - Reloads on focus and when the app returns to the foreground.
 *
 * Icons are glyph text in colored circles (no icon library) and are hidden
 * from screen readers; the cards and rows carry the labels.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  AppState,
  Pressable,
  RefreshControl,
  ScrollView,
  Text,
  View,
  type TextStyle,
  type ViewStyle,
} from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import type { DashboardView, ImportantRow, Widget, WidgetIcon } from '@timeblocker/app-core';
import type { RootScreenProps } from '../navigation/types';
import { useAppServices } from '../services/AppServices';
import { useTheme, useThemedStyles } from '../theme';
import type { Theme } from '../theme';

export const DASHBOARD_LOADING_TEXT = 'Loading your week';
export const DASHBOARD_LOAD_ERROR_MESSAGE = "Couldn't load your dashboard. Pull down to try again.";
export const DASHBOARD_SYNC_NOTE = "Couldn't sync with Google Calendar. Showing what's on this phone.";
export const SHOW_NAME_LABEL = 'Show my name';
export const SHOW_NAME_HINT = 'Reconnect your Google account once to read your first name';
export const SHOW_NAME_ERROR = "Couldn't update your name. Try again later.";
export const IMPORTANT_TITLE = 'Important deadlines';
export const IMPORTANT_EMPTY = 'No deadlines coming up';
/** Upper bound for the pull spinner (the sync service itself stops at 14 s). */
export const PULL_GUARD_MS = 15_000;

/** Glyph text per icon (decorative). */
export const ICON_GLYPHS: Readonly<Record<WidgetIcon, string>> = {
  check: '☑',
  moon: '☾',
  run: '🏃',
  'double-arrow': '»',
};

const HIDDEN = { accessibilityElementsHidden: true, importantForAccessibility: 'no-hide-descendants' } as const;

export function DashboardScreen({ navigation }: RootScreenProps<'Dashboard'>): React.JSX.Element {
  const { dashboard, sync, auth } = useAppServices();
  const { theme } = useTheme();
  const styles = useThemedStyles(createStyles);
  const [view, setView] = useState<DashboardView | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [syncNote, setSyncNote] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [signedIn, setSignedIn] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);
  const [nameFailed, setNameFailed] = useState(false);
  const mounted = useRef(true);
  const pulling = useRef(false);
  const loadSeq = useRef(0);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  /** Rebuild the view from local data. The latest call wins. */
  const reload = useCallback(async (): Promise<DashboardView | null> => {
    const seq = ++loadSeq.current;
    try {
      const next = await dashboard.load();
      let isSignedIn = false;
      try {
        isSignedIn = (await auth.state()).status === 'signed-in';
      } catch {
        // Treat an unreadable auth state as not signed in (hides the button).
      }
      if (!mounted.current || seq !== loadSeq.current) return null;
      setView(next);
      setSignedIn(isSignedIn);
      setLoadError(false);
      return next;
    } catch {
      if (mounted.current && seq === loadSeq.current) setLoadError(true);
      return null;
    }
  }, [dashboard, auth]);

  /** One-time Google re-authorization to read the first name; keeps the session. */
  const onShowName = useCallback(async () => {
    if (reconnecting) return;
    setReconnecting(true);
    setNameFailed(false);
    let ok = false;
    try {
      ok = (await auth.reconnect()).ok;
    } catch {
      ok = false;
    }
    const next = ok ? await reload() : null;
    if (!mounted.current) return;
    setNameFailed(!ok || !next || !next.hasName);
    setReconnecting(false);
  }, [auth, reload, reconnecting]);

  useFocusEffect(
    useCallback(() => {
      void reload();
    }, [reload]),
  );

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (next) => {
      if (next === 'active') void reload();
    });
    return () => subscription.remove();
  }, [reload]);

  const onRefresh = useCallback(async () => {
    if (pulling.current) return;
    pulling.current = true;
    setRefreshing(true);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const guard = new Promise<'guard'>((resolve) => {
      timer = setTimeout(() => resolve('guard'), PULL_GUARD_MS);
    });
    let failed = false;
    try {
      const outcome = await Promise.race([sync.sync('pull'), guard]);
      if (outcome === 'guard') failed = true;
      else if (outcome.status !== 'completed') failed = true;
    } catch {
      failed = true;
    } finally {
      if (timer) clearTimeout(timer);
    }
    if (mounted.current) setSyncNote(failed);
    await reload();
    pulling.current = false;
    if (mounted.current) setRefreshing(false);
  }, [reload, sync]);

  const openRow = useCallback(
    (row: ImportantRow) => {
      if (row.target.kind === 'block') {
        navigation.navigate('BlockDetail', { blockId: row.target.blockId, weekId: row.target.weekId });
      } else {
        navigation.navigate('PlanSummary', {
          weekId: row.target.weekId,
          blockIds: [],
          unplacedItemIds: [row.target.itemId],
        });
      }
    },
    [navigation],
  );

  return (
    <ScrollView
      style={styles.scroll}
      contentContainerStyle={styles.container}
      testID="screen-Dashboard"
      refreshControl={
        <RefreshControl
          testID="dashboard-refresh"
          refreshing={refreshing}
          onRefresh={onRefresh}
          accessibilityLabel="Pull to sync with Google Calendar"
          colors={[theme.outline]}
          progressBackgroundColor={theme.surface}
          tintColor={theme.outline}
        />
      }
    >
      {view ? (
        <>
          <Text accessibilityRole="header" style={styles.greeting} testID="dashboard-greeting">
            {view.greeting}
          </Text>
          <Text style={styles.message} testID="dashboard-message">
            {view.message}
          </Text>
          {signedIn && !view.hasName ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={SHOW_NAME_LABEL}
              accessibilityHint={SHOW_NAME_HINT}
              accessibilityState={{ busy: reconnecting, disabled: reconnecting }}
              disabled={reconnecting}
              onPress={() => void onShowName()}
              style={({ pressed }) => [styles.showName, pressed && styles.pressed]}
              testID="dashboard-show-name"
            >
              <Text style={styles.showNameText}>{reconnecting ? 'Connecting…' : SHOW_NAME_LABEL}</Text>
            </Pressable>
          ) : null}
          {nameFailed && !view.hasName ? (
            <Text accessibilityLiveRegion="polite" style={styles.note} testID="dashboard-name-error">
              {SHOW_NAME_ERROR}
            </Text>
          ) : null}
          <View style={styles.grid}>
            {view.widgets.map((w) => (
              <WidgetCard key={w.id} widget={w} />
            ))}
          </View>
          <ImportantBlock important={view.important} onOpen={openRow} />
        </>
      ) : loadError ? null : (
        <Text accessibilityLiveRegion="polite" style={styles.loading} testID="dashboard-loading">
          {DASHBOARD_LOADING_TEXT}
        </Text>
      )}

      {loadError ? (
        <Text accessibilityRole="alert" style={styles.error} testID="dashboard-load-error">
          {DASHBOARD_LOAD_ERROR_MESSAGE}
        </Text>
      ) : null}
      {syncNote ? (
        <Text accessibilityLiveRegion="polite" style={styles.note} testID="dashboard-sync-note">
          {DASHBOARD_SYNC_NOTE}
        </Text>
      ) : null}

      <View style={styles.actions}>
        <PillRow label="Week calendar" glyph="▦" onPress={() => navigation.navigate('WeekView')} testID="open-week" primary />
        <PillRow label="Add this week's tasks" glyph="⊕" onPress={() => navigation.navigate('Intake')} testID="open-intake" />
        <PillRow label="Saturday review" glyph="▤" onPress={() => navigation.navigate('SaturdayReview')} testID="open-review" />
        <PillRow label="Settings" glyph="⚙" onPress={() => navigation.navigate('Settings')} testID="open-settings" />
      </View>
    </ScrollView>
  );
}

function WidgetCard({ widget }: { widget: Widget }): React.JSX.Element {
  const { theme } = useTheme();
  const styles = useThemedStyles(createStyles);
  const tint = theme.icons[widget.icon];
  const great = widget.great;
  const textColor = great ? { color: theme.great } : null;
  return (
    <View
      accessible
      accessibilityLabel={widget.a11yLabel}
      style={[styles.card, great && styles.cardGreat]}
      testID={`widget-${widget.id}`}
    >
      <View style={[styles.badge, { backgroundColor: tint.tint }]} {...HIDDEN} testID={`widget-icon-${widget.id}`}>
        <Text style={[styles.badgeGlyph, { color: tint.glyph }]}>{ICON_GLYPHS[widget.icon]}</Text>
      </View>
      <Text style={[styles.value, textColor]} importantForAccessibility="no" testID={`widget-value-${widget.id}`}>
        {widget.value}
      </Text>
      <Text style={[styles.label, textColor]} importantForAccessibility="no" testID={`widget-label-${widget.id}`}>
        {widget.label}
      </Text>
      <Text style={[styles.caption, textColor]} importantForAccessibility="no" testID={`widget-caption-${widget.id}`}>
        {widget.caption}
      </Text>
      {widget.sourceLine ? (
        <Text style={[styles.sourceLine, textColor]} importantForAccessibility="no" testID={`widget-source-${widget.id}`}>
          {widget.sourceLine}
        </Text>
      ) : null}
    </View>
  );
}

function ImportantBlock({
  important,
  onOpen,
}: {
  important: DashboardView['important'];
  onOpen: (row: ImportantRow) => void;
}): React.JSX.Element {
  const { theme } = useTheme();
  const styles = useThemedStyles(createStyles);
  const marker = (urgency: ImportantRow['urgency']) =>
    urgency === 'overdue' ? theme.danger : urgency === 'soon' ? theme.warning : theme.textMuted;
  const summary = important.rows.length
    ? `${IMPORTANT_TITLE}: ${important.rows.map((r) => `${r.title}, ${r.dueLabel}`).join('; ')}`
    : `${IMPORTANT_TITLE}: ${IMPORTANT_EMPTY}`;
  return (
    <View style={styles.important} accessibilityLabel={summary} testID="dashboard-important">
      <Text accessibilityRole="header" style={styles.importantTitle}>
        {IMPORTANT_TITLE}
      </Text>
      {important.rows.length === 0 ? (
        <Text style={styles.importantEmpty} testID="important-empty">
          {IMPORTANT_EMPTY}
        </Text>
      ) : (
        important.rows.map((row) => (
          <Pressable
            key={row.id}
            accessibilityRole="button"
            accessibilityLabel={`${row.title}, ${row.dueLabel}`}
            onPress={() => onOpen(row)}
            style={({ pressed }) => [styles.importantRow, pressed && styles.pressedRow]}
            testID={`important-row-${row.id}`}
          >
            <View
              style={[styles.dot, { backgroundColor: marker(row.urgency) }]}
              {...HIDDEN}
              testID={`important-dot-${row.id}`}
            />
            <Text style={styles.importantRowTitle} numberOfLines={1} importantForAccessibility="no">
              {row.title}
            </Text>
            <Text
              style={[styles.importantDue, row.urgency === 'overdue' && { color: theme.danger, fontWeight: '700' }]}
              importantForAccessibility="no"
            >
              {row.dueLabel}
            </Text>
          </Pressable>
        ))
      )}
      {important.moreCount > 0 ? (
        <Text style={styles.importantMore} testID="important-more">
          {`+${important.moreCount} more`}
        </Text>
      ) : null}
    </View>
  );
}

function PillRow({
  label,
  glyph,
  onPress,
  testID,
  primary,
}: {
  label: string;
  glyph: string;
  onPress: () => void;
  testID: string;
  primary?: boolean;
}): React.JSX.Element {
  const styles = useThemedStyles(createStyles);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      style={({ pressed }) => [styles.pill, primary ? styles.pillPrimary : styles.pillOutlined, pressed && styles.pressed]}
      testID={testID}
    >
      <Text style={[styles.pillGlyph, primary ? styles.pillTextPrimary : styles.pillTextOutlined]} {...HIDDEN}>
        {glyph}
      </Text>
      <Text style={[styles.pillLabel, primary ? styles.pillTextPrimary : styles.pillTextOutlined]}>{label}</Text>
      <Text style={[styles.pillGlyph, primary ? styles.pillTextPrimary : styles.pillTextOutlined]} {...HIDDEN}>
        ›
      </Text>
    </Pressable>
  );
}

const createStyles = (theme: Theme) =>
  ({
    scroll: { flex: 1, backgroundColor: theme.background },
    container: { padding: 20, paddingTop: 40, paddingBottom: 40 },
    greeting: { fontSize: 34, fontWeight: '700', color: theme.text },
    message: { marginTop: 8, fontSize: 18, lineHeight: 26, color: theme.textMuted },
    loading: { fontSize: 16, color: theme.textMuted },
    error: { marginTop: 12, fontSize: 16, color: theme.danger, fontWeight: '600' },
    showName: { alignSelf: 'flex-start', minHeight: 48, justifyContent: 'center', marginTop: 4 },
    showNameText: { fontSize: 16, fontWeight: '600', color: theme.outline, textDecorationLine: 'underline' },
    note: { marginTop: 12, fontSize: 14, color: theme.textMuted },
    grid: { marginTop: 24, flexDirection: 'row', flexWrap: 'wrap', gap: 12 },
    card: {
      width: '48%',
      flexGrow: 1,
      minHeight: 168,
      borderRadius: 20,
      borderWidth: 1,
      borderColor: theme.border,
      backgroundColor: theme.surface,
      padding: 16,
      shadowColor: '#000000',
      shadowOpacity: 0.06,
      shadowRadius: 6,
      shadowOffset: { width: 0, height: 2 },
      elevation: 1,
    },
    cardGreat: { backgroundColor: theme.surfaceStrong, borderColor: theme.surfaceStrong },
    badge: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center' },
    badgeGlyph: { fontSize: 22, fontWeight: '700' },
    value: { marginTop: 12, fontSize: 36, lineHeight: 42, fontWeight: '700', color: theme.text },
    label: { marginTop: 2, fontSize: 16, fontWeight: '700', color: theme.text },
    caption: { marginTop: 2, fontSize: 14, color: theme.textMuted },
    sourceLine: { marginTop: 2, fontSize: 12, color: theme.textMuted },
    important: {
      marginTop: 12,
      borderRadius: 20,
      borderWidth: 1,
      borderColor: theme.border,
      backgroundColor: theme.surface,
      padding: 16,
      shadowColor: '#000000',
      shadowOpacity: 0.06,
      shadowRadius: 6,
      shadowOffset: { width: 0, height: 2 },
      elevation: 1,
    },
    importantTitle: { fontSize: 18, fontWeight: '700', color: theme.text },
    importantEmpty: { marginTop: 8, fontSize: 14, color: theme.textMuted },
    importantRow: { minHeight: 48, flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 4, borderRadius: 12 },
    pressedRow: { backgroundColor: theme.pressed },
    dot: { width: 10, height: 10, borderRadius: 5 },
    importantRowTitle: { flex: 1, fontSize: 16, color: theme.text },
    importantDue: { fontSize: 14, color: theme.textMuted },
    importantMore: { marginTop: 8, fontSize: 14, fontWeight: '600', color: theme.textMuted },
    actions: { marginTop: 24, gap: 10 },
    pill: {
      height: 52,
      borderRadius: 26,
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: 20,
    },
    pillPrimary: { backgroundColor: theme.primary },
    pillOutlined: { borderWidth: 2, borderColor: theme.primary, backgroundColor: 'transparent' },
    pillGlyph: { width: 28, fontSize: 20, textAlign: 'center' },
    pillLabel: { flex: 1, fontSize: 17, fontWeight: '700', textAlign: 'center' },
    pillTextPrimary: { color: theme.onPrimary },
    pillTextOutlined: { color: theme.outline },
    pressed: { opacity: 0.7 },
  }) satisfies Record<string, ViewStyle | TextStyle>;
