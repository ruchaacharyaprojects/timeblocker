import React from 'react';
import { StyleSheet, View } from 'react-native';
import type { GridDay, GridItem } from '@timeblocker/app-core';
import { GridBlock } from './GridBlock';
import { GRID_HEIGHT, HOURS_PER_DAY, HOUR_HEIGHT, minToY } from './constants';
import { useThemedStyles, type Theme } from '../../theme';

interface Props {
  day: GridDay;
  /** Minutes from midnight for the now-line, only set for today's column. */
  nowTopMin?: number;
  onPressItem: (item: GridItem) => void;
}

/** One day column: hour lines, a today tint, positioned items, and the now-line. */
export function GridColumn({ day, nowTopMin, onPressItem }: Props): React.JSX.Element {
  const styles = useThemedStyles(createStyles);
  const lines = Array.from({ length: HOURS_PER_DAY }, (_, h) => h);
  return (
    <View style={[styles.column, day.isToday && styles.today]} testID={`grid-day-${day.dateKey}`}>
      {lines.map((h) => (
        <View key={h} pointerEvents="none" style={[styles.hourLine, { top: h * HOUR_HEIGHT }]} />
      ))}
      {day.items.map((item) => (
        <GridBlock key={`${item.kind}:${item.id}`} item={item} onPress={onPressItem} />
      ))}
      {nowTopMin !== undefined ? (
        <View pointerEvents="none" style={[styles.nowLine, { top: minToY(nowTopMin) }]} testID="grid-now-line">
          <View style={styles.nowDot} />
        </View>
      ) : null}
    </View>
  );
}

const createStyles = (theme: Theme) => StyleSheet.create({
  column: {
    flex: 1,
    height: GRID_HEIGHT,
    borderLeftWidth: StyleSheet.hairlineWidth,
    borderLeftColor: theme.border,
  },
  today: { backgroundColor: theme.surface },
  hourLine: { position: 'absolute', left: 0, right: 0, height: StyleSheet.hairlineWidth, backgroundColor: theme.border },
  nowLine: { position: 'absolute', left: 0, right: 0, height: 2, marginTop: -1, backgroundColor: theme.danger },
  nowDot: { position: 'absolute', left: -4, top: -3, width: 8, height: 8, borderRadius: 4, backgroundColor: theme.danger },
});
