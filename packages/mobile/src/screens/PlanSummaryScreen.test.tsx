/**
 * Plan summary tests (R21.1-R21.3, R22.3): header variants, the sorted added
 * list in Toronto time, the unplaced section with its two actions, the
 * next-week variant, the ignored sleep section, errors, and accessibility.
 * Rendered directly with a fake navigation prop.
 */
import React from 'react';
import { ToastAndroid } from 'react-native';
import { StyleSheet } from 'react-native';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import type { DeviceBlock, SetTimingResult } from '@timeblocker/app-core';
import type { IntakeItem } from '@timeblocker/flows';
import type { RootScreenProps } from '../navigation/types';
import { AppServicesProvider } from '../services/AppServices';
import { TEST_NOW, createTestServices, emptyPlanResult, type TestState } from '../services/testServices';
import { ThemeProvider } from '../theme/ThemeProvider';
import { darkTheme } from '../theme/tokens';
import {
  PLAN_SUMMARY_ACTION_ERROR,
  PLAN_SUMMARY_NEXT_WEEK_CAPTION,
  PlanSummaryScreen,
  blockWhen,
  summaryHeader,
  unplacedReasonText,
  weekRangeLabel,
} from './PlanSummaryScreen';

jest.mock('react-native-safe-area-context', () => require('react-native-safe-area-context/jest/mock').default);

const WEEK = '2025-01-05';
const NEXT_WEEK = '2025-01-12';

// 2025-01-10 is a Friday; January is EST (UTC-5), so 22:00Z is 5:00 PM Toronto.
const block = (id: string, title: string, startIso: string, endIso: string, category = 'work'): DeviceBlock =>
  ({
    id,
    itemId: `item-${id}`,
    title,
    start: startIso,
    end: endIso,
    category,
    status: 'scheduled',
    weekId: WEEK,
    calendarEventId: `ev${id}`,
    calendarSynced: true,
    promptedMeetingIds: [],
    usagePrompted: false,
    updatedAt: 0,
  }) as unknown as DeviceBlock;

const item = (id: string, text: string, durationMin: number): IntakeItem =>
  ({ id, text, durationMin, priority: 1, category: 'work', confirmed: true, weekId: WEEK }) as IntakeItem;

const FRI_5PM = block('b1', 'Write report', '2025-01-10T17:00:00-05:00', '2025-01-10T17:45:00-05:00');
const MON_9AM = block('b2', 'Gym', '2025-01-06T09:00:00-05:00', '2025-01-06T10:00:00-05:00', 'fitness');

type Params = RootScreenProps<'PlanSummary'>['route']['params'];

async function renderSummary(params: Partial<Params> = {}, seed: Partial<TestState> = {}, themed = false) {
  const services = createTestServices({ authState: { status: 'signed-in' }, ...seed });
  const navigation = { reset: jest.fn(), replace: jest.fn(), navigate: jest.fn() };
  const route = { key: 'k', name: 'PlanSummary', params: { weekId: WEEK, blockIds: [], unplacedItemIds: [], ...params } };
  const element = <PlanSummaryScreen {...({ navigation, route } as unknown as RootScreenProps<'PlanSummary'>)} />;
  await render(
    <AppServicesProvider services={services}>{themed ? <ThemeProvider>{element}</ThemeProvider> : element}</AppServicesProvider>,
  );
  return { services, navigation };
}

const press = async (name: string) => {
  await act(async () => {
    void fireEvent.press(screen.getByRole('button', { name }));
  });
};

const header = async () => (await screen.findByTestId('plan-summary-header')).props.children as string;

describe('summaryHeader', () => {
  it('covers each variant', () => {
    expect(summaryHeader(3, 0, false)).toBe('Added 3 tasks to this week');
    expect(summaryHeader(1, 2, false)).toBe('Added 1 task to this week');
    expect(summaryHeader(2, 0, true)).toBe('Added 2 tasks to next week');
    expect(summaryHeader(0, 2, false)).toBe('Nothing fits this week');
    expect(summaryHeader(0, 2, true)).toBe('Nothing fits next week either');
    expect(summaryHeader(0, 0, false)).toBe('Nothing to add');
  });
});

describe('blockWhen', () => {
  it('formats the Toronto day and time range', () => {
    expect(blockWhen(FRI_5PM)).toBe('Fri 5:00 PM – 5:45 PM');
  });
  it('uses Toronto time whatever the offset of the stored instant', () => {
    expect(blockWhen({ start: '2025-01-10T22:00:00Z', end: '2025-01-10T22:45:00Z' })).toBe('Fri 5:00 PM – 5:45 PM');
  });
});

describe('PlanSummaryScreen', () => {
  afterEach(() => jest.restoreAllMocks());

  it('lists every added task, sorted by start, with day, time range and category chip', async () => {
    await renderSummary(
      { blockIds: ['b1', 'b2'] },
      { blocks: { [WEEK]: [FRI_5PM, MON_9AM, block('other', 'Not mine', '2025-01-07T09:00:00-05:00', '2025-01-07T10:00:00-05:00')] } },
    );
    expect(await header()).toBe('Added 2 tasks to this week');
    const added = screen.getByTestId('plan-summary-added');
    const text = JSON.stringify(added.props.children ? screen.toJSON() : null);
    expect(text.indexOf('Gym')).toBeGreaterThan(-1);
    expect(text.indexOf('Gym')).toBeLessThan(text.indexOf('Write report'));
    expect(screen.queryByText('Not mine')).toBeNull();
    expect(screen.getByText('Mon 9:00 AM – 10:00 AM')).toBeTruthy();
    expect(screen.getByText('Fri 5:00 PM – 5:45 PM')).toBeTruthy();
    expect(screen.getByText('fitness')).toBeTruthy();
    expect(screen.queryByTestId('plan-summary-unplaced')).toBeNull();
    expect(screen.queryByText('Move these to next week')).toBeNull();
  });

  it('gives each row an accessibility label with title, time and category', async () => {
    await renderSummary({ blockIds: ['b1'] }, { blocks: { [WEEK]: [FRI_5PM] } });
    await header();
    expect(screen.getByLabelText('Write report, Fri 5:00 PM – 5:45 PM, work')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Write report, Fri 5:00 PM – 5:45 PM, work' })).toHaveProp(
      'accessibilityHint',
      'Change time',
    );
    expect(screen.getByTestId('plan-summary-header')).toHaveProp('accessibilityRole', 'header');
  });

  it('uses the singular for one task', async () => {
    await renderSummary({ blockIds: ['b1'] }, { blocks: { [WEEK]: [FRI_5PM] } });
    expect(await header()).toBe('Added 1 task to this week');
  });

  it('shows the unplaced section with minutes and both actions for a partial plan', async () => {
    await renderSummary(
      { blockIds: ['b1'], unplacedItemIds: ['i1', 'i2'] },
      { blocks: { [WEEK]: [FRI_5PM] }, items: { [WEEK]: [item('i1', 'Huge task', 150), item('i2', 'Another', 45), item('i3', 'Placed', 30)] } },
    );
    expect(await header()).toBe('Added 1 task to this week');
    expect(screen.getByText("Didn't fit this week")).toBeTruthy();
    expect(screen.getByText('Huge task')).toBeTruthy();
    expect(screen.getByText('2 h 30 min')).toBeTruthy();
    expect(screen.getByText('45 min')).toBeTruthy();
    expect(screen.queryByText('Placed')).toBeNull();
    expect(screen.getByLabelText('Huge task, 2 h 30 min')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Move these to next week' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Leave them out' })).toBeTruthy();
  });

  it('says "Nothing fits this week" when nothing was added but items are unplaced', async () => {
    await renderSummary({ unplacedItemIds: ['i1'] }, { items: { [WEEK]: [item('i1', 'Huge task', 600)] } });
    expect(await header()).toBe('Nothing fits this week');
    expect(screen.queryByTestId('plan-summary-added')).toBeNull();
    expect(screen.getByText('Huge task')).toBeTruthy();
  });

  it('says "Nothing to add" when there is nothing at all, and shows no caption', async () => {
    await renderSummary({});
    expect(await header()).toBe('Nothing to add');
    expect(screen.queryByTestId('plan-summary-unplaced')).toBeNull();
    expect(screen.queryByTestId('plan-summary-caption')).toBeNull();
    expect(screen.getByRole('button', { name: 'View my week' })).toBeTruthy();
  });

  it('shows skipped sleep lines in a muted section', async () => {
    await renderSummary({
      ignored: [
        { text: 'Sleep 8h', reason: 'sleep' },
        { text: 'Nap', reason: 'sleep' },
      ],
    });
    expect(await header()).toBe('Nothing to add');
    expect(screen.getByText('Skipped: sleep is already protected')).toBeTruthy();
    expect(screen.getByText('Sleep 8h')).toBeTruthy();
    expect(screen.getByText('Nap')).toBeTruthy();
  });

  it('hides the ignored section when no lines were ignored', async () => {
    await renderSummary({ blockIds: ['b1'], ignored: [] }, { blocks: { [WEEK]: [FRI_5PM] } });
    await header();
    expect(screen.queryByTestId('plan-summary-ignored')).toBeNull();
  });

  it('moves the unplaced items to next week and replaces the screen with the next-week summary', async () => {
    const { services, navigation } = await renderSummary(
      { unplacedItemIds: ['i1', 'i2'] },
      { items: { [WEEK]: [item('i1', 'A', 60), item('i2', 'B', 30)] } },
    );
    await header();
    services.planning.rollToNextWeek.mockResolvedValueOnce({
      ...emptyPlanResult(NEXT_WEEK, services.state.settings),
      blocks: [{ id: 'n1' }, { id: 'n2' }],
      unplaced: [{ id: 'i2' }],
    } as never);
    await press('Move these to next week');
    expect(services.planning.rollToNextWeek).toHaveBeenCalledWith(WEEK, ['i1', 'i2']);
    expect(navigation.replace).toHaveBeenCalledWith('PlanSummary', {
      weekId: NEXT_WEEK,
      blockIds: ['n1', 'n2'],
      unplacedItemIds: ['i2'],
      mode: 'next-week',
    });
  });

  it('shows a busy state while moving and ignores a second tap', async () => {
    const { services } = await renderSummary({ unplacedItemIds: ['i1'] }, { items: { [WEEK]: [item('i1', 'A', 60)] } });
    await header();
    let finish!: () => void;
    services.planning.rollToNextWeek.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = () => resolve(emptyPlanResult(NEXT_WEEK, services.state.settings));
        }),
    );
    await press('Move these to next week');
    expect(screen.getByRole('button', { name: 'Move these to next week' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Leave them out' })).toBeDisabled();
    await press('Move these to next week');
    expect(services.planning.rollToNextWeek).toHaveBeenCalledTimes(1);
    await act(async () => {
      finish();
    });
  });

  it('next-week summary with added tasks: header, no move button, caption', async () => {
    await renderSummary(
      { weekId: NEXT_WEEK, blockIds: ['n1'], mode: 'next-week' },
      { blocks: { [NEXT_WEEK]: [{ ...FRI_5PM, id: 'n1', weekId: NEXT_WEEK }] } },
    );
    expect(await header()).toBe('Added 1 task to next week');
    expect(screen.getByTestId('plan-summary-caption')).toHaveTextContent(PLAN_SUMMARY_NEXT_WEEK_CAPTION);
    expect(PLAN_SUMMARY_NEXT_WEEK_CAPTION).toBe(
      'Your next-week tasks are in Google Calendar and appear here when that week starts.',
    );
  });

  it('still unplaced next week shows only "Leave them out" and a note', async () => {
    await renderSummary(
      { weekId: NEXT_WEEK, unplacedItemIds: ['i1'], mode: 'next-week' },
      { items: { [NEXT_WEEK]: [item('i1', 'Huge task', 900)] } },
    );
    expect(await header()).toBe('Nothing fits next week either');
    expect(screen.getByText("Didn't fit next week")).toBeTruthy();
    expect(screen.getByText("These still don't fit next week")).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Move these to next week' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Leave them out' })).toBeTruthy();
  });

  it('"Leave them out" drops the items, confirms, and resets to [Dashboard, WeekView]', async () => {
    const toast = jest.spyOn(ToastAndroid, 'show').mockImplementation(() => {});
    const { services, navigation } = await renderSummary(
      { unplacedItemIds: ['i1', 'i2'] },
      { items: { [WEEK]: [item('i1', 'A', 60), item('i2', 'B', 30)] } },
    );
    await header();
    await press('Leave them out');
    expect(services.planning.dropUnplaced).toHaveBeenCalledWith(WEEK, ['i1', 'i2']);
    expect(toast).toHaveBeenCalledWith('Left out 2 tasks.', ToastAndroid.SHORT);
    expect(navigation.reset).toHaveBeenCalledWith({ index: 1, routes: [{ name: 'Dashboard' }, { name: 'WeekView' }] });
  });

  it('shows an inline error and stays when moving fails, then allows a retry', async () => {
    const { services, navigation } = await renderSummary(
      { unplacedItemIds: ['i1'] },
      { items: { [WEEK]: [item('i1', 'A', 60)] } },
    );
    await header();
    services.planning.rollToNextWeek.mockRejectedValueOnce(new Error('boom'));
    await press('Move these to next week');
    expect(screen.getByRole('alert')).toHaveTextContent(PLAN_SUMMARY_ACTION_ERROR);
    expect(PLAN_SUMMARY_ACTION_ERROR).toBe("That didn't work. Try again.");
    expect(navigation.replace).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Move these to next week' })).toBeEnabled();
    await press('Move these to next week');
    expect(navigation.replace).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('shows an inline error and stays when leaving them out fails', async () => {
    const { services, navigation } = await renderSummary(
      { unplacedItemIds: ['i1'] },
      { items: { [WEEK]: [item('i1', 'A', 60)] } },
    );
    await header();
    services.planning.dropUnplaced.mockRejectedValueOnce(new Error('boom'));
    await press('Leave them out');
    expect(screen.getByRole('alert')).toHaveTextContent(PLAN_SUMMARY_ACTION_ERROR);
    expect(navigation.reset).not.toHaveBeenCalled();
  });

  it('"View my week" resets to [Dashboard, WeekView]', async () => {
    const { navigation } = await renderSummary({ blockIds: ['b1'] }, { blocks: { [WEEK]: [FRI_5PM] } });
    await header();
    await press('View my week');
    expect(navigation.reset).toHaveBeenCalledWith({ index: 1, routes: [{ name: 'Dashboard' }, { name: 'WeekView' }] });
  });

  it('shows a load error when the stores cannot be read', async () => {
    const services = createTestServices({ authState: { status: 'signed-in' } });
    services.repos.blocks.get.mockRejectedValueOnce(new Error('disk'));
    const navigation = { reset: jest.fn(), replace: jest.fn() };
    const route = { key: 'k', name: 'PlanSummary', params: { weekId: WEEK, blockIds: [], unplacedItemIds: [] } };
    await render(
      <AppServicesProvider services={services}>
        <PlanSummaryScreen {...({ navigation, route } as unknown as RootScreenProps<'PlanSummary'>)} />
      </AppServicesProvider>,
    );
    expect(await screen.findByRole('alert')).toHaveTextContent(/Couldn't load this summary/);
    expect(screen.queryByTestId('plan-summary-header')).toBeNull();
  });
});

const changedResult = (b: DeviceBlock, moved: DeviceBlock[] = []): SetTimingResult =>
  ({
    kind: 'changed',
    block: b,
    moved: moved.map((m) => ({ block: m, from: { start: m.start, end: m.end }, to: { start: m.start, end: m.end } })),
    from: { start: b.start, end: b.end },
    to: { start: b.start, end: b.end },
    undo: { expiresAt: TEST_NOW + 10_000, blockIds: [b.id, ...moved.map((m) => m.id)] },
  }) as unknown as SetTimingResult;

describe('PlanSummaryScreen timing edits (R29)', () => {
  const openEditor = async () => {
    await header();
    await press('Write report, Fri 5:00 PM – 5:45 PM, work');
  };

  it('opens the TimingEditor when a task row is tapped, and Cancel closes it', async () => {
    await renderSummary({ blockIds: ['b1'] }, { blocks: { [WEEK]: [FRI_5PM] } });
    expect(screen.queryByTestId('timing-editor')).toBeNull();
    await openEditor();
    expect(screen.getByTestId('timing-editor')).toBeTruthy();
    expect(screen.getByTestId('timing-start-value')).toHaveTextContent('5:00 PM');
    await press('Cancel');
    expect(screen.queryByTestId('timing-editor')).toBeNull();
  });

  it('after a change closes the sheet, re-sorts the list, shows moved tasks, and says what moved', async () => {
    const { services } = await renderSummary(
      { blockIds: ['b1', 'b2'] },
      { blocks: { [WEEK]: [FRI_5PM, MON_9AM] } },
    );
    await openEditor();
    const movedFri = { ...FRI_5PM, start: '2025-01-06T08:00:00-05:00', end: '2025-01-06T08:45:00-05:00' };
    const displaced = { ...MON_9AM, start: '2025-01-06T08:45:00-05:00', end: '2025-01-06T09:45:00-05:00' };
    services.blockActions.setTiming.mockImplementationOnce(async () => {
      services.state.blocks[WEEK] = [movedFri, displaced];
      return changedResult(movedFri, [displaced]);
    });
    await press('Save');
    expect(screen.queryByTestId('timing-editor')).toBeNull();
    expect(screen.getByTestId('plan-summary-undo-text')).toHaveTextContent('Moved Write report. Also moved Gym.');
    expect(screen.getByText('Mon 8:00 AM – 8:45 AM')).toBeTruthy();
    expect(screen.getByText('Mon 8:45 AM – 9:45 AM')).toBeTruthy();
    const json = JSON.stringify(screen.toJSON());
    expect(json.indexOf('Write report')).toBeLessThan(json.indexOf('Gym'));
    expect(screen.queryByText('Fri 5:00 PM – 5:45 PM')).toBeNull();
  });

  it('Undo restores the moved tasks and reloads the list', async () => {
    const { services } = await renderSummary({ blockIds: ['b1'] }, { blocks: { [WEEK]: [FRI_5PM] } });
    await openEditor();
    const moved = { ...FRI_5PM, start: '2025-01-09T14:00:00.000Z', end: '2025-01-09T14:45:00.000Z' };
    services.blockActions.setTiming.mockImplementationOnce(async () => {
      services.state.blocks[WEEK] = [moved];
      return changedResult(moved);
    });
    await press('Save');
    expect(screen.getByText('Thu 9:00 AM – 9:45 AM')).toBeTruthy();
    services.blockActions.undo.mockImplementationOnce(async () => {
      services.state.blocks[WEEK] = [FRI_5PM];
      return { kind: 'undone', block: FRI_5PM, restored: { start: FRI_5PM.start, end: FRI_5PM.end } } as never;
    });
    await press('Undo');
    expect(services.blockActions.undo).toHaveBeenCalledWith({ blockId: 'b1' });
    expect(screen.getByText('Fri 5:00 PM – 5:45 PM')).toBeTruthy();
    expect(screen.queryByTestId('plan-summary-undo-bar')).toBeNull();
    expect(screen.getByTestId('plan-summary-note')).toHaveTextContent('Move undone.');
  });

  it('says so when Undo is no longer available', async () => {
    const { services } = await renderSummary({ blockIds: ['b1'] }, { blocks: { [WEEK]: [FRI_5PM] } });
    await openEditor();
    services.blockActions.setTiming.mockResolvedValueOnce(changedResult(FRI_5PM));
    await press('Save');
    await press('Undo');
    expect(screen.getByTestId('plan-summary-note')).toHaveTextContent('Undo is no longer available.');
  });

  it('hides Undo when the undo window ends', async () => {
    jest.useFakeTimers();
    try {
      const { services } = await renderSummary({ blockIds: ['b1'] }, { blocks: { [WEEK]: [FRI_5PM] } });
      await openEditor();
      services.blockActions.setTiming.mockResolvedValueOnce(changedResult(FRI_5PM));
      await press('Save');
      expect(screen.getByTestId('plan-summary-undo-bar')).toBeTruthy();
      await act(async () => {
        jest.advanceTimersByTime(10_001);
      });
      expect(screen.queryByTestId('plan-summary-undo-bar')).toBeNull();
    } finally {
      jest.useRealTimers();
    }
  });

  it('keeps the sheet open with the reason when the edit is rejected', async () => {
    const { services } = await renderSummary({ blockIds: ['b1'] }, { blocks: { [WEEK]: [FRI_5PM] } });
    await openEditor();
    services.blockActions.setTiming.mockResolvedValueOnce({ kind: 'rejected', reason: 'past' });
    await press('Save');
    expect(screen.getByTestId('timing-error')).toHaveTextContent('That time has already passed.');
    expect(screen.queryByTestId('plan-summary-undo-bar')).toBeNull();
  });
});

describe('PlanSummaryScreen reasons, notes, and other weeks', () => {
  const timed = (id: string, text: string, extra: Record<string, unknown>) => ({ ...item(id, text, 30), ...extra }) as IntakeItem;

  it('explains clash, past, and deadline reasons and hints at editing the time', async () => {
    await renderSummary(
      {
        unplacedItemIds: ['i1', 'i2', 'i3', 'i4'],
        reasons: { i1: 'clash', i2: 'past', i3: 'no-time-before-deadline', i4: 'no-fit' },
      },
      {
        items: {
          [WEEK]: [
            timed('i1', 'Dentist', { fixedStart: '2025-01-10T22:00:00.000Z' }),
            timed('i2', 'Call', { fixedStart: '2025-01-07T15:00:00.000Z' }),
            timed('i3', 'Report', {}),
            timed('i4', 'Huge', {}),
          ],
        },
      },
    );
    await header();
    expect(screen.getByTestId('plan-summary-reason-i1')).toHaveTextContent(
      "Couldn't schedule at Fri, Jan 10, 5:00 PM: that time is taken",
    );
    expect(screen.getByTestId('plan-summary-reason-i2')).toHaveTextContent(
      "Couldn't schedule at Tue, Jan 7, 10:00 AM: that time has passed",
    );
    expect(screen.getByTestId('plan-summary-reason-i3')).toHaveTextContent('No time before the deadline');
    expect(screen.queryByTestId('plan-summary-reason-i4')).toBeNull();
    expect(screen.getByTestId('plan-summary-edit-hint')).toHaveTextContent(
      'Edit the time in your list and add it again.',
    );
    // The two existing buttons stay.
    expect(screen.getByRole('button', { name: 'Move these to next week' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Leave them out' })).toBeTruthy();
  });

  it('shows no edit hint for plain no-fit items', async () => {
    await renderSummary({ unplacedItemIds: ['i1'] }, { items: { [WEEK]: [item('i1', 'Huge', 600)] } });
    await header();
    expect(screen.queryByTestId('plan-summary-edit-hint')).toBeNull();
  });

  it('opens from a dashboard link with no blocks and shows the item with its deadline reason', async () => {
    await renderSummary(
      { blockIds: [], unplacedItemIds: ['i1'] },
      { items: { [WEEK]: [timed('i1', 'Tax form', { dueAt: '2025-01-09T22:00:00.000Z' })] } },
    );
    expect(await header()).toBe('Nothing fits this week');
    expect(screen.getByText('Tax form')).toBeTruthy();
    expect(screen.getByTestId('plan-summary-reason-i1')).toHaveTextContent('No time before the deadline');
    expect(screen.queryByTestId('plan-summary-added')).toBeNull();
  });

  it('unplacedReasonText covers each reason without a stored time', () => {
    const base = item('i1', 'X', 30);
    expect(unplacedReasonText(base, 'clash')).toBe("Couldn't schedule at the time you asked for: that time is taken");
    expect(unplacedReasonText(base, 'no-fit')).toBeNull();
    expect(unplacedReasonText(base, undefined)).toBeNull();
  });

  it('lists notes in a muted section', async () => {
    await renderSummary({ blockIds: ['b1'], notes: ['Dentist: Date in the past was ignored'] }, { blocks: { [WEEK]: [FRI_5PM] } });
    await header();
    expect(screen.getByTestId('plan-summary-notes')).toBeTruthy();
    expect(screen.getByText('Dentist: Date in the past was ignored')).toBeTruthy();
  });

  it('hides the notes section without notes', async () => {
    await renderSummary({ blockIds: ['b1'] }, { blocks: { [WEEK]: [FRI_5PM] } });
    await header();
    expect(screen.queryByTestId('plan-summary-notes')).toBeNull();
  });

  it('weekRangeLabel gives the Sunday to Saturday dates', () => {
    expect(weekRangeLabel('2025-01-12')).toBe('Jan 12 – Jan 18');
  });

  it('renders an "Also added to" block per other week, tappable, with its unplaced items', async () => {
    const other = { ...block('o1', 'Trip prep', '2025-01-14T09:00:00-05:00', '2025-01-14T10:00:00-05:00'), weekId: NEXT_WEEK };
    const { services } = await renderSummary(
      {
        blockIds: ['b1'],
        otherWeeks: [
          { weekId: NEXT_WEEK, blockIds: ['o1'], unplacedItemIds: ['o2'], reasons: { o2: 'clash' } },
        ],
      },
      {
        blocks: { [WEEK]: [FRI_5PM], [NEXT_WEEK]: [other] },
        items: {
          [NEXT_WEEK]: [{ ...item('o2', 'Lunch', 60), weekId: NEXT_WEEK, fixedStart: '2025-01-15T17:00:00.000Z' } as IntakeItem],
        },
      },
    );
    expect(await header()).toBe('Added 1 task to this week');
    expect(screen.getByText('Also added to Jan 12 – Jan 18')).toBeTruthy();
    expect(screen.getByText('Trip prep')).toBeTruthy();
    expect(screen.getByText('Tue 9:00 AM – 10:00 AM')).toBeTruthy();
    expect(screen.getByTestId('plan-summary-reason-o2')).toHaveTextContent(
      "Couldn't schedule at Wed, Jan 15, 12:00 PM: that time is taken",
    );
    // The buttons act on the requested week only.
    expect(services.repos.items.get).toHaveBeenCalledWith(NEXT_WEEK);
    await press('Trip prep, Tue 9:00 AM – 10:00 AM, work');
    expect(screen.getByTestId('timing-editor')).toBeTruthy();
    await press('Cancel');
  });

  it('applies Move to next week and Leave out to the requested week only', async () => {
    jest.spyOn(ToastAndroid, 'show').mockImplementation(() => {});
    const { services } = await renderSummary(
      {
        unplacedItemIds: ['i1'],
        otherWeeks: [{ weekId: NEXT_WEEK, blockIds: [], unplacedItemIds: ['o2'] }],
      },
      { items: { [WEEK]: [item('i1', 'A', 60)], [NEXT_WEEK]: [{ ...item('o2', 'B', 30), weekId: NEXT_WEEK } as IntakeItem] } },
    );
    await header();
    await press('Leave them out');
    expect(services.planning.dropUnplaced).toHaveBeenCalledWith(WEEK, ['i1']);
  });

  it('says nothing was added to this week when only later weeks got tasks', async () => {
    const other = { ...block('o1', 'Trip prep', '2025-01-14T09:00:00-05:00', '2025-01-14T10:00:00-05:00'), weekId: NEXT_WEEK };
    await renderSummary(
      { otherWeeks: [{ weekId: NEXT_WEEK, blockIds: ['o1'], unplacedItemIds: [] }] },
      { blocks: { [NEXT_WEEK]: [other] } },
    );
    expect(await header()).toBe('Nothing added to this week');
    expect(screen.getByText('Trip prep')).toBeTruthy();
  });
});

describe('PlanSummaryScreen theme', () => {
  it('follows the dark theme for the screen, rows, and the editor', async () => {
    const services = createTestServices({ authState: { status: 'signed-in' }, blocks: { [WEEK]: [FRI_5PM] } });
    services.state.settings = { ...services.state.settings, themeMode: 'dark' };
    const navigation = { reset: jest.fn(), replace: jest.fn(), navigate: jest.fn() };
    const route = { key: 'k', name: 'PlanSummary', params: { weekId: WEEK, blockIds: ['b1'], unplacedItemIds: [] } };
    await render(
      <AppServicesProvider services={services}>
        <ThemeProvider>
          <PlanSummaryScreen {...({ navigation, route } as unknown as RootScreenProps<'PlanSummary'>)} />
        </ThemeProvider>
      </AppServicesProvider>,
    );
    await header();
    await waitFor(() =>
      expect(StyleSheet.flatten(screen.getByTestId('screen-PlanSummary').props.style).backgroundColor).toBe(
        darkTheme.background,
      ),
    );
    expect(StyleSheet.flatten(screen.getByTestId('plan-summary-header').props.style).color).toBe(darkTheme.text);
    expect(StyleSheet.flatten(screen.getByTestId('plan-summary-block-b1').props.style).backgroundColor).toBe(
      darkTheme.surface,
    );
    await press('Write report, Fri 5:00 PM – 5:45 PM, work');
    expect(StyleSheet.flatten(screen.getByTestId('timing-editor').props.style).backgroundColor).toBe(darkTheme.surface);
    const save = screen.getByTestId('timing-save');
    expect(StyleSheet.flatten(save.props.style).backgroundColor).toBe(darkTheme.primary);
  });
});
