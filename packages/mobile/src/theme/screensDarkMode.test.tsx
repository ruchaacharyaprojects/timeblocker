/**
 * Screens follow the theme (R26.1, R26.2): in dark mode the key screens take
 * their background and text colors from the dark tokens, and the navigator maps
 * the tokens onto the navigation theme (header, card, content background).
 */
import React from 'react';
import { StyleSheet } from 'react-native';
import { render, screen, waitFor } from '@testing-library/react-native';
import type { DeviceBlock } from '@timeblocker/app-core';
import { RootNavigator, toNavigationTheme } from '../navigation/RootNavigator';
import { LINKING } from '../navigation/linking';
import { PLACEHOLDER_SCREENS } from '../navigation/placeholders';
import { AppServicesProvider } from '../services/AppServices';
import { createTestServices, type TestState } from '../services/testServices';
import { BlockDetailScreen } from '../screens/BlockDetailScreen';
import { IntakeScreen } from '../screens/IntakeScreen';
import { SaturdayReviewScreen } from '../screens/SaturdayReviewScreen';
import { SignInScreen } from '../screens/SignInScreen';
import { WeekViewScreen } from '../screens/WeekViewScreen';
import { ThemeProvider } from './ThemeProvider';
import { darkTheme, lightTheme } from './tokens';

jest.mock('react-native-safe-area-context', () => require('react-native-safe-area-context/jest/mock').default);

const WEEK = '2025-01-05';
const block: DeviceBlock = {
  id: 'b1',
  itemId: 'item-b1',
  title: 'Write report',
  start: '2025-01-09T14:00:00.000Z',
  end: '2025-01-09T15:00:00.000Z',
  category: 'work',
  status: 'scheduled',
  weekId: WEEK,
  calendarEventId: 'evtb10000',
  calendarSynced: true,
  promptedMeetingIds: [],
  usagePrompted: false,
  updatedAt: 0,
};

async function renderAt(mode: 'light' | 'dark', url: string, seed: Partial<TestState> = {}) {
  const services = createTestServices({ authState: { status: 'signed-in' }, ...seed });
  services.state.settings = { ...services.state.settings, themeMode: mode };
  await render(
    <AppServicesProvider services={services}>
      <ThemeProvider>
        <RootNavigator
          authState={services.authState}
          screens={{
            ...PLACEHOLDER_SCREENS,
            Intake: IntakeScreen,
            WeekView: WeekViewScreen,
            BlockDetail: BlockDetailScreen,
            SaturdayReview: SaturdayReviewScreen,
            SignIn: SignInScreen,
          }}
          linking={{ ...LINKING, getInitialURL: () => Promise.resolve(url) }}
        />
      </ThemeProvider>
    </AppServicesProvider>,
  );
  return services;
}

const flat = (el: { props: { style?: unknown } }) => StyleSheet.flatten(el.props.style as never) as Record<string, unknown>;

describe('screens in dark mode', () => {
  it('Intake uses dark background, surface input, text and primary button colors', async () => {
    await renderAt('dark', 'timeblocker://intake');
    await screen.findByTestId('screen-Intake');
    // The provider reads the saved mode asynchronously.
    await waitFor(() => expect(flat(screen.getByTestId('screen-Intake')).backgroundColor).toBe(darkTheme.background));
    expect(flat(screen.getByTestId('intake-instruction')).color).toBe(darkTheme.text);
    expect(flat(screen.getByTestId('intake-input'))).toMatchObject({
      backgroundColor: darkTheme.surface,
      color: darkTheme.text,
    });
    expect(flat(screen.getByText('Submit')).color).toBe(darkTheme.onPrimary);
  });

  it('Intake stays light when the mode is light', async () => {
    await renderAt('light', 'timeblocker://intake');
    await screen.findByTestId('intake-instruction');
    expect(flat(screen.getByTestId('screen-Intake')).backgroundColor).toBe(lightTheme.background);
    expect(flat(screen.getByTestId('intake-instruction')).color).toBe(lightTheme.text);
  });

  it('WeekView grid chrome uses the dark tokens', async () => {
    await renderAt('dark', 'timeblocker://week');
    await screen.findByTestId('week-grid');
    await waitFor(() => expect(flat(screen.getByTestId('grid-hour-1')).color).toBe(darkTheme.textMuted));
  });

  it('BlockDetail uses dark text', async () => {
    await renderAt('dark', 'timeblocker://block/b1', { blocks: { [WEEK]: [block] } });
    await screen.findByTestId('block-title');
    await waitFor(() => expect(flat(screen.getByTestId('block-title')).color).toBe(darkTheme.text));
    expect(flat(screen.getByTestId('screen-BlockDetail')).backgroundColor).toBe(darkTheme.background);
  });

  it('SaturdayReview uses dark text', async () => {
    await renderAt('dark', 'timeblocker://review');
    await screen.findByRole('header', { name: 'Saturday review' });
    await waitFor(() => expect(flat(screen.getByRole('header', { name: 'Saturday review' })).color).toBe(darkTheme.text));
  });

  it('SignIn uses the dark background and text', async () => {
    await renderAt('dark', 'timeblocker://sign-in', { authState: { status: 'signed-out' } });
    const button = await screen.findByRole('button', { name: 'Sign in with Google' });
    expect(button).toBeTruthy();
    await waitFor(() => expect(flat(screen.getByTestId('screen-SignIn')).backgroundColor).toBe(darkTheme.background));
    expect(flat(screen.getByText('Sign in with Google')).color).toBe(darkTheme.onPrimary);
  });
});

describe('navigation theme', () => {
  it('maps tokens to the navigation theme in light and dark', () => {
    for (const [dark, theme] of [
      [false, lightTheme],
      [true, darkTheme],
    ] as const) {
      const nav = toNavigationTheme(theme, dark);
      expect(nav.dark).toBe(dark);
      expect(nav.colors).toEqual({
        primary: theme.outline,
        background: theme.background,
        card: theme.background,
        text: theme.text,
        border: theme.border,
        notification: theme.danger,
      });
    }
  });

  it('placeholder screens take the themed background in dark mode', async () => {
    await renderAt('dark', 'timeblocker://settings');
    await screen.findByTestId('screen-Settings');
    await waitFor(() => expect(flat(screen.getByTestId('screen-Settings')).backgroundColor).toBe(darkTheme.background));
  });
});
