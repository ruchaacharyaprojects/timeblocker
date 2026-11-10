/**
 * BlockDetail screen tests (R11.8, R11.9, R13.4, R13.13, R6.2): details in
 * Toronto time, the three actions, the 10 s Undo snackbar with a live
 * countdown (fake timers), Undo restoring the block, nothing-fits navigation,
 * and a deep link to a deleted block. Rendered through the real
 * `RootNavigator` and deep-link config, signed in.
 */
import React from 'react';
import { AccessibilityInfo, Text, View } from 'react-native';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import {
  UNDO_WINDOW_MS,
  buildBlockDetail,
  type ChangeLengthResult,
  type DeviceBlock,
  type MoveResult,
  type UndoResult,
} from '@timeblocker/app-core';
import { RootNavigator } from '../navigation/RootNavigator';
import { PLACEHOLDER_SCREENS } from '../navigation/placeholders';
import { LINKING } from '../navigation/linking';
import type { RootScreenMap, RootScreenProps } from '../navigation/types';
import { AppServicesProvider } from '../services/AppServices';
import { TEST_NOW, createTestServices } from '../services/testServices';
import {
  BLOCK_MISSING_MESSAGE,
  BlockDetailScreen,
  LENGTH_NO_ROOM_MESSAGE,
  LONGER_LABEL,
  SAVE_LENGTH_LABEL,
  SHORTER_LABEL,
  UNDONE_MESSAGE,
} from './BlockDetailScreen';

jest.mock('react-native-safe-area-context', () => require('react-native-safe-area-context/jest/mock').default);

/** The Toronto week of TEST_NOW (Wed 2025-01-08). */
const WEEK = '2025-01-05';
const ORIGINAL = { start: '2025-01-09T14:00:00.000Z', end: '2025-01-09T15:00:00.000Z' }; // Thu 9-10 AM EST
const MOVED_TO = { start: '2025-01-10T19:00:00.000Z', end: '2025-01-10T20:00:00.000Z' }; // Fri 2-3 PM EST

function block(overrides: Partial<DeviceBlock> = {}): DeviceBlock {
  return {
    id: 'b1',
    itemId: 'item-b1',
    title: 'Write report',
    ...ORIGINAL,
    category: 'work',
    status: 'scheduled',
    weekId: WEEK,
    calendarEventId: 'evtb10000',
    calendarSynced: true,
    promptedMeetingIds: [],
    usagePrompted: false,
    updatedAt: 0,
    ...overrides,
  };
}

function StubNothingFits({ route }: RootScreenProps<'NothingFits'>) {
  return (
    <View testID="screen-NothingFits">
      <Text testID="nothing-fits-params">{JSON.stringify(route.params)}</Text>
    </View>
  );
}

function StubWeekView() {
  return <View testID="screen-WeekView" />;
}

const SCREENS: Partial<RootScreenMap> = {
  ...PLACEHOLDER_SCREENS,
  BlockDetail: BlockDetailScreen,
  NothingFits: StubNothingFits,
  WeekView: StubWeekView,
};

/** Services whose moveIt/undo behave like BlockActionService on the in-memory state. */
function servicesWith(blocks: DeviceBlock[]) {
  const services = createTestServices({ authState: { status: 'signed-in' }, blocks: { [WEEK]: blocks } });
  const { state } = services;
  services.blockActions.moveIt.mockImplementation(async ({ weekId, blockId }): Promise<MoveResult> => {
    const week = state.blocks[weekId] ?? [];
    const before = week.find((b) => b.id === blockId);
    if (!before) return { kind: 'not-found' };
    const moved = { ...before, ...MOVED_TO, movedFrom: { start: before.start, end: before.end }, moveReason: 'Moved by you' };
    state.blocks[weekId] = week.map((b) => (b.id === blockId ? moved : b));
    state.undo = {
      blockId,
      weekId,
      calendarEventId: before.calendarEventId,
      previous: { start: before.start, end: before.end },
      previousStatus: before.status,
      movedTo: MOVED_TO,
      expiresAt: state.now + UNDO_WINDOW_MS,
    };
    return { kind: 'moved', source: 'move-it', block: moved, from: state.undo.previous, to: MOVED_TO };
  });
  services.blockActions.changeLength.mockImplementation(async ({ weekId, blockId }, durationMin): Promise<ChangeLengthResult> => {
    const week = state.blocks[weekId] ?? [];
    const before = week.find((b) => b.id === blockId);
    if (!before) return { kind: 'not-found' };
    const to = { start: before.start, end: new Date(Date.parse(before.start) + durationMin * 60_000).toISOString() };
    const resized = { ...before, ...to };
    state.blocks[weekId] = week.map((b) => (b.id === blockId ? resized : b));
    state.undo = {
      blockId,
      weekId,
      calendarEventId: before.calendarEventId,
      previous: { start: before.start, end: before.end },
      previousStatus: before.status,
      movedTo: to,
      expiresAt: state.now + UNDO_WINDOW_MS,
    };
    return { kind: 'resized', block: resized, from: state.undo.previous, to, durationMin, moved: false };
  });
  services.blockActions.undo.mockImplementation(async (): Promise<UndoResult> => {
    const token = state.undo;
    if (!token) return { kind: 'rejected', reason: 'no-token' };
    const week = state.blocks[token.weekId] ?? [];
    const { movedFrom: _f, moveReason: _r, ...rest } = week.find((b) => b.id === token.blockId)!;
    const restored = { ...rest, ...token.previous, status: token.previousStatus };
    state.blocks[token.weekId] = week.map((b) => (b.id === token.blockId ? restored : b));
    state.undo = null;
    return { kind: 'undone', block: restored, restored: token.previous };
  });
  return services;
}

async function renderDetail(services: ReturnType<typeof servicesWith>, url = 'timeblocker://block/b1') {
  await render(
    <AppServicesProvider services={services}>
      <RootNavigator
        authState={services.authState}
        screens={SCREENS}
        linking={{ ...LINKING, getInitialURL: async () => url }}
      />
    </AppServicesProvider>,
  );
  await screen.findByTestId('screen-BlockDetail');
}

const press = async (name: string) => {
  await act(async () => {
    fireEvent.press(screen.getByRole('button', { name }));
  });
};

const advance = async (ms: number) => {
  await act(async () => {
    jest.advanceTimersByTime(ms);
  });
};

describe('BlockDetailScreen', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('shows title, category, start/end in Toronto, and status from a deep link without weekId (R11.8)', async () => {
    const b = block();
    const services = servicesWith([b]);
    await renderDetail(services);
    const expected = buildBlockDetail({ block: b, now: TEST_NOW });

    expect(await screen.findByRole('header', { name: 'Write report' })).toBeTruthy();
    expect(screen.getByTestId('block-category')).toHaveTextContent('Work');
    expect(screen.getByTestId('block-category-color')).toHaveStyle({ backgroundColor: '#3F51B5' });
    expect(screen.getByTestId('block-start')).toHaveTextContent(expected.startLabel);
    expect(screen.getByTestId('block-start')).toHaveTextContent(/9:00\sAM/);
    expect(screen.getByTestId('block-end')).toHaveTextContent(/10:00\sAM/);
    expect(screen.getByTestId('block-status')).toHaveTextContent('Scheduled');
    for (const name of ["I'm in", 'Skip', 'Move it']) expect(screen.getByRole('button', { name })).toBeEnabled();
    expect(screen.queryByTestId('undo-snackbar')).toBeNull();
  });

  it('reads only the given week when the route carries weekId', async () => {
    const services = servicesWith([block()]);
    await renderDetail(services, `timeblocker://block/b1?weekId=${WEEK}`);
    await screen.findByTestId('block-title');
    expect(services.repos.blocks.get.mock.calls).toEqual([[WEEK]]);
  });

  it('"I\'m in" and "Skip" update the status (R13.4)', async () => {
    const services = servicesWith([block()]);
    await renderDetail(services);
    await screen.findByTestId('block-title');

    await press("I'm in");
    expect(services.blockActions.imIn).toHaveBeenCalledWith({ weekId: WEEK, blockId: 'b1' });
    expect(screen.getByTestId('block-status')).toHaveTextContent('In progress');

    await press('Skip');
    expect(services.blockActions.skip).toHaveBeenCalledWith({ weekId: WEEK, blockId: 'b1' });
    expect(screen.getByTestId('block-status')).toHaveTextContent('Skipped');
  });

  it('"Move it" shows Undo with a live countdown for 10 s, then hides it (R11.9)', async () => {
    const services = servicesWith([block()]);
    await renderDetail(services);
    await screen.findByTestId('block-title');

    await press('Move it');
    expect(services.blockActions.moveIt).toHaveBeenCalledWith({ weekId: WEEK, blockId: 'b1' });
    expect(screen.getByTestId('block-start')).toHaveTextContent(/2:00\sPM/);
    expect(screen.getByTestId('undo-snackbar')).toHaveTextContent(/Moved to Fri 2:00\sPM/);
    expect(screen.getByTestId('undo-countdown')).toHaveTextContent('10 s');

    await advance(3_000);
    expect(screen.getByTestId('undo-countdown')).toHaveTextContent('7 s');

    await advance(6_999);
    expect(screen.getByRole('button', { name: 'Undo' })).toBeEnabled();
    expect(screen.getByTestId('undo-countdown')).toHaveTextContent('1 s');

    await advance(1);
    expect(screen.queryByTestId('undo-snackbar')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Undo' })).toBeNull();
  });

  it('Undo inside the window restores the previous slot (R11.9, R6.2)', async () => {
    const services = servicesWith([block()]);
    await renderDetail(services);
    await screen.findByTestId('block-title');

    await press('Move it');
    await advance(5_000);
    await press('Undo');

    expect(services.blockActions.undo).toHaveBeenCalledWith({ blockId: 'b1' });
    expect(screen.getByTestId('block-start')).toHaveTextContent(/9:00\sAM/);
    expect(screen.getByTestId('block-status')).toHaveTextContent('Scheduled');
    expect(screen.queryByTestId('undo-snackbar')).toBeNull();
    expect(screen.getByRole('alert')).toHaveTextContent(UNDONE_MESSAGE);
  });

  it('opens NothingFits with blockId and weekId when no slot fits (R13.13)', async () => {
    const b = block();
    const services = servicesWith([b]);
    services.blockActions.moveIt.mockResolvedValueOnce({
      kind: 'nothing-fits',
      source: 'move-it',
      block: b,
      alert: {} as Extract<MoveResult, { kind: 'nothing-fits' }>['alert'],
    });
    await renderDetail(services);
    await screen.findByTestId('block-title');

    await press('Move it');
    expect(await screen.findByTestId('screen-NothingFits')).toBeTruthy();
    expect(JSON.parse(screen.getByTestId('nothing-fits-params').props.children)).toEqual({ blockId: 'b1', weekId: WEEK });
    expect(services.state.blocks[WEEK]).toEqual([b]);
  });

  it('handles a deep link to a deleted block gracefully', async () => {
    const services = servicesWith([]);
    await renderDetail(services, 'timeblocker://block/gone');
    expect(await screen.findByTestId('block-missing')).toHaveTextContent(BLOCK_MISSING_MESSAGE);
    expect(screen.queryByRole('button', { name: 'Move it' })).toBeNull();

    await press('Back to this week');
    expect(await screen.findByTestId('screen-WeekView')).toBeTruthy();
  });

  describe('Change length (R15.9)', () => {
    const value = () => screen.getByTestId('block-length-value');

    it('shows the current length and steps in 5-minute increments with accessible labels', async () => {
      const announce = jest.spyOn(AccessibilityInfo, 'announceForAccessibility').mockImplementation(() => undefined);
      await renderDetail(servicesWith([block()]));
      await screen.findByTestId('block-title');

      expect(value()).toHaveTextContent('1 h');
      expect(screen.getByRole('button', { name: SAVE_LENGTH_LABEL })).toBeDisabled();

      await press(LONGER_LABEL);
      expect(value()).toHaveTextContent('1 h 5 min');
      expect(announce).toHaveBeenLastCalledWith('Length 1 h 5 min');
      expect(screen.getByRole('button', { name: SAVE_LENGTH_LABEL })).toBeEnabled();

      await press(SHORTER_LABEL);
      await press(SHORTER_LABEL);
      expect(value()).toHaveTextContent('55 min');
      expect(announce).toHaveBeenLastCalledWith('Length 55 min');
      announce.mockRestore();
    });

    it('stops at 5 and 480 minutes', async () => {
      const min = servicesWith([block({ end: '2025-01-09T14:05:00.000Z' })]);
      await renderDetail(min);
      await screen.findByTestId('block-title');
      expect(value()).toHaveTextContent('5 min');
      expect(screen.getByRole('button', { name: SHORTER_LABEL })).toBeDisabled();
      expect(screen.getByRole('button', { name: LONGER_LABEL })).toBeEnabled();
    });

    it('stops at 480 minutes', async () => {
      const max = servicesWith([block({ end: '2025-01-09T22:00:00.000Z' })]);
      await renderDetail(max);
      await screen.findByTestId('block-title');
      expect(value()).toHaveTextContent('8 h');
      expect(screen.getByRole('button', { name: LONGER_LABEL })).toBeDisabled();
      expect(screen.getByRole('button', { name: SHORTER_LABEL })).toBeEnabled();
    });

    it('saves the new length, shows the Undo snackbar, and Undo restores it', async () => {
      const services = servicesWith([block()]);
      await renderDetail(services);
      await screen.findByTestId('block-title');

      await press(LONGER_LABEL);
      await press(SAVE_LENGTH_LABEL);

      expect(services.blockActions.changeLength).toHaveBeenCalledWith({ weekId: WEEK, blockId: 'b1' }, 65);
      expect(screen.getByTestId('block-end')).toHaveTextContent(/10:05\sAM/);
      expect(value()).toHaveTextContent('1 h 5 min');
      expect(screen.getByTestId('undo-snackbar')).toHaveTextContent(/Length changed to 1 h 5 min/);
      expect(screen.getByTestId('undo-countdown')).toHaveTextContent('10 s');
      expect(screen.getByRole('button', { name: SAVE_LENGTH_LABEL })).toBeDisabled();

      await press('Undo');
      expect(services.blockActions.undo).toHaveBeenCalledWith({ blockId: 'b1' });
      expect(screen.getByTestId('block-end')).toHaveTextContent(/10:00\sAM/);
      expect(value()).toHaveTextContent('1 h');
      expect(screen.queryByTestId('undo-snackbar')).toBeNull();
    });

    it('tells her when nothing fits and leaves the block and length unchanged', async () => {
      const b = block();
      const services = servicesWith([b]);
      services.blockActions.changeLength.mockResolvedValueOnce({
        kind: 'nothing-fits',
        block: b,
        durationMin: 65,
        alert: {} as Extract<ChangeLengthResult, { kind: 'nothing-fits' }>['alert'],
      });
      await renderDetail(services);
      await screen.findByTestId('block-title');

      await press(LONGER_LABEL);
      await press(SAVE_LENGTH_LABEL);

      expect(screen.getByRole('alert')).toHaveTextContent(LENGTH_NO_ROOM_MESSAGE);
      expect(screen.queryByTestId('undo-snackbar')).toBeNull();
      expect(services.state.blocks[WEEK]).toEqual([b]);
      expect(value()).toHaveTextContent('1 h');
      expect(screen.queryByTestId('screen-NothingFits')).toBeNull();
    });

    it('says the block moved when the new length needed a different slot', async () => {
      const services = servicesWith([block()]);
      services.blockActions.changeLength.mockImplementationOnce(async ({ weekId, blockId }, durationMin) => {
        const week = services.state.blocks[weekId]!;
        const before = week.find((x) => x.id === blockId)!;
        const to = { start: MOVED_TO.start, end: new Date(Date.parse(MOVED_TO.start) + durationMin * 60_000).toISOString() };
        const resized = { ...before, ...to };
        services.state.blocks[weekId] = week.map((x) => (x.id === blockId ? resized : x));
        services.state.undo = {
          blockId,
          weekId,
          calendarEventId: before.calendarEventId,
          previous: { start: before.start, end: before.end },
          previousStatus: before.status,
          movedTo: to,
          expiresAt: services.state.now + UNDO_WINDOW_MS,
        };
        return { kind: 'resized', block: resized, from: services.state.undo.previous, to, durationMin, moved: true };
      });
      await renderDetail(services);
      await screen.findByTestId('block-title');
      await press(LONGER_LABEL);
      await press(SAVE_LENGTH_LABEL);
      expect(screen.getByTestId('undo-snackbar')).toHaveTextContent(/Moved to Fri 2:00\sPM to fit 1 h 5 min/);
    });

    it.each([
      ['started', { start: new Date(TEST_NOW - 30 * 60_000).toISOString(), end: new Date(TEST_NOW + 30 * 60_000).toISOString() }, /started/],
      ['done', { status: 'done' as const }, /scheduled/],
      ['in-progress', { status: 'in-progress' as const }, /scheduled/],
    ])('disables the control with a reason for a %s block', async (_name, overrides, reason) => {
      await renderDetail(servicesWith([block(overrides)]));
      await screen.findByTestId('block-title');

      expect(screen.getByRole('button', { name: SHORTER_LABEL })).toBeDisabled();
      expect(screen.getByRole('button', { name: LONGER_LABEL })).toBeDisabled();
      expect(screen.getByRole('button', { name: SAVE_LENGTH_LABEL })).toBeDisabled();
      expect(screen.getByTestId('block-length-reason')).toHaveTextContent(reason);
    });
  });
});
