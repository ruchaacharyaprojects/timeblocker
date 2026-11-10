/**
 * BlockDetail "Help me start" and saved notes (R34.1, R34.6): the pure
 * `shouldOfferHelp` rule, availability gating, navigation, and the Notes card.
 */
import React from 'react';
import { Text, View } from 'react-native';
import { fireEvent, render, screen } from '@testing-library/react-native';
import type { DeviceBlock } from '@timeblocker/app-core';
import { RootNavigator } from '../navigation/RootNavigator';
import { PLACEHOLDER_SCREENS } from '../navigation/placeholders';
import { LINKING } from '../navigation/linking';
import type { RootScreenMap, RootScreenProps } from '../navigation/types';
import { AppServicesProvider } from '../services/AppServices';
import { createTestServices, type TestState } from '../services/testServices';
import { BlockDetailScreen, shouldOfferHelp } from './BlockDetailScreen';

jest.mock('react-native-safe-area-context', () => require('react-native-safe-area-context/jest/mock').default);

const WEEK = '2025-01-05';
const block = (overrides: Partial<DeviceBlock> = {}): DeviceBlock => ({
  id: 'b1',
  itemId: 'item-b1',
  title: 'Groceries',
  start: '2025-01-09T14:00:00.000Z',
  end: '2025-01-09T15:00:00.000Z',
  category: 'misc',
  status: 'scheduled',
  weekId: WEEK,
  calendarEventId: 'evtb10000',
  calendarSynced: true,
  promptedMeetingIds: [],
  usagePrompted: false,
  updatedAt: 0,
  ...overrides,
});

function StubHelper({ route }: RootScreenProps<'ApplicationHelper'>) {
  return (
    <View testID="screen-ApplicationHelper">
      <Text testID="helper-params">{JSON.stringify(route.params)}</Text>
    </View>
  );
}
const SCREENS: Partial<RootScreenMap> = { ...PLACEHOLDER_SCREENS, BlockDetail: BlockDetailScreen, ApplicationHelper: StubHelper };

async function renderDetail(b: DeviceBlock, seed: Partial<TestState> = {}) {
  const services = createTestServices({ authState: { status: 'signed-in' }, blocks: { [WEEK]: [b] }, aiAvailability: 'ready', ...seed });
  await render(
    <AppServicesProvider services={services}>
      <RootNavigator
        authState={services.authState}
        screens={SCREENS}
        linking={{ ...LINKING, getInitialURL: async () => 'timeblocker://block/b1' }}
      />
    </AppServicesProvider>,
  );
  await screen.findByTestId('block-title');
  return services;
}

describe('shouldOfferHelp', () => {
  it.each(['application', 'email', 'study'] as const)('is true for kind %s whatever the title', (kind) => {
    expect(shouldOfferHelp({ kind, title: 'Groceries' })).toBe(true);
  });
  it.each(['task', 'workout', 'errand', 'other', undefined] as const)('is false for kind %s with a plain title', (kind) => {
    expect(shouldOfferHelp({ kind, title: 'Groceries' })).toBe(false);
  });
  it.each([
    'Apply to Acme',
    'Job application',
    'Finish applications',
    'Email prof',
    'Send e-mail to Sam',
    'Draft memo',
    'WRITE report',
    'Outline essay',
    'Plan trip',
    'Cover letter for Acme',
    'Update resume',
  ])('is true for the title "%s"', (title) => {
    expect(shouldOfferHelp({ title })).toBe(true);
  });
  it.each(['Applesauce', 'Planet walk', 'Rewrite', 'Emailing', 'Go for a run'])('is false for the title "%s"', (title) => {
    expect(shouldOfferHelp({ title })).toBe(false);
  });
});

describe('BlockDetail: Help me start', () => {
  it('shows the button when AI is ready and the block qualifies, and opens the helper', async () => {
    await renderDetail(block({ kind: 'email' }));
    const button = screen.getByRole('button', { name: 'Help me start' });
    await fireEvent.press(button);
    expect(await screen.findByTestId('screen-ApplicationHelper')).toBeTruthy();
    expect(JSON.parse(screen.getByTestId('helper-params').props.children)).toEqual({ blockId: 'b1', weekId: WEEK });
  });
  it('matches by title when there is no kind', async () => {
    await renderDetail(block({ title: 'Apply to Acme' }));
    expect(screen.getByRole('button', { name: 'Help me start' })).toBeTruthy();
  });
  it.each(['disabled', 'not-configured'] as const)('is hidden when availability is %s', async (aiAvailability) => {
    await renderDetail(block({ kind: 'application' }), { aiAvailability });
    expect(screen.queryByRole('button', { name: 'Help me start' })).toBeNull();
  });
  it('is hidden for a block that does not qualify', async () => {
    await renderDetail(block());
    expect(screen.queryByRole('button', { name: 'Help me start' })).toBeNull();
  });
});

describe('BlockDetail: Notes card', () => {
  it('shows saved notes as selectable text', async () => {
    await renderDetail(block({ notes: 'Subject: Hi\n\nBody' }), { aiAvailability: 'disabled' });
    expect(screen.getByTestId('block-notes')).toBeTruthy();
    const text = screen.getByTestId('block-notes-text');
    expect(text.props.selectable).toBe(true);
    expect(text).toHaveTextContent(/Subject: Hi/);
  });
  it('has no Notes card without notes', async () => {
    await renderDetail(block());
    expect(screen.queryByTestId('block-notes')).toBeNull();
  });
});
