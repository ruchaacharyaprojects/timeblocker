import React from 'react';
import { Pressable, StyleSheet, Text } from 'react-native';
import type { GridItem } from '@timeblocker/app-core';
import { BELL_LABEL, ITEM_GAP, MIN_ITEM_HEIGHT, minToY } from './constants';

/** Absolute rectangle geometry for an item (percent-based horizontally). */
export function itemGeometry(item: Pick<GridItem, 'topMin' | 'heightMin' | 'lane' | 'laneCount'>) {
  const count = Math.max(1, item.laneCount);
  return {
    top: minToY(item.topMin),
    height: Math.max(MIN_ITEM_HEIGHT, minToY(item.heightMin) - ITEM_GAP),
    left: `${(item.lane / count) * 100}%` as `${number}%`,
    width: `${(1 / count) * 100}%` as `${number}%`,
  };
}

/** Short items get one title line; taller ones up to three. */
export const titleLines = (heightMin: number): number => (heightMin < 30 ? 1 : 3);

interface Props {
  item: GridItem;
  onPress: (item: GridItem) => void;
}

/** One block or calendar-event rectangle inside a day column. */
export function GridBlock({ item, onPress }: Props): React.JSX.Element {
  const { fill, border, borderStyle, text } = item.style;
  const label = item.indicator ? `${item.a11yLabel}, ${BELL_LABEL}` : item.a11yLabel;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={() => onPress(item)}
      style={({ pressed }) => [
        styles.item,
        itemGeometry(item),
        { backgroundColor: fill, borderColor: border, borderStyle },
        pressed && styles.pressed,
      ]}
      testID={`grid-item-${item.id}`}
    >
      <Text style={[styles.title, { color: text }]} numberOfLines={titleLines(item.heightMin)}>
        {item.indicator ? (
          <Text accessible={false} testID={`bell-${item.id}`}>
            🔔{' '}
          </Text>
        ) : null}
        {item.title}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  item: { position: 'absolute', borderWidth: 1, borderRadius: 4, paddingHorizontal: 3, paddingVertical: 1, overflow: 'hidden' },
  title: { fontSize: 11, fontWeight: '600' },
  pressed: { opacity: 0.8 },
});
