/**
 * Dashboard screen tests (R18.1, R18.5, R18.6, R26.4, R27): greeting
 * variants, four widget cards with accessible labels, great vs normal card
 * colors, the Important deadlines block, navigation buttons, pull to refresh
 * (sync then reload), reload on focus and on app foreground, the load error,
 * and dark mode. Rendered through the real `RootNavigator` (signed in) with this
 * screen as Dashboard.
 */
import React from 'react';
import { AppState, Pressable, Text } from 'react-native';
import { act, fireEvent, render, screen, within } from '@testing-library/react-native';
import type { ImportantRow } from '@timeblocker/app-core';
import { RootNavigator } from '../navigation/RootNavigator';
import { PLACEHOLDER_SCREENS } from '../navigation/placeholders';
import type { RootScreenProps } from '../navigation/types';
import { AppServicesProvider } from '../services/AppServices';
import { ThemeProvider, darkTheme, lightTheme } from '../theme';
import { createTestServices, sampleDashboard, type TestState } from '../services/testServices';
import {
  DASHBOARD_LOADING_TEXT,
  DASHBOARD_LOAD_ERROR_MESSAGE,
  DASHBOARD_SYNC_NOTE,
  DashboardScreen,
} from './DashboardScreen';

jest.mock('react-native-safe-area-context', () => require('react-native-safe-area-context/jest/mock').default);

/** A stand-in for pushed screens with a JS back button (no native header in Jest). */
function backStub(name: string) {
  return function Stub({ navigation, route }: RootScreenProps<never>) {
    return (
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Back"
        onPress={() => (navigation as { goBack(): void }).goBack()}
        testID={`screen-${name}`}
      >
        <Text>{name}</Text>
        <Text testID={`params-${name}`}>{JSON.stringify(route.params ?? null)}</Text>
      </Pressable>
    );
  };
}

async function renderDashboard(seed: Partial<TestState> = {}) {
  const services = createTestServices({ authState: { status: 'signed-in' }, ...seed });
  await render(
    <AppServicesProvider services={services}>
      <ThemeProvider>
        <RootNavigator
          authState={services.authState}
          screens={{
            ...PLACEHOLDER_SCREENS,
            Dashboard: DashboardScreen,
            WeekView: backStub('WeekView'),
            Intake: backStub('Intake'),
            SaturdayReview: backStub('SaturdayReview'),
            Settings: backStub('Settings'),
            BlockDetail: backStub('BlockDetail'),
            PlanSummary: backStub('PlanSummary'),
          } as never}
        />
      </ThemeProvider>
    </AppServicesProvider>,
  );
  return services;
}

const HIDDEN = { includeHiddenElements: true } as const;

const refreshControl = (): { refreshing: boolean; onRefresh: () => Promise<void> } =>
  screen.getByTestId('screen-Dashboard').props.refreshControl.props;
const pull = () => act(async () => void refreshControl().onRefresh());

describe('DashboardScreen', () => {
  it('shows a loading text, then the greeting as a header and the message', async () => {
    const services = createTestServices({ authState: { status: 'signed-in' } });
    let finish!: () => void;
    services.dashboard.load.mockImplementationOnce(
      () => new Promise((resolve) => (finish = () => resolve(sampleDashboard()))),
    );
    await render(
      <AppServicesProvider services={services}>
        <RootNavigator authState={services.authState} screens={{ ...PLACEHOLDER_SCREENS, Dashboard: DashboardScreen }} />
      </AppServicesProvider>,
    );
    expect(await screen.findByText(DASHBOARD_LOADING_TEXT)).toBeTruthy();
    await act(async () => finish());
    expect(screen.queryByText(DASHBOARD_LOADING_TEXT)).toBeNull();
    const greeting = screen.getByRole('header', { name: 'Hi Sam!' });
    expect(greeting).toBeTruthy();
    expect(screen.getByTestId('dashboard-message')).toHaveTextContent(sampleDashboard().message);
  });

  it.each([
    ['Hi Sam!', 'Hi Sam!'],
    ['Hi there!', 'Hi there!'],
  ])('renders the greeting %s', async (greeting) => {
    await renderDashboard({ dashboard: sampleDashboard({ greeting }) });
    expect(await screen.findByRole('header', { name: greeting })).toBeTruthy();
  });

  it('renders four widget cards with value, label, caption and one accessibility label each', async () => {
    await renderDashboard();
    await screen.findByTestId('widget-tasks');
    for (const w of sampleDashboard().widgets) {
      const card = screen.getByTestId(`widget-${w.id}`);
      expect(card).toHaveProp('accessibilityLabel', w.a11yLabel);
      expect(card).toHaveProp('accessible', true);
      expect(within(card).getByText(w.value)).toBeTruthy();
      expect(within(card).getByText(w.label)).toBeTruthy();
      expect(within(card).getByText(w.caption)).toBeTruthy();
    }
    expect(screen.getByLabelText('Tasks completed: 50%. 2 of 4 done')).toBeTruthy();
  });

  it('shows the four cards with the designed values, labels and captions', async () => {
    await renderDashboard();
    await screen.findByTestId('widget-tasks');
    const expected = [
      ['tasks', '50%', 'Tasks completed', '2 of 4 done'],
      ['sleep', '7.4', 'Sleep score', 'Average of 3 nights'],
      ['fitness', '100%', 'Fitness score', '1 of 1 fitness task'],
      ['moved', '1', 'Moved tasks', 'moved to a new slot'],
    ] as const;
    for (const [id, value, label, caption] of expected) {
      expect(screen.getByTestId(`widget-value-${id}`)).toHaveTextContent(value);
      expect(screen.getByTestId(`widget-label-${id}`)).toHaveTextContent(label);
      expect(screen.getByTestId(`widget-caption-${id}`)).toHaveTextContent(caption);
    }
    // The sleep card has the sources on a second, smaller line and in its label.
    expect(screen.getByTestId('widget-source-sleep')).toHaveTextContent('Phone use only');
    expect(screen.getByTestId('widget-sleep')).toHaveProp(
      'accessibilityLabel',
      'Sleep score: 7.4. Average of 3 nights. Phone use only',
    );
    expect(screen.queryByTestId('widget-source-tasks')).toBeNull();
  });

  it('draws a colored round icon per card, hidden from screen readers', async () => {
    await renderDashboard();
    await screen.findByTestId('widget-tasks');
    const icons = { tasks: 'check', sleep: 'moon', fitness: 'run', moved: 'double-arrow' } as const;
    for (const [id, icon] of Object.entries(icons)) {
      const badge = screen.getByTestId(`widget-icon-${id}`, HIDDEN);
      expect(badge).toHaveStyle({ width: 44, height: 44, borderRadius: 22, backgroundColor: lightTheme.icons[icon].tint });
      expect(badge).toHaveProp('accessibilityElementsHidden', true);
      expect(badge).toHaveProp('importantForAccessibility', 'no-hide-descendants');
    }
  });

  it('a great card is dark green with yellow text; the others use the normal surface and text', async () => {
    await renderDashboard();
    await screen.findByTestId('widget-tasks');
    // sampleDashboard: fitness is great, tasks / sleep / moved are not.
    const fitness = screen.getByTestId('widget-fitness');
    expect(fitness).toHaveStyle({ backgroundColor: lightTheme.surfaceStrong });
    for (const part of ['value', 'label', 'caption']) {
      expect(screen.getByTestId(`widget-${part}-fitness`)).toHaveStyle({ color: lightTheme.great });
    }
    for (const id of ['tasks', 'sleep', 'moved']) {
      expect(screen.getByTestId(`widget-${id}`)).toHaveStyle({ backgroundColor: lightTheme.surface });
      expect(screen.getByTestId(`widget-value-${id}`)).toHaveStyle({ color: lightTheme.text });
      expect(screen.getByTestId(`widget-label-${id}`)).toHaveStyle({ color: lightTheme.text });
      expect(screen.getByTestId(`widget-caption-${id}`)).toHaveStyle({ color: lightTheme.textMuted });
    }
    // The icon badge is unchanged on a great card.
    expect(screen.getByTestId('widget-icon-fitness', HIDDEN)).toHaveStyle({ backgroundColor: lightTheme.icons.run.tint });
  });

  it('lays out the greeting and message with the designed type sizes', async () => {
    await renderDashboard();
    await screen.findByTestId('widget-tasks');
    expect(screen.getByTestId('dashboard-greeting')).toHaveStyle({ fontSize: 34, fontWeight: '700', color: lightTheme.text });
    expect(screen.getByTestId('dashboard-message')).toHaveStyle({ fontSize: 18, color: lightTheme.textMuted });
    expect(screen.getByTestId('widget-value-tasks')).toHaveStyle({ fontSize: 36 });
    expect(screen.getByTestId('widget-label-tasks')).toHaveStyle({ fontSize: 16 });
    expect(screen.getByTestId('widget-caption-tasks')).toHaveStyle({ fontSize: 14 });
    expect(screen.getByTestId('widget-tasks')).toHaveStyle({ borderRadius: 20, padding: 16 });
  });

  it('draws the Week calendar row filled and the other rows outlined', async () => {
    await renderDashboard();
    await screen.findByTestId('widget-tasks');
    expect(screen.getByTestId('open-week')).toHaveStyle({
      height: 52,
      borderRadius: 26,
      backgroundColor: lightTheme.primary,
    });
    for (const id of ['open-intake', 'open-review', 'open-settings']) {
      expect(screen.getByTestId(id)).toHaveStyle({ height: 52, borderRadius: 26, borderWidth: 2, borderColor: lightTheme.primary });
    }
  });

  describe('Important deadlines', () => {
    const row = (over: Partial<ImportantRow> = {}): ImportantRow => ({
      id: 'r1',
      title: 'Submit report',
      dueAt: '2025-01-10T22:00:00Z',
      dueLabel: 'Due Fri 5:00 PM',
      urgency: 'normal',
      target: { kind: 'block', blockId: 'b1', weekId: '2025-01-05' },
      ...over,
    });
    const withImportant = (rows: ImportantRow[], moreCount = 0) =>
      sampleDashboard({ important: { rows, moreCount } });

    it('shows the title and "No deadlines coming up" when empty', async () => {
      await renderDashboard();
      await screen.findByTestId('widget-tasks');
      const block = screen.getByTestId('dashboard-important');
      expect(within(block).getByRole('header', { name: 'Important deadlines' })).toBeTruthy();
      expect(screen.getByTestId('important-empty')).toHaveTextContent('No deadlines coming up');
      expect(screen.queryByTestId('important-more')).toBeNull();
      expect(block).toHaveProp('accessibilityLabel', 'Important deadlines: No deadlines coming up');
    });

    it('lists rows with a labelled button and urgency markers (never by color alone)', async () => {
      await renderDashboard({
        dashboard: withImportant([
          row({ id: 'a', title: 'Tax form', dueLabel: 'Overdue', urgency: 'overdue' }),
          row({ id: 'b', title: 'Call bank', dueLabel: 'Due today 5:00 PM', urgency: 'soon' }),
          row({ id: 'c', title: 'Submit report', dueLabel: 'Due Fri 5:00 PM', urgency: 'normal' }),
        ]),
      });
      await screen.findByTestId('important-row-a');
      expect(screen.getByRole('button', { name: 'Tax form, Overdue' })).toBeTruthy();
      expect(screen.getByRole('button', { name: 'Call bank, Due today 5:00 PM' })).toBeTruthy();
      expect(screen.getByRole('button', { name: 'Submit report, Due Fri 5:00 PM' })).toBeTruthy();
      expect(screen.getByTestId('important-dot-a', HIDDEN)).toHaveStyle({ backgroundColor: lightTheme.danger });
      expect(screen.getByTestId('important-dot-b', HIDDEN)).toHaveStyle({ backgroundColor: lightTheme.warning });
      expect(screen.getByTestId('important-dot-c', HIDDEN)).toHaveStyle({ backgroundColor: lightTheme.textMuted });
      expect(screen.queryByTestId('important-empty')).toBeNull();
      expect(screen.getByTestId('dashboard-important')).toHaveProp(
        'accessibilityLabel',
        'Important deadlines: Tax form, Overdue; Call bank, Due today 5:00 PM; Submit report, Due Fri 5:00 PM',
      );
    });

    it('shows "+N more" when there are more than the visible rows', async () => {
      await renderDashboard({ dashboard: withImportant([row()], 4) });
      await screen.findByTestId('important-row-r1');
      expect(screen.getByTestId('important-more')).toHaveTextContent('+4 more');
    });

    it('a block row opens BlockDetail', async () => {
      await renderDashboard({ dashboard: withImportant([row()]) });
      await fireEvent.press(await screen.findByRole('button', { name: 'Submit report, Due Fri 5:00 PM' }));
      expect(await screen.findByTestId('screen-BlockDetail')).toBeTruthy();
      expect(JSON.parse(String(screen.getByTestId('params-BlockDetail').props.children))).toEqual({
        blockId: 'b1',
        weekId: '2025-01-05',
      });
    });

    it('a summary row opens PlanSummary with the unplaced item', async () => {
      await renderDashboard({
        dashboard: withImportant([
          row({ id: 's1', title: 'Passport', dueLabel: 'Overdue', urgency: 'overdue', target: { kind: 'summary', weekId: '2025-01-05', itemId: 'item-9' } }),
        ]),
      });
      await fireEvent.press(await screen.findByRole('button', { name: 'Passport, Overdue' }));
      expect(await screen.findByTestId('screen-PlanSummary')).toBeTruthy();
      expect(JSON.parse(String(screen.getByTestId('params-PlanSummary').props.children))).toEqual({
        weekId: '2025-01-05',
        blockIds: [],
        unplacedItemIds: ['item-9'],
      });
    });
  });

  it('renders in the dark theme when the appearance is Dark', async () => {
    await renderDashboard({
      settings: { planningMode: 'spread', holidays: [], distractionApps: [], themeMode: 'dark' },
    });
    await screen.findByTestId('widget-tasks');
    expect(screen.getByTestId('screen-Dashboard')).toHaveStyle({ backgroundColor: darkTheme.background });
    expect(screen.getByTestId('dashboard-greeting')).toHaveStyle({ color: darkTheme.text });
    expect(screen.getByTestId('widget-tasks')).toHaveStyle({ backgroundColor: darkTheme.surface });
    expect(screen.getByTestId('widget-fitness')).toHaveStyle({ backgroundColor: darkTheme.surfaceStrong });
    expect(screen.getByTestId('widget-value-fitness')).toHaveStyle({ color: darkTheme.great });
    expect(screen.getByTestId('widget-icon-tasks', HIDDEN)).toHaveStyle({ backgroundColor: darkTheme.icons.check.tint });
    expect(screen.getByTestId('open-week')).toHaveStyle({ backgroundColor: darkTheme.primary });
  });

  it.each([
    ['Week calendar', 'WeekView'],
    ["Add this week's tasks", 'Intake'],
    ['Saturday review', 'SaturdayReview'],
    ['Settings', 'Settings'],
  ])('the %s button opens %s', async (label, route) => {
    await renderDashboard();
    await screen.findByTestId('widget-tasks');
    await fireEvent.press(screen.getByRole('button', { name: label }));
    expect(await screen.findByTestId(`screen-${route}`)).toBeTruthy();
  });

  it('pull to refresh runs a pull sync and then loads again', async () => {
    const services = await renderDashboard();
    await screen.findByTestId('widget-tasks');
    const loads = services.dashboard.load.mock.calls.length;
    await pull();
    expect(services.sync.sync).toHaveBeenCalledWith('pull');
    expect(services.dashboard.load.mock.calls.length).toBe(loads + 1);
    const syncOrder = services.sync.sync.mock.invocationCallOrder[0]!;
    const loadOrder = services.dashboard.load.mock.invocationCallOrder.at(-1)!;
    expect(syncOrder).toBeLessThan(loadOrder);
    expect(refreshControl().refreshing).toBe(false);
    expect(screen.queryByTestId('dashboard-sync-note')).toBeNull();
  });

  it('swallows a sync failure into a small note and still reloads', async () => {
    const services = await renderDashboard();
    await screen.findByTestId('widget-tasks');
    services.sync.sync.mockRejectedValueOnce(new Error('offline'));
    const loads = services.dashboard.load.mock.calls.length;
    await pull();
    expect(screen.getByTestId('dashboard-sync-note')).toHaveTextContent(DASHBOARD_SYNC_NOTE);
    expect(services.dashboard.load.mock.calls.length).toBe(loads + 1);
    expect(screen.getByTestId('widget-tasks')).toBeTruthy();
  });

  it('stops the spinner after 15 s when the sync never returns', async () => {
    jest.useFakeTimers();
    try {
      const services = await renderDashboard();
      await screen.findByTestId('widget-tasks');
      services.sync.sync.mockImplementationOnce(() => new Promise(() => {}));
      await act(async () => void refreshControl().onRefresh());
      expect(refreshControl().refreshing).toBe(true);
      await act(async () => {
        jest.advanceTimersByTime(15_000);
      });
      expect(refreshControl().refreshing).toBe(false);
      expect(screen.getByTestId('dashboard-sync-note')).toBeTruthy();
    } finally {
      jest.useRealTimers();
    }
  });

  it('reloads when returning to the screen (focus)', async () => {
    const services = await renderDashboard();
    await screen.findByTestId('widget-tasks');
    services.dashboard.load.mockResolvedValue(
      sampleDashboard({ widgets: sampleDashboard().widgets.map((w) => (w.id === 'moved' ? { ...w, value: '7' } : w)) }),
    );
    await fireEvent.press(screen.getByRole('button', { name: 'Settings' }));
    await screen.findByTestId('screen-Settings');
    await act(async () => {
      void fireEvent.press(screen.getByRole('button', { name: 'Back' }));
    });
    expect(await screen.findByText('7')).toBeTruthy();
  });

  it('reloads when the app becomes active', async () => {
    let listener: ((s: string) => void) | undefined;
    const spy = jest.spyOn(AppState, 'addEventListener').mockImplementation(((_: string, cb: (s: string) => void) => {
      listener = cb;
      return { remove: jest.fn() };
    }) as never);
    try {
      const services = await renderDashboard();
      await screen.findByTestId('widget-tasks');
      const loads = services.dashboard.load.mock.calls.length;
      await act(async () => listener?.('background'));
      expect(services.dashboard.load.mock.calls.length).toBe(loads);
      await act(async () => listener?.('active'));
      expect(services.dashboard.load.mock.calls.length).toBe(loads + 1);
    } finally {
      spy.mockRestore();
      // Jest's RN preset mocks AppState; restore a working subscription.
      jest.spyOn(AppState, 'addEventListener').mockImplementation((() => ({ remove: jest.fn() })) as never);
    }
  });

  it('shows the load error and recovers on the next pull', async () => {
    const services = createTestServices({ authState: { status: 'signed-in' } });
    services.dashboard.load.mockRejectedValueOnce(new Error('disk'));
    await render(
      <AppServicesProvider services={services}>
        <RootNavigator authState={services.authState} screens={{ ...PLACEHOLDER_SCREENS, Dashboard: DashboardScreen }} />
      </AppServicesProvider>,
    );
    expect(await screen.findByRole('alert')).toHaveTextContent(DASHBOARD_LOAD_ERROR_MESSAGE);
    expect(screen.queryByText(DASHBOARD_LOADING_TEXT)).toBeNull();
    await pull();
    expect(screen.queryByTestId('dashboard-load-error')).toBeNull();
    expect(screen.getByTestId('widget-tasks')).toBeTruthy();
  });

  describe('Show my name', () => {
    const anon = () => sampleDashboard({ greeting: 'Hi there!', hasName: false });
    const NAME_ERROR = "Couldn't update your name. Try again later.";

    it('is shown only with the fallback greeting, as a labelled button', async () => {
      await renderDashboard({ dashboard: anon() });
      const button = await screen.findByRole('button', { name: 'Show my name' });
      expect(button.props.accessibilityHint).toBe('Reconnect your Google account once to read your first name');
      expect(screen.getByText('Show my name')).toHaveStyle({ color: lightTheme.outline });
      expect(screen.queryByTestId('dashboard-name-error')).toBeNull();
    });

    it('is hidden when a name exists', async () => {
      await renderDashboard();
      await screen.findByTestId('widget-tasks');
      expect(screen.queryByTestId('dashboard-show-name')).toBeNull();
    });

    it('reconnects, reloads, and greets by name', async () => {
      const services = await renderDashboard({ dashboard: anon() });
      await screen.findByTestId('dashboard-show-name');
      let finish!: () => void;
      services.auth.reconnect.mockImplementationOnce(
        () => new Promise((resolve) => (finish = () => resolve({ ok: true, via: 'authorize' }))),
      );
      services.dashboard.load.mockResolvedValue(sampleDashboard({ greeting: 'Hi Rucha!', hasName: true }));
      await act(async () => void fireEvent.press(screen.getByTestId('dashboard-show-name')));
      expect(await screen.findByText('Connecting…')).toBeTruthy();
      expect(screen.getByTestId('dashboard-show-name').props.accessibilityState).toMatchObject({ busy: true });
      await act(async () => finish());
      expect(await screen.findByRole('header', { name: 'Hi Rucha!' })).toBeTruthy();
      expect(services.auth.reconnect).toHaveBeenCalledTimes(1);
      expect(screen.queryByTestId('dashboard-show-name')).toBeNull();
      expect(screen.queryByTestId('dashboard-name-error')).toBeNull();
    });

    it('shows a muted message and keeps the button when the user cancels', async () => {
      const services = await renderDashboard({ dashboard: anon() });
      await screen.findByTestId('dashboard-show-name');
      services.auth.reconnect.mockResolvedValueOnce({ ok: false, reason: 'incomplete', message: 'x' });
      const loads = services.dashboard.load.mock.calls.length;
      await act(async () => void fireEvent.press(screen.getByTestId('dashboard-show-name')));
      expect(await screen.findByTestId('dashboard-name-error')).toHaveTextContent(NAME_ERROR);
      expect(screen.getByTestId('dashboard-name-error')).toHaveStyle({ color: lightTheme.textMuted });
      expect(screen.getByRole('header', { name: 'Hi there!' })).toBeTruthy();
      expect(screen.getByTestId('dashboard-show-name')).toBeTruthy();
      expect(services.dashboard.load.mock.calls.length).toBe(loads);
      expect(services.auth.signOut).not.toHaveBeenCalled();
    });

    it('shows the message when reconnect throws', async () => {
      const services = await renderDashboard({ dashboard: anon() });
      await screen.findByTestId('dashboard-show-name');
      services.auth.reconnect.mockRejectedValueOnce(new Error('boom'));
      await act(async () => void fireEvent.press(screen.getByTestId('dashboard-show-name')));
      expect(await screen.findByTestId('dashboard-name-error')).toHaveTextContent(NAME_ERROR);
    });
  });
});
