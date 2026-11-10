import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { GRID_HEIGHT, GUTTER_WIDTH, HOURS_PER_DAY, HOUR_HEIGHT, hourLabel } from './constants';
import { useThemedStyles, type Theme } from '../../theme';

/** Left gutter with hour labels; the label sits on its hour line. */
export function HourGutter(): React.JSX.Element {
  const styles = useThemedStyles(createStyles);
  const hours = Array.from({ length: HOURS_PER_DAY }, (_, h) => h);
  return (
    <View style={styles.gutter} testID="grid-gutter">
      {hours.map((h) => (
        <View key={h} style={styles.slot}>
          {h > 0 ? (
            <Text style={styles.label} testID={`grid-hour-${h}`}>
              {hourLabel(h)}
            </Text>
          ) : null}
        </View>
      ))}
    </View>
  );
}

const createStyles = (theme: Theme) => StyleSheet.create({
  gutter: { width: GUTTER_WIDTH, height: GRID_HEIGHT },
  slot: { height: HOUR_HEIGHT },
  label: { fontSize: 10, color: theme.textMuted, textAlign: 'right', paddingRight: 4, marginTop: -6 },
});
