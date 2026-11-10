/**
 * Settings "AI assistant" section tests (R35.1, R34.2): the switch (disabled
 * when not configured), the privacy text, the read-only Service row, the
 * "Your Google ID" reveal and copy, and "About me for applications".
 */
import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { AI_HOST_SUFFIX } from '../config';
import { RootNavigator } from '../navigation/RootNavigator';
import { PLACEHOLDER_SCREENS } from '../navigation/placeholders';
import { LINKING } from '../navigation/linking';
import { AppServicesProvider } from '../services/AppServices';
import { ThemeProvider } from '../theme';
import { createTestServices, type TestState } from '../services/testServices';
import {
  AI_NOT_CONFIGURED_HINT,
  AI_PRIVACY_TEXT,
  AI_PROFILE_NOTE,
  AI_SUB_HELP,
  AI_SUB_UNAVAILABLE,
  SettingsScreen,
} from './SettingsScreen';

jest.mock('react-native-safe-area-context', () => require('react-native-safe-area-context/jest/mock').default);
let mockBaseUrl = '';
jest.mock('../config', () => ({
  ...jest.requireActual('../config'),
  get AI_API_BASE_URL() {
    return mockBaseUrl;
  },
}));
const mockCopy = jest.fn((_text: string) => true);
jest.mock('../clipboard', () => ({ copyText: (t: string) => mockCopy(t) }));

const linking = { ...LINKING, getInitialURL: () => Promise.resolve('timeblocker://settings') };
const screens = { ...PLACEHOLDER_SCREENS, Settings: SettingsScreen };

async function renderSettings(seed: Partial<TestState> = {}) {
  const services = createTestServices({ authState: { status: 'signed-in' }, ...seed });
  await render(
    <AppServicesProvider services={services}>
      <ThemeProvider>
        <RootNavigator authState={services.authState} screens={screens} linking={linking} />
      </ThemeProvider>
    </AppServicesProvider>,
  );
  await screen.findByTestId('ai-switch');
  return services;
}

beforeEach(() => {
  mockBaseUrl = '';
  mockCopy.mockClear();
});

describe('Settings: AI assistant', () => {
  it('disables the switch with the explanation when the service is not configured', async () => {
    const services = await renderSettings({ aiAvailability: 'not-configured' });
    const sw = screen.getByRole('switch', { name: 'AI assistant' });
    expect(sw).toBeDisabled();
    expect(screen.getByText(AI_NOT_CONFIGURED_HINT)).toBeTruthy();
    expect(screen.getByTestId('ai-service')).toHaveTextContent('Not configured');
    await fireEvent(sw, 'valueChange', true);
    expect(services.settings.setAiEnabled).not.toHaveBeenCalled();
  });

  it('shows the exact privacy text', async () => {
    await renderSettings();
    expect(AI_PRIVACY_TEXT).toBe(
      'Sends only the text you submit to your private AI service in Canada. Never your phone usage, sleep, or calendar.',
    );
    expect(screen.getByText(AI_PRIVACY_TEXT)).toBeTruthy();
  });

  it('toggling the switch calls setAiEnabled and re-reads availability', async () => {
    const services = await renderSettings({ aiAvailability: 'disabled' });
    const sw = screen.getByRole('switch', { name: 'AI assistant' });
    expect(sw).not.toBeDisabled();
    expect(screen.queryByText(AI_NOT_CONFIGURED_HINT)).toBeNull();
    await fireEvent(sw, 'valueChange', true);
    expect(services.settings.setAiEnabled).toHaveBeenCalledWith(true);
    expect(services.state.settings.aiEnabled).toBe(true);
    await waitFor(() => expect(screen.getByRole('switch', { name: 'AI assistant' })).toBeChecked());
    await fireEvent(screen.getByRole('switch', { name: 'AI assistant' }), 'valueChange', false);
    expect(services.settings.setAiEnabled).toHaveBeenLastCalledWith(false);
  });

  it('shows only the host of the configured service address', async () => {
    mockBaseUrl = `https://abc123xyz9${AI_HOST_SUFFIX}/prod`;
    await renderSettings({ aiAvailability: 'ready' });
    expect(screen.getByTestId('ai-service')).toHaveTextContent(`abc123xyz9${AI_HOST_SUFFIX}`);
    expect(screen.queryByText(/prod/)).toBeNull();
  });

  it('hides the Google ID until Show, then offers Copy and Hide', async () => {
    await renderSettings({ googleSub: '1234567890' });
    expect(screen.getByText(AI_SUB_HELP)).toBeTruthy();
    expect(screen.queryByText('1234567890')).toBeNull();
    await fireEvent.press(screen.getByRole('button', { name: 'Show Google ID' }));
    const id = screen.getByTestId('ai-google-id');
    expect(id).toHaveTextContent('1234567890');
    expect(id.props.selectable).toBe(true);
    await fireEvent.press(screen.getByRole('button', { name: 'Copy Google ID' }));
    expect(mockCopy).toHaveBeenCalledWith('1234567890');
    expect(screen.getByText('Copied')).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: 'Hide Google ID' }));
    expect(screen.queryByText('1234567890')).toBeNull();
  });

  it('explains how to recover when no Google ID is available', async () => {
    await renderSettings({ googleSub: undefined });
    expect(screen.getByText(AI_SUB_UNAVAILABLE)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Show Google ID' })).toBeNull();
  });

  it('loads, saves and clears "About me for applications" with a live counter', async () => {
    const services = await renderSettings({ aiProfile: { background: 'I led a team', updatedAt: 1 } });
    const input = screen.getByTestId('ai-profile-input');
    expect(input.props.value).toBe('I led a team');
    expect(input.props.maxLength).toBe(3000);
    expect(screen.getByTestId('ai-profile-count')).toHaveTextContent('12/3000');
    expect(screen.getByText(AI_PROFILE_NOTE)).toBeTruthy();
    await fireEvent.changeText(input, 'I built a data pipeline');
    expect(screen.getByTestId('ai-profile-count')).toHaveTextContent('23/3000');
    await fireEvent.press(screen.getByRole('button', { name: 'Save About me' }));
    expect(services.aiProfile.save).toHaveBeenCalledWith('I built a data pipeline');
    expect(services.state.aiProfile?.background).toBe('I built a data pipeline');
    expect(await screen.findByText('Saved.')).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: 'Clear About me' }));
    expect(services.aiProfile.clear).toHaveBeenCalled();
    expect(services.state.aiProfile).toBeNull();
    await waitFor(() => expect(screen.getByTestId('ai-profile-input').props.value).toBe(''));
    expect(screen.getByTestId('ai-profile-count')).toHaveTextContent('0/3000');
  });
});
