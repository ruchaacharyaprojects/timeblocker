/**
 * SaturdayReview screen (design: "Navigation and screens"; R9.1-R9.4, R11.10,
 * R8.1).
 *
 * - On open it builds the current week's review with `review.build()` (which
 *   also persists un-happened workouts as missed, R8.1) and renders the pure
 *   `buildReviewView` model. A spinner shows while it runs; a failure shows an
 *   error with "Try again".
 * - Sections: Finished, Partly finished, Missed (R9.1); screen time and
 *   distraction level, with a note when usage access is denied (R9.2); what
 *   moved to next week and why (R9.3); the count of missed workouts; and the
 *   "Paste or type next week's list" button, which opens Intake (R9.4).
 * - Category is always shown as text next to its color swatch, so nothing
 *   relies on color alone. Touch targets are at least 48 dp.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import {
  buildReviewView,
  type MovedReviewItem,
  type ReviewItem,
  type ReviewUsageOutcome,
  type ReviewView,
} from '@timeblocker/app-core';
import type { RootScreenProps } from '../navigation/types';
import { useAppServices } from '../services/AppServices';
import { useTheme, useThemedStyles, type Theme } from '../theme';

export const REVIEW_LOADING_LABEL = 'Building your review';
export const REVIEW_ERROR_MESSAGE = "Couldn't build your review. Try again.";
export const USAGE_DENIED_NOTE =
  'Usage access is off, so screen time shows 0 min. Turn on usage access in Settings to see it.';
export const NOTHING_MOVED_TEXT = 'Nothing moved to next week.';
export const EMPTY_SECTION_TEXT = 'None';

type LoadState =
  | { kind: 'loading' }
  | { kind: 'error' }
  | { kind: 'ready'; view: ReviewView; usage: ReviewUsageOutcome };

export function SaturdayReviewScreen({ navigation }: RootScreenProps<'SaturdayReview'>): React.JSX.Element {
  const { review } = useAppServices();
  const { theme } = useTheme();
  const styles = useThemedStyles(createStyles);
  const [state, setState] = useState<LoadState>({ kind: 'loading' });
  const mounted = useRef(true);

  const load = useCallback(async () => {
    setState({ kind: 'loading' });
    let next: LoadState;
    try {
      const result = await review.build();
      next = { kind: 'ready', view: buildReviewView(result.weekId, result.review), usage: result.usage };
    } catch {
      next = { kind: 'error' };
    }
    if (mounted.current) setState(next);
  }, [review]);

  useEffect(() => {
    mounted.current = true;
    void load();
    return () => {
      mounted.current = false;
    };
  }, [load]);

  if (state.kind === 'loading') {
    return (
      <View style={styles.center} testID="screen-SaturdayReview">
        <ActivityIndicator size="large" color={theme.outline} accessibilityLabel={REVIEW_LOADING_LABEL} />
        <Text style={styles.muted}>{REVIEW_LOADING_LABEL}…</Text>
      </View>
    );
  }

  if (state.kind === 'error') {
    return (
      <View style={styles.center} testID="screen-SaturdayReview">
        <Text accessibilityRole="alert" accessibilityLiveRegion="assertive" style={styles.error}>
          {REVIEW_ERROR_MESSAGE}
        </Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Try again"
          onPress={() => void load()}
          style={({ pressed }) => [styles.secondaryButton, pressed && styles.secondaryButtonPressed]}
        >
          <Text style={styles.secondaryButtonText}>Try again</Text>
        </Pressable>
      </View>
    );
  }

  const { view, usage } = state;
  return (
    <ScrollView style={styles.scroll} contentContainerStyle={styles.content} testID="screen-SaturdayReview">
      <Text accessibilityRole="header" style={styles.title}>
        Saturday review
      </Text>
      <Text style={styles.muted}>{view.weekLabel}</Text>

      {view.sections.map((section) => (
        <View key={section.id} style={styles.section} testID={`review-section-${section.id}`}>
          <Text accessibilityRole="header" style={styles.sectionTitle}>
            {`${section.title} (${section.items.length})`}
          </Text>
          {section.items.length === 0 ? (
            <Text style={styles.muted}>{EMPTY_SECTION_TEXT}</Text>
          ) : (
            section.items.map((item) => <ReviewRow key={item.blockId} item={item} />)
          )}
        </View>
      ))}

      <View style={styles.section} testID="review-section-usage">
        <Text accessibilityRole="header" style={styles.sectionTitle}>
          Phone use
        </Text>
        <Text style={styles.body}>{`Screen time: ${view.screenTime?.label ?? '0 min'}`}</Text>
        <Text style={styles.body}>{`Distraction level: ${view.distractionLevel?.label ?? 'Not available'}`}</Text>
        {usage === 'permission-denied' ? (
          <Text style={styles.note} testID="review-usage-denied">
            {USAGE_DENIED_NOTE}
          </Text>
        ) : null}
      </View>

      <View style={styles.section} testID="review-section-moved">
        <Text accessibilityRole="header" style={styles.sectionTitle}>
          {`Moved to next week (${view.moved.length})`}
        </Text>
        {view.moved.length === 0 ? (
          <Text style={styles.muted}>{NOTHING_MOVED_TEXT}</Text>
        ) : (
          view.moved.map((item) => <ReviewRow key={item.blockId} item={item} />)
        )}
      </View>

      <View style={styles.section} testID="review-section-fitness">
        <Text style={styles.body}>{`Workouts missed: ${view.fitnessMissedCount}`}</Text>
      </View>

      <Pressable
        accessibilityRole="button"
        accessibilityLabel={view.nextWeekPrompt}
        accessibilityHint="Opens the paste box for next week's list"
        onPress={() => navigation.navigate('Intake')}
        style={({ pressed }) => [styles.button, pressed && styles.buttonPressed]}
        testID="review-next-week"
      >
        <Text style={styles.buttonText}>{view.nextWeekPrompt}</Text>
      </Pressable>
    </ScrollView>
  );
}

function ReviewRow({ item }: { item: ReviewItem | MovedReviewItem }): React.JSX.Element {
  const styles = useThemedStyles(createStyles);
  const reason = 'reason' in item ? item.reason : null;
  const label = [item.title, item.categoryLabel, item.whenLabel, reason ? `Why: ${reason}` : null]
    .filter(Boolean)
    .join(', ');
  return (
    <View accessible accessibilityLabel={label} style={styles.row} testID={`review-item-${item.blockId}`}>
      <View style={[styles.swatch, { backgroundColor: item.color }]} />
      <View style={styles.rowText}>
        <Text style={styles.rowTitle}>{item.title}</Text>
        <Text style={styles.muted}>{`${item.categoryLabel} · ${item.whenLabel}`}</Text>
        {reason ? <Text style={styles.body}>{`Why: ${reason}`}</Text> : null}
      </View>
    </View>
  );
}

const createStyles = (theme: Theme) => StyleSheet.create({
  scroll: { flex: 1, backgroundColor: theme.background },
  content: { padding: 16, paddingBottom: 32 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: theme.background, padding: 24, gap: 12 },
  title: { fontSize: 24, fontWeight: '700', color: theme.text },
  section: { marginTop: 20 },
  sectionTitle: { fontSize: 18, fontWeight: '600', color: theme.text, marginBottom: 8 },
  body: { fontSize: 16, color: theme.text, marginTop: 2 },
  muted: { fontSize: 14, color: theme.textMuted },
  note: { marginTop: 8, fontSize: 14, color: theme.text, fontStyle: 'italic' },
  error: { fontSize: 16, color: theme.danger, textAlign: 'center', fontWeight: '600' },
  row: { minHeight: 48, flexDirection: 'row', alignItems: 'center', paddingVertical: 6, gap: 12 },
  swatch: { width: 12, alignSelf: 'stretch', borderRadius: 4 },
  rowText: { flex: 1 },
  rowTitle: { fontSize: 16, fontWeight: '600', color: theme.text },
  button: {
    marginTop: 28,
    minHeight: 48,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 24,
    paddingHorizontal: 24,
    backgroundColor: theme.primary,
  },
  buttonPressed: { opacity: 0.8 },
  buttonText: { fontSize: 16, fontWeight: '600', color: theme.onPrimary },
  secondaryButton: {
    minHeight: 48,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 24,
    borderWidth: 1,
    borderColor: theme.outline,
    paddingHorizontal: 24,
  },
  secondaryButtonPressed: { backgroundColor: theme.pressed },
  secondaryButtonText: { fontSize: 16, fontWeight: '600', color: theme.outline },
});
