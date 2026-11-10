import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import type { GridDay } from '@timeblocker/app-core';
import { GUTTER_WIDTH } from './constants';
import { useThemedStyles, type Theme } from '../../theme';

/** Fixed row of seven day headers above the scrolling grid. */
export function DayHeader({ days }: { days: GridDay[] }): React.JSX.Element {
  const styles = useThemedStyles(createStyles);
  return (
    <View style={styles.row} testID="grid-day-headers">
      <View style={styles.gutter} />
      {days.map((day) => (
        <View
          key={day.dateKey}
          accessible
          accessibilityRole="header"
          accessibilityLabel={day.isToday ? `${day.label}, Today` : day.label}
          style={styles.cell}
          testID={`grid-header-${day.dateKey}`}
        >
          <Text style={[styles.weekday, day.isToday && styles.weekdayToday]}>{day.weekday}</Text>
          <View style={[styles.number, day.isToday && styles.numberToday]} testID={day.isToday ? 'grid-today-badge' : undefined}>
            <Text style={[styles.numberText, day.isToday && styles.numberTextToday]}>{day.dayOfMonth}</Text>
          </View>
        </View>
      ))}
    </View>
  );
}

const createStyles = (theme: Theme) => StyleSheet.create({
  row: {
    flexDirection: 'row',
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.border,
    backgroundColor: theme.background,
    paddingVertical: 4,
  },
  gutter: { width: GUTTER_WIDTH },
  cell: { flex: 1, alignItems: 'center' },
  weekday: { fontSize: 11, color: theme.textMuted, fontWeight: '600' },
  weekdayToday: { color: theme.outline },
  number: { width: 28, height: 28, borderRadius: 14, alignItems: 'center', justifyContent: 'center', marginTop: 2 },
  numberToday: { backgroundColor: theme.primary },
  numberText: { fontSize: 14, fontWeight: '600', color: theme.text },
  numberTextToday: { color: theme.onPrimary },
});
