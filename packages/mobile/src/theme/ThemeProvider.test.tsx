/**
 * ThemeProvider tests (R26.2): system follows the phone's color scheme,
 * explicit modes win, changes persist through the settings port, and a
 * failing settings service falls back to light.
 */
import React from 'react';
import { StatusBar, Text } from 'react-native';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { AppServicesProvider } from '../services/AppServices';
import { createTestServices, type TestState } from '../services/testServices';
import { ThemeProvider, resolveTheme, useTheme, useThemedStyles } from './ThemeProvider';
import { darkTheme, lightTheme } from './tokens';

jest.mock('react-native/Libraries/Utilities/useColorScheme', () => ({ __esModule: true, default: jest.fn(() => 'light') }));
const scheme = (value: 'light' | 'dark' | null) => jest.requireMock<{ default: jest.Mock }>('react-native/Libraries/Utilities/useColorScheme').default.mockReturnValue(value);

function Probe(): React.JSX.Element {
  const { theme, mode, resolved, statusBarStyle, setMode } = useTheme();
  const styles = useThemedStyles((t) => ({ box: { backgroundColor: t.background } }));
  return (
    <>
      <Text testID="mode">{mode}</Text>
      <Text testID="resolved">{resolved}</Text>
      <Text testID="bar">{statusBarStyle}</Text>
      <Text testID="bg">{theme.background}</Text>
      <Text testID="styled" style={styles.box}>
        x
      </Text>
      <Text accessibilityRole="button" onPress={() => setMode('dark')} testID="set-dark">
        dark
      </Text>
      <Text accessibilityRole="button" onPress={() => setMode('light')} testID="set-light">
        light
      </Text>
      <Text accessibilityRole="button" onPress={() => setMode('system')} testID="set-system">
        system
      </Text>
    </>
  );
}

async function setup(seed: Partial<TestState> = {}) {
  const services = createTestServices(seed);
  await render(
    <AppServicesProvider services={services}>
      <ThemeProvider>
        <Probe />
      </ThemeProvider>
    </AppServicesProvider>,
  );
  return services;
}

const text = (id: string) => screen.getByTestId(id).props.children as string;

describe('resolveTheme', () => {
  it('uses explicit modes and the scheme for system', () => {
    expect(resolveTheme('light', 'dark')).toBe('light');
    expect(resolveTheme('dark', 'light')).toBe('dark');
    expect(resolveTheme('system', 'dark')).toBe('dark');
    expect(resolveTheme('system', 'light')).toBe('light');
    expect(resolveTheme('system', null)).toBe('light');
  });
});

describe('ThemeProvider', () => {
  let setBarStyle: jest.SpyInstance;
  beforeEach(() => {
    setBarStyle = jest.spyOn(StatusBar, 'setBarStyle').mockImplementation(() => {});
  });
  afterEach(() => {
    setBarStyle.mockRestore();
    jest.resetAllMocks();
  });

  it('defaults to system and follows a light phone', async () => {
    scheme('light');
    await setup();
    expect(text('mode')).toBe('system');
    expect(text('resolved')).toBe('light');
    expect(text('bg')).toBe(lightTheme.background);
  });

  it('system follows a dark phone', async () => {
    scheme('dark');
    await setup();
    expect(text('resolved')).toBe('dark');
    expect(text('bg')).toBe(darkTheme.background);
    expect(text('bar')).toBe('light-content');
    expect(setBarStyle).toHaveBeenLastCalledWith('light-content', true);
  });

  it('uses a stored explicit mode regardless of the phone', async () => {
    scheme('dark');
    await setup({ settings: { planningMode: 'spread', holidays: [], distractionApps: [], themeMode: 'light' } });
    expect(text('mode')).toBe('light');
    expect(text('resolved')).toBe('light');
    expect(text('bar')).toBe('dark-content');
    expect(setBarStyle).toHaveBeenLastCalledWith('dark-content', true);
  });

  it('applies a change immediately and saves it through the settings port', async () => {
    scheme('light');
    const services = await setup();
    await fireEvent.press(screen.getByTestId('set-dark'));
    expect(text('resolved')).toBe('dark');
    expect(screen.getByTestId('styled')).toHaveStyle({ backgroundColor: darkTheme.background });
    expect(services.settings.setThemeMode).toHaveBeenCalledWith('dark');
    expect(services.state.settings.themeMode).toBe('dark');
    await fireEvent.press(screen.getByTestId('set-system'));
    expect(text('resolved')).toBe('light');
    expect(services.state.settings.themeMode).toBe('system');
  });

  it('restores the saved mode after a restart', async () => {
    scheme('light');
    const first = await setup();
    await fireEvent.press(screen.getByTestId('set-dark'));
    const saved = first.state.settings;
    await screen.unmount();
    await setup({ settings: saved });
    expect(text('mode')).toBe('dark');
    expect(text('resolved')).toBe('dark');
  });

  it('falls back to light when the settings service fails', async () => {
    scheme('dark');
    const services = createTestServices();
    services.settings.get.mockRejectedValue(new Error('disk'));
    await render(
      <AppServicesProvider services={services}>
        <ThemeProvider>
          <Probe />
        </ThemeProvider>
      </AppServicesProvider>,
    );
    await act(async () => {});
    expect(text('resolved')).toBe('light');
    expect(text('bg')).toBe(lightTheme.background);
  });

  it('keeps the chosen mode for the session when saving fails', async () => {
    scheme('light');
    const services = await setup();
    services.settings.setThemeMode.mockRejectedValueOnce(new Error('disk'));
    await fireEvent.press(screen.getByTestId('set-dark'));
    expect(text('resolved')).toBe('dark');
  });

  it('returns the light theme outside a provider', async () => {
    await render(<Probe />);
    expect(text('resolved')).toBe('light');
    expect(text('bg')).toBe(lightTheme.background);
  });
});
