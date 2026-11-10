/**
 * Intake screen tests (R1.1, R11.4-R11.6, R15.1, R15.8): paste box limit and
 * counter, submit plans in one step and resets to [Dashboard, PlanSummary]
 * with the block and unplaced ids (never NothingFits), the clear-week button
 * confirms before clearing and reports the result, each rejection keeps the exact text with an inline
 * reason, busy state guards double taps, failures keep the text, and the saved
 * draft is restored. Rendered through the real `RootNavigator` (signed in,
 * deep-linked to `timeblocker://intake`) with only this task's screens swapped in.
 */
import React from 'react';
import { Alert, Pressable, Text, View } from 'react-native';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { MAX_INTAKE_CHARS, MAX_INTAKE_ITEMS, validateIntakeInput, type IntakeRejectionReason } from '@timeblocker/flows';
import { RootNavigator } from '../navigation/RootNavigator';
import { PLACEHOLDER_SCREENS } from '../navigation/placeholders';
import { LINKING } from '../navigation/linking';
import type { RootScreenMap, RootScreenProps } from '../navigation/types';
import { AppServicesProvider } from '../services/AppServices';
import { createTestServices, type TestState } from '../services/testServices';
import {
  CLEAR_WEEK_CONFIRM_MESSAGE,
  CLEAR_WEEK_CONFIRM_TITLE,
  CLEAR_WEEK_FAILED_MESSAGE,
  INTAKE_BUSY_LABEL,
  INTAKE_FAILED_MESSAGE,
  INTAKE_HELPER_TEXT,
  INTAKE_INSTRUCTION,
  INTAKE_PLACEHOLDER,
  INTAKE_REJECTION_MESSAGES,
  IntakeScreen,
  clearResultMessage,
  formatCount,
} from './IntakeScreen';

jest.mock('react-native-safe-area-context', () => require('react-native-safe-area-context/jest/mock').default);

function StubPlanSummary({ navigation, route }: RootScreenProps<'PlanSummary'>) {
  return (
    <View testID="screen-PlanSummary">
      <Text testID="plan-summary-params">{JSON.stringify(route.params)}</Text>
      <Pressable accessibilityRole="button" accessibilityLabel="Back" onPress={() => navigation.goBack()} />
    </View>
  );
}
function StubNothingFits() {
  return <View testID="screen-NothingFits" />;
}

function StubWeekView({ navigation }: RootScreenProps<'WeekView'>) {
  return (
    <View testID="screen-WeekView">
      <Pressable accessibilityRole="button" accessibilityLabel="Back" onPress={() => navigation.goBack()} />
    </View>
  );
}

const SCREENS: Partial<RootScreenMap> = {
  ...PLACEHOLDER_SCREENS,
  Intake: IntakeScreen,
  WeekView: StubWeekView,
  NothingFits: StubNothingFits,
  PlanSummary: StubPlanSummary,
};

async function renderIntake(seed: Partial<TestState> = {}) {
  const services = createTestServices({ authState: { status: 'signed-in' }, ...seed });
  // Use the real pure validator so every rejection reason is exercised.
  const defaultSubmit = services.intake.submit.getMockImplementation()!;
  services.intake.submit.mockImplementation(async (raw: string, weekId: string) => {
    const result = validateIntakeInput(raw);
    if (!result.ok) return { ok: false as const, error: 'rejected' as const, reason: result.reason };
    return defaultSubmit(raw, weekId);
  });
  await render(
    <AppServicesProvider services={services}>
      <RootNavigator
        authState={services.authState}
        screens={SCREENS}
        linking={{ ...LINKING, getInitialURL: () => Promise.resolve('timeblocker://intake') }}
      />
    </AppServicesProvider>,
  );
  await screen.findByTestId('screen-Intake');
  return services;
}

const input = () => screen.getByLabelText('To-do list');
const submit = async () => {
  await act(async () => {
    void fireEvent.press(screen.getByRole('button', { name: 'Submit' }));
  });
};

const manyLines = Array.from({ length: MAX_INTAKE_ITEMS + 1 }, (_, i) => `Item ${i + 1}`).join('\n');

describe('IntakeScreen', () => {
  it('has a multiline paste box limited to 20,000 characters with a live counter (R11.4)', async () => {
    const services = await renderIntake();
    expect(input()).toHaveProp('maxLength', MAX_INTAKE_CHARS);
    expect(input()).toHaveProp('multiline', true);
    expect(screen.getByTestId('intake-counter')).toHaveTextContent('0 / 20,000');

    await fireEvent.changeText(input(), 'Gym\nRead');
    expect(screen.getByTestId('intake-counter')).toHaveTextContent('8 / 20,000');
    expect(screen.queryByRole('alert')).toBeNull();
    // Typing never validates or plans.
    expect(services.intake.submit).not.toHaveBeenCalled();
  });

  const rejections: Array<[IntakeRejectionReason, string]> = [
    ['empty', '   \n\t '],
    ['malformed-json', '  [{"text": "Gym", '],
    ['no-items', '[]'],
    ['too-many-items', manyLines],
    ['too-long', 'x'.repeat(MAX_INTAKE_CHARS + 1)],
  ];

  it.each(rejections)(
    'on %s stays on Intake, keeps the exact text, and shows the reason inline (R11.6)',
    async (reason, raw) => {
      const services = await renderIntake();
      await fireEvent.changeText(input(), raw);
      await submit();

      expect(services.intake.submit).toHaveBeenCalledWith(raw, services.review.currentWeekId());
      expect(screen.getByRole('alert')).toHaveTextContent(INTAKE_REJECTION_MESSAGES[reason]);
      expect(input()).toHaveProp('value', raw);
      expect(screen.getByTestId('screen-Intake')).toBeTruthy();
      expect(screen.queryByTestId('screen-WeekView')).toBeNull();
      expect(screen.getByRole('button', { name: 'Submit' })).toBeEnabled();
    },
  );

  it('shows the instruction line first, above the input (R20.1)', async () => {
    await renderIntake();
    expect(INTAKE_INSTRUCTION).toBe('Provide a list of your tasks this week, one on each line.');
    const instruction = screen.getByTestId('intake-instruction');
    expect(instruction).toHaveTextContent('Provide a list of your tasks this week, one on each line.');
    expect(instruction).toHaveProp('accessibilityRole', 'header');
    // First text inside the screen, before the input.
    const texts = JSON.stringify(screen.toJSON());
    expect(texts.indexOf(INTAKE_INSTRUCTION)).toBeGreaterThan(-1);
    expect(texts.indexOf(INTAKE_INSTRUCTION)).toBeLessThan(texts.indexOf('intake-input'));
  });

  it('explains counts and lengths, and gives a multi-line example placeholder (R20.1)', async () => {
    await renderIntake();
    const helper = screen.getByTestId('intake-helper');
    expect(helper).toHaveTextContent(INTAKE_HELPER_TEXT);
    expect(helper).toHaveTextContent(/Gym 3x/);
    expect(helper).toHaveTextContent(/Read 45 min/);
    expect(helper).toHaveTextContent(/estimated from your past blocks/);
    expect(input()).toHaveProp('placeholder', INTAKE_PLACEHOLDER);
    expect(INTAKE_PLACEHOLDER.split('\n').length).toBeGreaterThanOrEqual(2);
  });

  it('submits for the current week and resets to the plan summary (R21)', async () => {
    const services = await renderIntake();
    await fireEvent.changeText(input(), 'Finish report\n\nGym');
    await submit();
    expect(services.intake.submit).toHaveBeenCalledWith('Finish report\n\nGym', services.review.currentWeekId());
    expect(await screen.findByTestId('screen-PlanSummary')).toBeTruthy();
    expect(JSON.parse(screen.getByTestId('plan-summary-params').props.children)).toEqual({
      weekId: services.review.currentWeekId(),
      blockIds: [],
      unplacedItemIds: [],
    });
    expect(screen.queryByTestId('screen-NothingFits')).toBeNull();
    expect(screen.queryByTestId('screen-Intake')).toBeNull();
    // There is no review step in the flow.
    expect(services.intake.validate).not.toHaveBeenCalled();
    expect(services.intake.confirm).not.toHaveBeenCalled();
  });
  it('resets to [Dashboard, PlanSummary] so Back from the summary goes to the dashboard', async () => {
    await renderIntake();
    await fireEvent.changeText(input(), 'Gym 3x');
    await submit();
    expect(await screen.findByTestId('screen-PlanSummary')).toBeTruthy();
    await act(async () => {
      void fireEvent.press(screen.getByRole('button', { name: 'Back' }));
    });
    expect(await screen.findByTestId('screen-Dashboard')).toBeTruthy();
    expect(screen.queryByTestId('screen-Intake')).toBeNull();
  });
  it('passes block ids, unplaced item ids, and ignored lines to the summary, never NothingFits (R21)', async () => {
    const services = await renderIntake();
    services.intake.submit.mockImplementationOnce(async (_raw: string, weekId: string) => {
      const plan = await services.planning.plan(weekId);
      return {
        ok: true as const,
        weekId,
        confirmed: [],
        plan: { ...plan, blocks: [{ id: 'b1' }, { id: 'b2' }], unplaced: [{ id: 'i1' }, { id: 'i2' }] },
        ignored: [{ text: 'Sleep 8h', reason: 'sleep' as const }],
      } as never;
    });
    await fireEvent.changeText(input(), 'Huge task\nAnother');
    await submit();
    expect(await screen.findByTestId('screen-PlanSummary')).toBeTruthy();
    expect(JSON.parse(screen.getByTestId('plan-summary-params').props.children)).toEqual({
      weekId: services.review.currentWeekId(),
      blockIds: ['b1', 'b2'],
      unplacedItemIds: ['i1', 'i2'],
      ignored: [{ text: 'Sleep 8h', reason: 'sleep' }],
    });
    expect(screen.queryByTestId('screen-NothingFits')).toBeNull();
    expect(screen.queryByTestId('screen-Intake')).toBeNull();
  });
  it('passes reasons, notes, and the other weeks to the summary (R28.2, R28.7)', async () => {
    const services = await renderIntake();
    services.intake.submit.mockImplementationOnce(async (_raw: string, weekId: string) => {
      const plan = await services.planning.plan(weekId);
      return {
        ok: true as const,
        weekId,
        confirmed: [],
        plan: {
          ...plan,
          blocks: [{ id: 'b1' }],
          unplaced: [{ id: 'i1', reason: 'clash' }, { id: 'i2', reason: 'no-time-before-deadline' }, { id: 'i3' }],
        },
        otherPlans: [
          {
            ...plan,
            weekId: '2099-01-04',
            blocks: [{ id: 'o1' }],
            unplaced: [{ id: 'o2', reason: 'past' }],
          },
          { ...plan, weekId: '2099-01-11', blocks: [{ id: 'o3' }], unplaced: [] },
        ],
        notes: ['Dentist: Date in the past was ignored'],
      } as never;
    });
    await fireEvent.changeText(input(), 'Dentist\nLunch');
    await submit();
    expect(await screen.findByTestId('screen-PlanSummary')).toBeTruthy();
    expect(JSON.parse(screen.getByTestId('plan-summary-params').props.children)).toEqual({
      weekId: services.review.currentWeekId(),
      blockIds: ['b1'],
      unplacedItemIds: ['i1', 'i2', 'i3'],
      reasons: { i1: 'clash', i2: 'no-time-before-deadline' },
      notes: ['Dentist: Date in the past was ignored'],
      otherWeeks: [
        { weekId: '2099-01-04', blockIds: ['o1'], unplacedItemIds: ['o2'], reasons: { o2: 'past' } },
        { weekId: '2099-01-11', blockIds: ['o3'], unplacedItemIds: [] },
      ],
    });
    expect(screen.queryByTestId('screen-NothingFits')).toBeNull();
  });
  it('shows a busy state while planning and ignores a second tap', async () => {
    const services = await renderIntake();
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const defaultSubmit = services.intake.submit.getMockImplementation()!;
    services.intake.submit.mockImplementation(async (raw: string, weekId: string) => {
      await gate;
      return defaultSubmit(raw, weekId);
    });
    await fireEvent.changeText(input(), 'Gym');
    await submit();

    const busyButton = screen.getByRole('button', { name: INTAKE_BUSY_LABEL });
    expect(busyButton).toBeDisabled();
    expect(screen.getByText(INTAKE_BUSY_LABEL)).toBeTruthy();
    await act(async () => {
      void fireEvent.press(busyButton);
    });
    await act(async () => {
      void fireEvent.press(busyButton);
    });
    expect(services.intake.submit).toHaveBeenCalledTimes(1);

    await act(async () => {
      finish();
    });
    expect(await screen.findByTestId('screen-PlanSummary')).toBeTruthy();
    expect(services.intake.submit).toHaveBeenCalledTimes(1);
  });

  it('clears the previous error on a successful resubmit', async () => {
    await renderIntake();
    await fireEvent.changeText(input(), '');
    await submit();
    expect(screen.getByRole('alert')).toHaveTextContent(INTAKE_REJECTION_MESSAGES.empty);

    await fireEvent.changeText(input(), 'Gym');
    await submit();
    expect(await screen.findByTestId('screen-PlanSummary')).toBeTruthy();
  });

  it('shows a retry message and keeps the text when submit throws', async () => {
    const services = await renderIntake();
    services.intake.submit.mockRejectedValueOnce(new Error('disk full'));
    await fireEvent.changeText(input(), 'Gym');
    await submit();
    expect(screen.getByRole('alert')).toHaveTextContent(INTAKE_FAILED_MESSAGE);
    expect(input()).toHaveProp('value', 'Gym');
    expect(screen.getByRole('button', { name: 'Submit' })).toBeEnabled();
    expect(screen.getByTestId('screen-Intake')).toBeTruthy();
  });

  it('shows the retry message and keeps the text on a non-rejection failure result', async () => {
    const services = await renderIntake();
    services.intake.submit.mockResolvedValueOnce({ ok: false, error: 'no-draft' });
    await fireEvent.changeText(input(), 'Gym');
    await submit();
    expect(screen.getByRole('alert')).toHaveTextContent(INTAKE_FAILED_MESSAGE);
    expect(input()).toHaveProp('value', 'Gym');
  });

  it('restores the saved draft text (R1.3)', async () => {
    await renderIntake({ draft: { text: 'Saved list', updatedAt: 0 } });
    expect(await screen.findByDisplayValue('Saved list')).toBeTruthy();
    expect(screen.getByTestId('intake-counter')).toHaveTextContent('10 / 20,000');
  });
});

describe('IntakeScreen clear this week', () => {
  const alertSpy = () => jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  type AlertButtons = NonNullable<Parameters<typeof Alert.alert>[2]>;
  const pressClear = async () => {
    await act(async () => {
      void fireEvent.press(screen.getByTestId('clear-week'));
    });
  };
  const confirm = async (spy: jest.SpyInstance) => {
    const buttons = spy.mock.calls[spy.mock.calls.length - 1]![2] as AlertButtons;
    const destructive = buttons.find((b) => b.style === 'destructive')!;
    await act(async () => {
      destructive.onPress?.();
    });
  };
  afterEach(() => jest.restoreAllMocks());

  it('shows an outlined clear button below Submit', async () => {
    await renderIntake();
    expect(screen.getByTestId('clear-week')).toBeEnabled();
    expect(screen.getByRole('button', { name: "Clear this week's tasks" })).toBeTruthy();
    const json = JSON.stringify(screen.toJSON());
    expect(json.indexOf('intake-submit')).toBeLessThan(json.indexOf('clear-week'));
  });
  it('asks first with the exact dialog and does nothing on Cancel', async () => {
    const services = await renderIntake();
    const spy = alertSpy();
    await pressClear();
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]![0]).toBe("Clear this week's tasks?");
    expect(spy.mock.calls[0]![0]).toBe(CLEAR_WEEK_CONFIRM_TITLE);
    expect(spy.mock.calls[0]![1]).toBe(CLEAR_WEEK_CONFIRM_MESSAGE);
    const buttons = spy.mock.calls[0]![2] as AlertButtons;
    expect(buttons.map((b) => [b.text, b.style])).toEqual([
      ['Cancel', 'cancel'],
      ['Clear', 'destructive'],
    ]);
    await act(async () => {
      buttons[0]!.onPress?.();
    });
    expect(services.weekReset.clear).not.toHaveBeenCalled();
    expect(screen.queryByTestId('clear-week-result')).toBeNull();
  });
  it('clears the current week on confirm, clears the text, and reports the result', async () => {
    const services = await renderIntake();
    services.weekReset.clear.mockResolvedValueOnce({ removedTasks: 3, keptAsHistory: 2 });
    const spy = alertSpy();
    await fireEvent.changeText(input(), 'Gym');
    await pressClear();
    await confirm(spy);
    expect(services.weekReset.clear).toHaveBeenCalledWith(services.review.currentWeekId());
    expect(await screen.findByTestId('clear-week-result')).toHaveTextContent('Removed 3 tasks. Kept 2 as history.');
    expect(input()).toHaveProp('value', '');
    expect(screen.getByTestId('screen-Intake')).toBeTruthy();
  });
  it('shows a busy state while clearing and ignores a second tap', async () => {
    const services = await renderIntake();
    let finish!: () => void;
    services.weekReset.clear.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = () => resolve({ removedTasks: 1, keptAsHistory: 0 });
        }),
    );
    const spy = alertSpy();
    await pressClear();
    await confirm(spy);
    const busy = screen.getByRole('button', { name: 'Clearing…' });
    expect(busy).toBeDisabled();
    await act(async () => {
      void fireEvent.press(busy);
    });
    expect(spy).toHaveBeenCalledTimes(1);
    await act(async () => {
      finish();
    });
    expect(await screen.findByTestId('clear-week-result')).toHaveTextContent('Removed 1 task. Kept 0 as history.');
    expect(screen.getByRole('button', { name: "Clear this week's tasks" })).toBeEnabled();
  });
  it('says "Nothing to clear." when there was nothing', async () => {
    await renderIntake();
    const spy = alertSpy();
    await pressClear();
    await confirm(spy);
    expect(await screen.findByTestId('clear-week-result')).toHaveTextContent('Nothing to clear.');
  });
  it('shows a retry message and keeps the text when clearing fails', async () => {
    const services = await renderIntake();
    services.weekReset.clear.mockRejectedValueOnce(new Error('boom'));
    const spy = alertSpy();
    await fireEvent.changeText(input(), 'Gym');
    await pressClear();
    await confirm(spy);
    expect(await screen.findByTestId('clear-week-result')).toHaveTextContent(CLEAR_WEEK_FAILED_MESSAGE);
    expect(CLEAR_WEEK_FAILED_MESSAGE).toBe("Couldn't clear this week. Try again.");
    expect(input()).toHaveProp('value', 'Gym');
  });
});
describe('clearResultMessage', () => {
  it('handles singular, plural, and zero', () => {
    expect(clearResultMessage(0, 0)).toBe('Nothing to clear.');
    expect(clearResultMessage(1, 0)).toBe('Removed 1 task. Kept 0 as history.');
    expect(clearResultMessage(0, 4)).toBe('Removed 0 tasks. Kept 4 as history.');
  });
});
describe('formatCount', () => {
  it('groups thousands', () => {
    expect(formatCount(0)).toBe('0');
    expect(formatCount(999)).toBe('999');
    expect(formatCount(20000)).toBe('20,000');
    expect(formatCount(1234567)).toBe('1,234,567');
  });
});
