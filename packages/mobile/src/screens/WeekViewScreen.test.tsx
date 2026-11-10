/**
 * WeekView screen tests (R11.7, R13.9, R14.2, R14.10, R16): the time grid
 * (day headers, hour gutter, positioned rectangles, lanes, now-line), category
 * colors, the distinct "Calendar" style, bell badges, banner dismissal,
 * pull-to-refresh calling sync, "Last synced", and navigation. Rendered
 * through the real `RootNavigator` (signed in) with this screen as WeekView.
 */
import React from 'react';
import { Pressable, StyleSheet, Text } from 'react-native';
import { act, fireEvent, render, screen, within } from '@testing-library/react-native';
import {
  CALENDAR_EVENT_STYLE,
  SYNC_FAILED_PREFIX,
  categoryHex,
  type CalendarCache,
  type DeviceBlock,
  type SyncResult,
} from '@timeblocker/app-core';
import { RootNavigator } from '../navigation/RootNavigator';
import { LINKING } from '../navigation/linking';
import { PLACEHOLDER_SCREENS } from '../navigation/placeholders';
import type { RootScreenProps } from '../navigation/types';
import { AppServicesProvider } from '../services/AppServices';
import { TEST_NOW, createTestServices, type TestState } from '../services/testServices';
import { BELL_LABEL, EMPTY_WEEK_HINT, LOAD_ERROR_MESSAGE, WeekViewScreen } from './WeekViewScreen';
import { HOUR_HEIGHT } from './weekGrid';

/** Open straight on the week view (the dashboard sits under it). */
const WEEK_LINKING = { ...LINKING, getInitialURL: () => Promise.resolve('timeblocker://week') };

jest.mock('react-native-safe-area-context', () => require('react-native-safe-area-context/jest/mock').default);

/** Toronto week containing TEST_NOW (Wed 2025-01-08). */
const WEEK_ID = '2025-01-05';

function block(overrides: Partial<DeviceBlock> = {}): DeviceBlock {
  return {
    id: 'b1',
    itemId: 'i1',
    title: 'Leg day',
    start: '2025-01-08T14:00:00-05:00',
    end: '2025-01-08T15:00:00-05:00',
    category: 'fitness',
    status: 'scheduled',
    weekId: WEEK_ID,
    calendarEventId: 'evb1',
    calendarSynced: true,
    promptedMeetingIds: [],
    usagePrompted: false,
    updatedAt: TEST_NOW,
    ...overrides,
  };
}

const cache: CalendarCache = {
  syncedAt: TEST_NOW,
  events: [
    {
      id: 'e1',
      summary: 'Team standup',
      start: '2025-01-09T09:00:00-05:00',
      end: '2025-01-09T09:30:00-05:00',
      withOthers: true,
      isBlock: false,
    },
  ],
};

type Services = ReturnType<typeof createTestServices>;

/** BlockDetail stand-in with a JS back button (the native-stack header has none in Jest). */
function DetailWithBack({ navigation, route }: RootScreenProps<'BlockDetail'>) {
  return (
    <Pressable accessibilityRole="button" accessibilityLabel="Back" onPress={() => navigation.goBack()} testID="screen-BlockDetail">
      <Text>{JSON.stringify(route.params)}</Text>
    </Pressable>
  );
}

async function renderWeek(seed: Partial<TestState> = {}, configure?: (services: Services) => void) {
  const services = createTestServices({
    authState: { status: 'signed-in' },
    blocks: {
      [WEEK_ID]: [
        block(),
        block({
          id: 'b2',
          title: 'Deep work',
          category: 'work',
          start: '2025-01-10T10:00:00-05:00',
          end: '2025-01-10T11:00:00-05:00',
        }),
      ],
    },
    calendarCache: { [WEEK_ID]: cache },
    ...seed,
  });
  configure?.(services);
  await render(
    <AppServicesProvider services={services}>
      <RootNavigator authState={services.authState} screens={{ ...PLACEHOLDER_SCREENS, WeekView: WeekViewScreen, BlockDetail: DetailWithBack }} linking={WEEK_LINKING} />
    </AppServicesProvider>,
  );
  await screen.findByTestId('week-grid');
  await screen.findAllByRole('button', { name: /Scheduled|Calendar event/ });
  return services;
}

const flat = (testID: string) => StyleSheet.flatten(screen.getByTestId(testID).props.style);

/** The ScrollView's `RefreshControl` props (the jest ScrollView mock passes it through). */
const refreshControl = (): { refreshing: boolean; onRefresh: () => Promise<void> } =>
  screen.getByTestId('screen-WeekView').props.refreshControl.props;
const pull = () => act(async () => void refreshControl().onRefresh());

describe('WeekViewScreen', () => {
  it('renders seven day headers with today marked, and hour labels', async () => {
    await renderWeek();
    expect(screen.getByTestId('week-grid')).toBeTruthy();
    const headers = screen.getAllByRole('header').filter((h) => /^grid-header-/.test(h.props.testID ?? ''));
    expect(headers).toHaveLength(7);
    expect(screen.getByTestId('grid-header-2025-01-05')).toHaveProp('accessibilityLabel', expect.stringMatching(/^Sun/));
    expect(screen.getByTestId('grid-header-2025-01-08').props.accessibilityLabel).toMatch(/, Today$/);
    expect(screen.getByTestId('grid-header-2025-01-09').props.accessibilityLabel).not.toMatch(/Today/);
    expect(screen.getAllByTestId('grid-today-badge')).toHaveLength(1);
    expect(screen.getByTestId('grid-hour-1')).toHaveTextContent('1 AM');
    expect(screen.getByTestId('grid-hour-12')).toHaveTextContent('12 PM');
    expect(screen.getByTestId('grid-hour-23')).toHaveTextContent('11 PM');
    expect(screen.queryByTestId('grid-hour-0')).toBeNull();
    for (const key of ['2025-01-05', '2025-01-08', '2025-01-11']) expect(screen.getByTestId(`grid-day-${key}`)).toBeTruthy();
  });

  it('positions rectangles by time and fills blocks with the category color (R11.7)', async () => {
    await renderWeek();
    const b1 = flat('grid-item-b1');
    expect(b1.position).toBe('absolute');
    expect(b1.top).toBe((14 * 60 * HOUR_HEIGHT) / 60);
    expect(b1.height).toBe(HOUR_HEIGHT - 2);
    expect(b1.left).toBe('0%');
    expect(b1.width).toBe('100%');
    expect(b1.backgroundColor).toBe(categoryHex('fitness'));
    expect(flat('grid-item-b2').backgroundColor).toBe(categoryHex('work'));
    expect(screen.getByTestId('grid-item-b1')).toHaveTextContent('Leg day');
    expect(screen.getByRole('button', { name: /^Leg day, .*Fitness.*Scheduled/ })).toBeTruthy();
  });

  it('draws other calendar events in the distinct dashed style (R11.7)', async () => {
    await renderWeek();
    const style = flat('grid-item-e1');
    expect(style.backgroundColor).toBe(CALENDAR_EVENT_STYLE.fill);
    expect(style.borderStyle).toBe('dashed');
    expect(style.borderColor).toBe(CALENDAR_EVENT_STYLE.border);
    expect(style.top).toBe(9 * HOUR_HEIGHT);
    expect(style.height).toBe(HOUR_HEIGHT / 2 - 2);
    expect(screen.getByLabelText(/^Team standup, .*Calendar event/)).toBeTruthy();
  });

  it('splits overlapping items into side-by-side lanes', async () => {
    await renderWeek({
      blocks: {
        [WEEK_ID]: [block(), block({ id: 'b3', title: 'Stretch', start: '2025-01-08T14:30:00-05:00', end: '2025-01-08T15:30:00-05:00' })],
      },
    });
    expect(flat('grid-item-b1')).toMatchObject({ left: '0%', width: '50%' });
    expect(flat('grid-item-b3')).toMatchObject({ left: '50%', width: '50%' });
  });

  it('shows the now-line only in today\'s column', async () => {
    await renderWeek();
    const lines = screen.getAllByTestId('grid-now-line');
    expect(lines).toHaveLength(1);
    expect(flat('grid-now-line').top).toBe((10 * 60 * HOUR_HEIGHT) / 60);
    expect(within(screen.getByTestId('grid-day-2025-01-08')).getByTestId('grid-now-line')).toBeTruthy();
    expect(within(screen.getByTestId('grid-day-2025-01-09')).queryByTestId('grid-now-line')).toBeNull();
  });

  it('shows bell badges with accessible text from the indicators (R13.9)', async () => {
    await renderWeek({}, (services) =>
      services.notifications.indicators.mockResolvedValue({ denied: true, blockIds: ['b1'], meetingIds: ['e1'] }),
    );
    expect(screen.getByTestId('bell-b1')).toBeTruthy();
    expect(screen.getByTestId('bell-e1')).toBeTruthy();
    expect(screen.queryByTestId('bell-b2')).toBeNull();
    expect(screen.getByLabelText(new RegExp(`^Leg day, .*${BELL_LABEL}$`))).toBeTruthy();
    expect(screen.getByLabelText(new RegExp(`^Team standup, .*${BELL_LABEL}$`))).toBeTruthy();
  });

  it('shows no badges while notifications are allowed', async () => {
    await renderWeek();
    expect(screen.queryByTestId('bell-b1')).toBeNull();
    expect(screen.queryByLabelText(new RegExp(BELL_LABEL))).toBeNull();
  });

  it('exposes rectangles to screen readers in time order within a day', async () => {
    await renderWeek({
      blocks: {
        [WEEK_ID]: [
          block({ id: 'late', title: 'Late one', start: '2025-01-08T18:00:00-05:00', end: '2025-01-08T19:00:00-05:00' }),
          block({ id: 'early', title: 'Early one', start: '2025-01-08T08:00:00-05:00', end: '2025-01-08T09:00:00-05:00' }),
        ],
      },
    });
    const day = screen.getByTestId('grid-day-2025-01-08');
    const ids = within(day)
      .getAllByRole('button')
      .map((n) => n.props.testID);
    expect(ids).toEqual(['grid-item-early', 'grid-item-late']);
  });

  it('shows a short hint, without blocking, when the week is empty', async () => {
    const services = createTestServices({ authState: { status: 'signed-in' }, blocks: {}, calendarCache: {} });
    await render(
      <AppServicesProvider services={services}>
        <RootNavigator authState={services.authState} screens={{ ...PLACEHOLDER_SCREENS, WeekView: WeekViewScreen }} linking={WEEK_LINKING} />
      </AppServicesProvider>,
    );
    expect(await screen.findByText(EMPTY_WEEK_HINT)).toBeTruthy();
    expect(screen.getByTestId('week-empty').props.pointerEvents).toBe('none');
    expect(screen.getByTestId('week-grid')).toBeTruthy();
  });

  it('does not show the hint when the week has items', async () => {
    await renderWeek();
    expect(screen.queryByText(EMPTY_WEEK_HINT)).toBeNull();
  });

  it('shows a dismissible banner naming the failed sync (R14.10)', async () => {
    const services = await renderWeek({
      syncState: { error: { message: 'network error', at: TEST_NOW - 1000, dismissed: false } },
    });
    expect(screen.getByRole('alert')).toHaveTextContent(`${SYNC_FAILED_PREFIX}: network error`);
    await act(async () => {
      fireEvent.press(screen.getByRole('button', { name: 'Dismiss sync error' }));
    });
    expect(services.sync.dismissBanner).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('sync-banner')).toBeNull();
    expect(screen.getByTestId('grid-item-b1')).toBeTruthy();
  });

  it('pull to refresh calls sync("pull"), reloads, and clears the spinner (R14.2, R14.10)', async () => {
    const services = await renderWeek({
      syncState: { error: { message: 'network error', at: TEST_NOW - 1000, dismissed: false } },
    });
    expect(screen.getByTestId('last-synced')).toHaveTextContent('Not synced yet');
    let finish: (r: SyncResult) => void = () => {};
    const done: SyncResult = { status: 'completed', trigger: 'pull', startedAt: TEST_NOW, finishedAt: TEST_NOW, report: { stepsRun: [] } };
    services.sync.sync.mockImplementationOnce(
      () =>
        new Promise<SyncResult>((resolve) => {
          finish = (r) => {
            services.state.syncState = { lastSuccessAt: TEST_NOW };
            resolve(r);
          };
        }),
    );
    await pull();
    expect(services.sync.sync).toHaveBeenCalledWith('pull');
    expect(refreshControl().refreshing).toBe(true);
    // A second pull while one runs does not start another sync.
    await pull();
    expect(services.sync.sync).toHaveBeenCalledTimes(1);

    await act(async () => finish(done));
    expect(refreshControl().refreshing).toBe(false);
    expect(screen.queryByTestId('sync-banner')).toBeNull();
    expect(screen.getByTestId('last-synced')).toHaveTextContent(/^Last synced /);
  });

  it('clears the spinner when the sync rejects', async () => {
    const services = await renderWeek();
    services.sync.sync.mockRejectedValueOnce(new Error('boom'));
    await pull();
    expect(services.sync.sync).toHaveBeenCalledWith('pull');
    expect(refreshControl().refreshing).toBe(false);
    expect(screen.getByTestId('grid-item-b1')).toBeTruthy();
  });

  it('opens BlockDetail with the block and week ids, and reloads on return', async () => {
    const services = await renderWeek();
    const loads = services.repos.blocks.get.mock.calls.length;
    await act(async () => {
      fireEvent.press(screen.getByTestId('grid-item-b1'));
    });
    const detail = await screen.findByTestId('screen-BlockDetail');
    expect(detail).toHaveTextContent(JSON.stringify({ blockId: 'b1', weekId: WEEK_ID }));

    services.state.blocks[WEEK_ID] = [block({ title: 'Leg day (moved)' })];
    await act(async () => {
      fireEvent.press(screen.getByRole('button', { name: 'Back' }));
    });
    expect(await screen.findByText('Leg day (moved)')).toBeTruthy();
    expect(services.repos.blocks.get.mock.calls.length).toBeGreaterThan(loads);
  });

  it('tapping a calendar event opens an inline panel that can be closed', async () => {
    await renderWeek();
    expect(screen.queryByTestId('event-panel')).toBeNull();
    await act(async () => {
      fireEvent.press(screen.getByTestId('grid-item-e1'));
    });
    const panel = screen.getByTestId('event-panel');
    expect(within(panel).getByText('Team standup')).toBeTruthy();
    expect(within(panel).getByText(/9:00/)).toBeTruthy();
    expect(screen.queryByTestId('screen-BlockDetail')).toBeNull();
    await act(async () => {
      fireEvent.press(screen.getByTestId('event-panel-close'));
    });
    expect(screen.queryByTestId('event-panel')).toBeNull();
  });

  it('shows the load error message and keeps the toolbar', async () => {
    const services = createTestServices({ authState: { status: 'signed-in' } });
    services.repos.blocks.get.mockRejectedValue(new Error('disk'));
    await render(
      <AppServicesProvider services={services}>
        <RootNavigator authState={services.authState} screens={{ ...PLACEHOLDER_SCREENS, WeekView: WeekViewScreen }} linking={WEEK_LINKING} />
      </AppServicesProvider>,
    );
    expect(await screen.findByText(LOAD_ERROR_MESSAGE)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Settings' })).toBeTruthy();
  });

  it.each([
    ['Plan your week', 'screen-Intake'],
    ['Saturday review', 'screen-SaturdayReview'],
    ['Settings', 'screen-Settings'],
  ])('"%s" opens %s', async (label, testID) => {
    await renderWeek();
    await act(async () => {
      fireEvent.press(screen.getByRole('button', { name: label }));
    });
    expect(await screen.findByTestId(testID)).toBeTruthy();
  });
});
