/**
 * Minimal stand-in screens used until tasks 24.2-24.8 provide the real ones.
 * Each renders its title as a header and has `testID="screen-<Route>"`.
 */
import React from 'react';
import { Text, View } from 'react-native';
import { useThemedStyles, type Theme } from '../theme';
import { ROUTE_TITLES, type RootRouteName, type RootScreenMap, type RootScreenProps } from './types';

function placeholder<Name extends RootRouteName>(name: Name): React.ComponentType<RootScreenProps<Name>> {
  function PlaceholderScreen({ route }: RootScreenProps<Name>): React.JSX.Element {
    const styles = useThemedStyles(makeStyles);
    const params = route.params as Record<string, unknown> | undefined;
    return (
      <View style={styles.container} testID={`screen-${name}`}>
        <Text accessibilityRole="header" style={styles.title}>
          {ROUTE_TITLES[name]}
        </Text>
        {params ? <Text style={styles.params}>{JSON.stringify(params)}</Text> : null}
      </View>
    );
  }
  PlaceholderScreen.displayName = `Placeholder(${name})`;
  return PlaceholderScreen;
}

export const PLACEHOLDER_SCREENS: RootScreenMap = {
  SignIn: placeholder('SignIn'),
  Dashboard: placeholder('Dashboard'),
  WeekView: placeholder('WeekView'),
  Intake: placeholder('Intake'),
  BlockDetail: placeholder('BlockDetail'),
  ApplicationHelper: placeholder('ApplicationHelper'),
  NothingFits: placeholder('NothingFits'),
  PlanSummary: placeholder('PlanSummary'),
  SaturdayReview: placeholder('SaturdayReview'),
  Settings: placeholder('Settings'),
};

const makeStyles = (theme: Theme) => ({
  container: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: theme.background, padding: 16 } as const,
  title: { fontSize: 22, fontWeight: '600', color: theme.text } as const,
  params: { marginTop: 8, fontSize: 14, color: theme.textMuted } as const,
});
