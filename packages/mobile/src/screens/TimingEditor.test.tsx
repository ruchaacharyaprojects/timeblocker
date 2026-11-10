/**
 * TimingEditor tests (R29.1-R29.3): prefilled day/start/length, the 15-minute
 * start stepper with wrap, the 5-minute length stepper, past days disabled,
 * the ISO start built in Toronto time (including the DST weeks), the result
 * handling (changed, each rejection, nothing-fits, errors), and the busy state.
 */
import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import type { DeviceBlock, SetTimingResult } from '@timeblocker/app-core';
import { AppServicesProvider } from '../services/AppServices';
import { createTestServices } from '../services/testServices';
import {
  TIMING_ERROR,
  TimingEditor,
  buildTimingStart,
  formatClock,
  stepLength,
  stepStart,
  timingFailureMessage,
  weekDayKeys,
} from './TimingEditor';

jest.mock('react-native-safe-area-context', () => require('react-native-safe-area-context/jest/mock').default);

const WEEK = '2025-01-05';

// Now (test clock) is Wed 2025-01-08 10:00 Toronto.
const makeBlock = (startIso: string, minutes: number, weekId = WEEK): DeviceBlock =>
  ({
    id: 'b1',
    itemId: 'item-b1',
    title: 'Write report',
    start: startIso,
    end: new Date(Date.parse(startIso) + minutes * 60_000).toISOString(),
    category: 'work',
    status: 'scheduled',
    weekId,
    calendarEventId: 'evb1',
    calendarSynced: true,
    promptedMeetingIds: [],
    usagePrompted: false,
    updatedAt: 0,
  }) as unknown as DeviceBlock;

/** Fri 2025-01-10 5:00 PM EST, 45 min. */
const FRI_5PM = makeBlock('2025-01-10T22:00:00.000Z', 45);

async function renderEditor(block = FRI_5PM) {
  const services = createTestServices({ authState: { status: 'signed-in' } });
  const onClose = jest.fn();
  const onChanged = jest.fn();
  await render(
    <AppServicesProvider services={services}>
      <TimingEditor block={block} onClose={onClose} onChanged={onChanged} />
    </AppServicesProvider>,
  );
  return { services, onClose, onChanged };
}

const press = async (name: string) => {
  await act(async () => {
    void fireEvent.press(screen.getByRole('button', { name }));
  });
};
const startText = () => screen.getByTestId('timing-start-value').props.children as string;
const lengthText = () => screen.getByTestId('timing-length-value').props.children as string;

const changed = (): SetTimingResult =>
  ({
    kind: 'changed',
    block: { ...FRI_5PM, title: 'Write report' },
    moved: [],
    from: { start: FRI_5PM.start, end: FRI_5PM.end },
    to: { start: FRI_5PM.start, end: FRI_5PM.end },
    undo: { expiresAt: 10_000, blockIds: ['b1'] },
  }) as unknown as SetTimingResult;

describe('pure helpers', () => {
  it('formats the clock like 3:15 PM', () => {
    expect(formatClock(15 * 60 + 15)).toBe('3:15 PM');
    expect(formatClock(6 * 60)).toBe('6:00 AM');
    expect(formatClock(12 * 60)).toBe('12:00 PM');
    expect(formatClock(22 * 60 + 45)).toBe('10:45 PM');
  });
  it('steps the start by 15 minutes within 6:00 AM to 10:45 PM, wrapping', () => {
    expect(stepStart(17 * 60, 1)).toBe(17 * 60 + 15);
    expect(stepStart(17 * 60, -1)).toBe(16 * 60 + 45);
    expect(stepStart(22 * 60 + 45, 1)).toBe(6 * 60);
    expect(stepStart(6 * 60, -1)).toBe(22 * 60 + 45);
    // Off-grid values snap to the grid.
    expect(stepStart(9 * 60 + 7, 1)).toBe(9 * 60 + 15);
    expect(stepStart(9 * 60 + 7, -1)).toBe(9 * 60);
  });
  it('steps the length by 5 minutes within 5..480', () => {
    expect(stepLength(45, 1)).toBe(50);
    expect(stepLength(5, -1)).toBe(5);
    expect(stepLength(480, 1)).toBe(480);
  });
  it('lists the seven days of the week from its Sunday', () => {
    expect(weekDayKeys('2025-01-05')).toEqual([
      '2025-01-05',
      '2025-01-06',
      '2025-01-07',
      '2025-01-08',
      '2025-01-09',
      '2025-01-10',
      '2025-01-11',
    ]);
  });
  it('builds the start in Toronto time, including the DST weeks', () => {
    expect(buildTimingStart('2025-01-10', 17 * 60)).toBe('2025-01-10T22:00:00.000Z');
    // EDT in summer (UTC-4).
    expect(buildTimingStart('2025-07-10', 17 * 60)).toBe('2025-07-10T21:00:00.000Z');
    // Fall back on Sunday 2026-11-01: 9:00 AM is EST (UTC-5); the Saturday before is EDT.
    expect(buildTimingStart('2026-11-01', 9 * 60)).toBe('2026-11-01T14:00:00.000Z');
    expect(buildTimingStart('2026-10-31', 9 * 60)).toBe('2026-10-31T13:00:00.000Z');
    // Spring forward on Sunday 2026-03-08: 9:00 AM is EDT (UTC-4).
    expect(buildTimingStart('2026-03-08', 9 * 60)).toBe('2026-03-08T13:00:00.000Z');
  });
});

describe('TimingEditor', () => {
  it('is prefilled with the current day, start, and length', async () => {
    await renderEditor();
    expect(screen.getByTestId('timing-editor-title')).toHaveTextContent('Write report');
    expect(startText()).toBe('5:00 PM');
    expect(lengthText()).toBe('45 min');
    expect(screen.getByRole('button', { name: 'Fri 10' })).toHaveProp('accessibilityState', {
      selected: true,
      disabled: false,
    });
    expect(screen.getByRole('button', { name: 'Sat 11' }).props.accessibilityState.selected).toBe(false);
    for (const label of ['Sun 5', 'Mon 6', 'Tue 7', 'Wed 8', 'Thu 9', 'Fri 10', 'Sat 11']) {
      expect(screen.getByRole('button', { name: label })).toBeTruthy();
    }
  });

  it('disables days before today (the test clock is Wed Jan 8)', async () => {
    await renderEditor();
    for (const label of ['Sun 5', 'Mon 6', 'Tue 7']) {
      expect(screen.getByRole('button', { name: label })).toBeDisabled();
    }
    for (const label of ['Wed 8', 'Thu 9', 'Fri 10', 'Sat 11']) {
      expect(screen.getByRole('button', { name: label })).toBeEnabled();
    }
  });

  it('keeps every day enabled when the whole week is ahead', async () => {
    await renderEditor(makeBlock('2025-01-14T14:00:00.000Z', 30, '2025-01-12'));
    for (const label of ['Sun 12', 'Mon 13', 'Tue 14', 'Wed 15', 'Thu 16', 'Fri 17', 'Sat 18']) {
      expect(screen.getByRole('button', { name: label })).toBeEnabled();
    }
  });

  it('moves the start by 15 minutes and wraps within 6:00 AM to 10:45 PM', async () => {
    await renderEditor();
    await press('Start 15 minutes later');
    expect(startText()).toBe('5:15 PM');
    await press('Start 15 minutes earlier');
    await press('Start 15 minutes earlier');
    expect(startText()).toBe('4:45 PM');
  });

  it('wraps the start at both ends', async () => {
    await renderEditor(makeBlock('2025-01-10T03:45:00.000Z', 30)); // Thu 10:45 PM Toronto
    expect(startText()).toBe('10:45 PM');
    await press('Start 15 minutes later');
    expect(startText()).toBe('6:00 AM');
    await press('Start 15 minutes earlier');
    expect(startText()).toBe('10:45 PM');
  });

  it('changes the length by 5 minutes between 5 and 480', async () => {
    await renderEditor(makeBlock('2025-01-10T22:00:00.000Z', 10));
    expect(lengthText()).toBe('10 min');
    await press('Make 5 minutes shorter');
    await press('Make 5 minutes shorter');
    expect(lengthText()).toBe('5 min');
    for (let i = 0; i < 100; i++) await press('Make 5 minutes longer');
    expect(lengthText()).toBe('8 h');
    await press('Make 5 minutes shorter');
    await press('Make 5 minutes shorter');
    expect(lengthText()).toBe('7 h 50 min');
    await press('Make 5 minutes longer');
    expect(lengthText()).toBe('7 h 55 min');
  });

  it('shows 1 h 30 min for 90 minutes', async () => {
    await renderEditor(makeBlock('2025-01-10T22:00:00.000Z', 90));
    expect(lengthText()).toBe('1 h 30 min');
  });

  it('selects a day chip', async () => {
    await renderEditor();
    await press('Thu 9');
    expect(screen.getByRole('button', { name: 'Thu 9' }).props.accessibilityState.selected).toBe(true);
    expect(screen.getByRole('button', { name: 'Fri 10' }).props.accessibilityState.selected).toBe(false);
  });

  it('saves the chosen day, time, and length as a Toronto ISO start and hands the change over', async () => {
    const { services, onChanged } = await renderEditor();
    const result = changed();
    services.blockActions.setTiming.mockResolvedValueOnce(result);
    await press('Thu 9');
    await press('Start 15 minutes later');
    await press('Make 5 minutes longer');
    await press('Save');
    expect(services.blockActions.setTiming).toHaveBeenCalledWith(
      { blockId: 'b1', weekId: WEEK },
      { start: '2025-01-09T22:15:00.000Z', durationMin: 50 },
    );
    expect(onChanged).toHaveBeenCalledWith(result);
    expect(screen.queryByTestId('timing-error')).toBeNull();
  });

  it('builds the start with EST on the fall-back Sunday 2026-11-01', async () => {
    const { services } = await renderEditor(makeBlock('2026-11-01T14:00:00.000Z', 60, '2026-11-01'));
    services.blockActions.setTiming.mockResolvedValueOnce(changed());
    expect(startText()).toBe('9:00 AM');
    await press('Save');
    expect(services.blockActions.setTiming).toHaveBeenCalledWith(
      { blockId: 'b1', weekId: '2026-11-01' },
      { start: '2026-11-01T14:00:00.000Z', durationMin: 60 },
    );
  });

  it('Cancel closes without saving', async () => {
    const { services, onClose } = await renderEditor();
    await press('Cancel');
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(services.blockActions.setTiming).not.toHaveBeenCalled();
  });

  const rejections: Array<[string, SetTimingResult, string]> = [
    ['protected', { kind: 'rejected', reason: 'protected' }, 'That time is protected (sleep, work hours or a rule). Pick another time.'],
    ['meeting', { kind: 'rejected', reason: 'meeting', detail: 'Team sync' }, 'That time is taken by "Team sync".'],
    ['started-block', { kind: 'rejected', reason: 'started-block' }, "That overlaps a task you've already started or finished."],
    ['past', { kind: 'rejected', reason: 'past' }, 'That time has already passed.'],
    ['wrong-week', { kind: 'rejected', reason: 'wrong-week' }, "Pick a day in this task's week."],
    ['invalid-duration', { kind: 'rejected', reason: 'invalid-duration' }, 'Check the time and length.'],
    ['invalid-start', { kind: 'rejected', reason: 'invalid-start' }, 'Check the time and length.'],
    ['unchanged', { kind: 'rejected', reason: 'unchanged' }, 'That is already the time.'],
    [
      'nothing-fits',
      { kind: 'nothing-fits', block: { ...FRI_5PM, title: 'Gym' } } as SetTimingResult,
      'Nothing else fits if "Gym" has to move. Nothing was changed.',
    ],
    ['not-found', { kind: 'not-found' }, TIMING_ERROR],
  ];

  it.each(rejections)('shows the %s message inline and stays open', async (_name, result, text) => {
    const { services, onChanged, onClose } = await renderEditor();
    services.blockActions.setTiming.mockResolvedValueOnce(result);
    await press('Save');
    expect(screen.getByTestId('timing-error')).toHaveTextContent(text);
    expect(screen.getByRole('alert')).toBeTruthy();
    expect(onChanged).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled();
  });

  it('timingFailureMessage falls back when a meeting has no title', () => {
    expect(timingFailureMessage({ kind: 'rejected', reason: 'meeting' })).toBe(
      'That time is taken by "a calendar event".',
    );
  });

  it('shows a retry message when saving throws, then clears it on the next try', async () => {
    const { services, onChanged } = await renderEditor();
    services.blockActions.setTiming.mockRejectedValueOnce(new Error('boom'));
    await press('Save');
    expect(screen.getByTestId('timing-error')).toHaveTextContent("That didn't work. Try again.");
    services.blockActions.setTiming.mockResolvedValueOnce(changed());
    await press('Save');
    expect(onChanged).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('timing-error')).toBeNull();
  });

  it('shows a busy state while saving and ignores a second tap', async () => {
    const { services, onChanged } = await renderEditor();
    let finish!: (r: SetTimingResult) => void;
    services.blockActions.setTiming.mockImplementationOnce(
      () =>
        new Promise<SetTimingResult>((resolve) => {
          finish = resolve;
        }),
    );
    await press('Save');
    const saving = screen.getByRole('button', { name: 'Saving…' });
    expect(saving).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Start 15 minutes later' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Thu 9' })).toBeDisabled();
    await act(async () => {
      void fireEvent.press(saving);
    });
    expect(services.blockActions.setTiming).toHaveBeenCalledTimes(1);
    await act(async () => {
      finish(changed());
    });
    expect(onChanged).toHaveBeenCalledTimes(1);
  });
});
