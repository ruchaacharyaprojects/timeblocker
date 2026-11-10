/**
 * WeekView screen (design: "Navigation and screens", D13; R11.7, R13.9, R14.1,
 * R14.2, R14.10, R16).
 *
 * - Renders `buildWeekView` -> `buildWeekGrid` for the current Toronto week as
 *   a Sunday-first time grid: fixed day headers, an hour gutter, and seven
 *   columns with absolutely positioned rectangles. Blocks use their category
 *   color; other calendar events use the dashed "Calendar" style.
 *   Accessibility labels carry the category/kind text, so color is never the
 *   only signal (R11.7).
 * - Tapping a block opens BlockDetail `{ blockId, weekId }` (R11.8). Tapping a
 *   calendar event shows a small inline panel with its title and time.
 * - Bell badges come from `notifications.indicators(now)` and are shown as an
 *   icon plus the "Needs attention" accessibility text (R13.9).
 * - Pull to refresh runs `sync.sync('pull')`, then reloads. The service
 *   bounds a pull sync at 14 s, so the spinner clears within 15 s whether
 *   the sync completes, fails, or times out (R14.2).
 * - A failed sync shows a dismissible banner naming it; dismissing calls
 *   `sync.dismissBanner()`. The banner also clears after a later successful
 *   sync, since the view model hides it then (R14.10).
 * - "Last synced" shows the last successful sync time.
 * - The view reloads on focus and when the app returns to the foreground
 *   (the composition root runs the foreground sync itself, R14.1).
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  AppState,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { buildWeekGrid, buildWeekView, type GridItem, type WeekGrid, type WeekView } from '@timeblocker/app-core';
import type { RootScreenProps } from '../navigation/types';
import { useAppServices } from '../services/AppServices';
import { useTheme, useThemedStyles, type Theme } from '../theme';
import { BELL_LABEL, DayHeader, EMPTY_WEEK_HINT, GRID_HEIGHT, GridColumn, HourGutter, minToY } from './weekGrid';

export { BELL_LABEL, EMPTY_WEEK_HINT };
/** The part of the ScrollView instance we use (RN's typings expose it awkwardly). */
type ScrollHandle = { scrollTo(options: { x?: number; y?: number; animated?: boolean }): void };

export const LOAD_ERROR_MESSAGE = "Couldn't load your week. Pull down to try again.";

export function WeekViewScreen({ navigation }: RootScreenProps<'WeekView'>): React.JSX.Element {
  const { repos, notifications, sync, review, clock } = useAppServices();
  const { theme } = useTheme();
  const styles = useThemedStyles(createStyles);
  const [view, setView] = useState<WeekView | null>(null);
  const [grid, setGrid] = useState<WeekGrid | null>(null);
  const [selectedEvent, setSelectedEvent] = useState<GridItem | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const mounted = useRef(true);
  const pulling = useRef(false);
  const loadSeq = useRef(0);
  const scrollRef = useRef<ScrollHandle>(null);
  const scrolled = useRef(false);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  /** Read the local documents and rebuild the view model. The latest call wins. */
  const reload = useCallback(async () => {
    const seq = ++loadSeq.current;
    try {
      const now = clock.now();
      const weekId = review.currentWeekId();
      const [blocks, cache, syncState, indicators] = await Promise.all([
        repos.blocks.get(weekId),
        repos.calendarCache.get(weekId),
        repos.syncState.get(),
        notifications.indicators(now),
      ]);
      if (!mounted.current || seq !== loadSeq.current) return;
      const nextView = buildWeekView({ now, blocks, cache, syncState, indicators });
      setView(nextView);
      setGrid(buildWeekGrid(nextView, now));
      setLoadError(false);
    } catch {
      if (mounted.current && seq === loadSeq.current) setLoadError(true);
    }
  }, [clock, notifications, repos, review]);

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
    try {
      await sync.sync('pull');
    } catch {
      // The service records failures in syncState; the banner shows them.
    }
    await reload();
    pulling.current = false;
    if (mounted.current) setRefreshing(false);
  }, [reload, sync]);

  const onDismissBanner = useCallback(async () => {
    try {
      await sync.dismissBanner();
    } catch {
      // Keep the banner; the user can try again.
    }
    await reload();
  }, [reload, sync]);

  const openItem = useCallback(
    (item: GridItem) => {
      if (item.kind === 'block') {
        // Continuation segments of multi-day blocks carry a "#cont" suffix.
        if (view) navigation.navigate('BlockDetail', { blockId: item.id.replace(/#cont$/, ''), weekId: view.weekId });
      } else {
        setSelectedEvent(item);
      }
    },
    [navigation, view],
  );

  /** Scroll to the initial position once, after the grid has been laid out. */
  const onContentSizeChange = useCallback(() => {
    if (!grid || scrolled.current) return;
    scrolled.current = true;
    scrollRef.current?.scrollTo({ y: minToY(grid.initialScrollMin), animated: false });
  }, [grid]);

  const empty = grid ? grid.days.every((d) => d.items.length === 0) : false;

  return (
    <View style={styles.container} testID="week-screen">
      {view?.banner ? (
        <View style={styles.banner} testID="sync-banner">
          <Text accessibilityRole="alert" accessibilityLiveRegion="polite" style={styles.bannerText}>
            {view.banner.message}
          </Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Dismiss sync error"
            onPress={onDismissBanner}
            style={({ pressed }) => [styles.bannerButton, pressed && styles.pressed]}
            testID="sync-banner-dismiss"
          >
            <Text style={styles.bannerButtonText}>Dismiss</Text>
          </Pressable>
        </View>
      ) : null}

      <View style={styles.top}>
        <View style={styles.actions}>
          <NavButton label="Plan your week" onPress={() => navigation.navigate('Intake')} testID="open-intake" />
          <NavButton label="Saturday review" onPress={() => navigation.navigate('SaturdayReview')} testID="open-review" />
          <NavButton label="Settings" onPress={() => navigation.navigate('Settings')} testID="open-settings" />
        </View>

        {loadError ? (
          <Text accessibilityRole="alert" style={styles.error} testID="week-load-error">
            {LOAD_ERROR_MESSAGE}
          </Text>
        ) : null}

        {view ? (
          <>
            <Text accessibilityRole="header" style={styles.range}>
              {view.rangeLabel}
            </Text>
            <Text style={styles.lastSynced} testID="last-synced">
              {view.lastSynced ? view.lastSynced.label : 'Not synced yet'}
            </Text>
          </>
        ) : null}
      </View>

      {grid ? <DayHeader days={grid.days} /> : null}

      <ScrollView
        ref={scrollRef as React.Ref<never>}
        testID="screen-WeekView"
        style={styles.scroll}
        onContentSizeChange={onContentSizeChange}
        refreshControl={
          <RefreshControl
            testID="week-refresh"
            tintColor={theme.outline}
            colors={[theme.outline]}
            progressBackgroundColor={theme.surface}
            refreshing={refreshing}
            onRefresh={onRefresh}
            accessibilityLabel="Pull to sync with Google Calendar"
          />
        }
      >
        {grid ? (
          <View style={styles.grid} testID="week-grid">
            <HourGutter />
            {grid.days.map((day) => (
              <GridColumn
                key={day.dateKey}
                day={day}
                nowTopMin={grid.nowLine?.dayKey === day.dateKey ? grid.nowLine.topMin : undefined}
                onPressItem={openItem}
              />
            ))}
            {empty ? (
              <View
                pointerEvents="none"
                style={[styles.emptyWrap, { top: minToY(grid.initialScrollMin) + 24 }]}
                testID="week-empty"
              >
                <Text style={styles.empty}>{EMPTY_WEEK_HINT}</Text>
              </View>
            ) : null}
          </View>
        ) : loadError ? null : (
          <ActivityIndicator color={theme.outline} style={styles.loading} accessibilityLabel="Loading your week" testID="week-loading" />
        )}
      </ScrollView>

      {selectedEvent ? (
        <View style={styles.panel} accessibilityViewIsModal testID="event-panel">
          <Text accessibilityRole="header" style={styles.panelTitle}>
            {selectedEvent.title}
          </Text>
          <Text style={styles.panelTime}>{selectedEvent.timeLabel}</Text>
          <Text style={styles.panelKind}>Calendar event</Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Close"
            onPress={() => setSelectedEvent(null)}
            style={({ pressed }) => [styles.navButton, styles.panelClose, pressed && styles.pressed]}
            testID="event-panel-close"
          >
            <Text style={styles.navButtonText}>Close</Text>
          </Pressable>
        </View>
      ) : null}
    </View>
  );
}

function NavButton({ label, onPress, testID }: { label: string; onPress: () => void; testID: string }) {
  const styles = useThemedStyles(createStyles);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      style={({ pressed }) => [styles.navButton, pressed && styles.pressed]}
      testID={testID}
    >
      <Text style={styles.navButtonText}>{label}</Text>
    </Pressable>
  );
}

const createStyles = (theme: Theme) => StyleSheet.create({
  container: { flex: 1, backgroundColor: theme.background },
  top: { paddingHorizontal: 16, paddingTop: 8 },
  scroll: { flex: 1 },
  grid: { flexDirection: 'row', height: GRID_HEIGHT },
  banner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    margin: 12,
    padding: 12,
    borderRadius: 8,
    backgroundColor: theme.surface,
    borderWidth: 1,
    borderColor: theme.danger,
  },
  bannerText: { flex: 1, fontSize: 15, color: theme.danger, fontWeight: '600' },
  bannerButton: { minHeight: 48, minWidth: 48, justifyContent: 'center', paddingHorizontal: 12 },
  bannerButtonText: { fontSize: 15, fontWeight: '600', color: theme.text },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 8 },
  navButton: {
    minHeight: 48,
    justifyContent: 'center',
    paddingHorizontal: 16,
    borderRadius: 24,
    backgroundColor: theme.primary,
  },
  navButtonText: { fontSize: 15, fontWeight: '600', color: theme.onPrimary },
  pressed: { opacity: 0.8 },
  error: { marginBottom: 8, fontSize: 15, color: theme.danger, fontWeight: '600' },
  range: { fontSize: 20, fontWeight: '700', color: theme.text },
  lastSynced: { marginTop: 2, marginBottom: 8, fontSize: 14, color: theme.textMuted },
  emptyWrap: { position: 'absolute', left: 44, right: 0, alignItems: 'center', paddingHorizontal: 24 },
  empty: {
    fontSize: 14,
    color: theme.textMuted,
    textAlign: 'center',
    backgroundColor: theme.surface,
    padding: 8,
    borderRadius: 8,
  },
  loading: { marginTop: 32 },
  panel: {
    padding: 16,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.border,
    backgroundColor: theme.surface,
    elevation: 8,
  },
  panelTitle: { fontSize: 18, fontWeight: '700', color: theme.text },
  panelTime: { marginTop: 4, fontSize: 15, color: theme.text },
  panelKind: { marginTop: 2, fontSize: 13, color: theme.textMuted },
  panelClose: { marginTop: 12, alignSelf: 'flex-start' },
});
