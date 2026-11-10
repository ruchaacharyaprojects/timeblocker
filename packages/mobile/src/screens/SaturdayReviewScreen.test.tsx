/**
 * SaturdayReview screen tests (R9.1-R9.4, R11.10, R8.1): loading and error
 * states, each section, the usage-denied note, and the next-week prompt that
 * opens Intake. Rendered in a small native stack with a stand-in Intake route.
 */
import React from 'react';
import { Text } from 'react-native';
import { act, fireEvent, render, screen, within } from '@testing-library/react-native';
import { NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import type { ReviewResult } from '@timeblocker/app-core';
import type { WeeklyReview } from '@timeblocker/flows';
import type { RootStackParamList } from '../navigation/types';
import { AppServicesProvider } from '../services/AppServices';
import { createTestServices, emptyReview } from '../services/testServices';
import {
  EMPTY_SECTION_TEXT,
  NOTHING_MOVED_TEXT,
  REVIEW_ERROR_MESSAGE,
  REVIEW_LOADING_LABEL,
  SaturdayReviewScreen,
  USAGE_DENIED_NOTE,
} from './SaturdayReviewScreen';

jest.mock('react-native-safe-area-context', () => require('react-native-safe-area-context/jest/mock').default);

const Stack = createNativeStackNavigator<RootStackParamList>();
/** The Sunday of the test week (TEST_NOW is Wed 2025-01-08). */
const WEEK = '2025-01-05';

const entry = (blockId: string, title: string, category: WeeklyReview['finished'][number]['category'], day: number) => ({
  blockId,
  itemId: `item-${blockId}`,
  title,
  category,
  start: `2025-01-0${day}T15:00:00Z`,
  end: `2025-01-0${day}T16:00:00Z`,
});

const fullReview: WeeklyReview = {
  ...emptyReview(WEEK),
  finished: [entry('b1', 'Write report', 'work', 6)],
  partial: [entry('b2', 'Read book', 'self-development', 7)],
  missed: [entry('b3', 'Gym', 'fitness', 8)],
  screenTimeMin: 135,
  distractionLevel: 'high',
  movedToNextWeek: [{ ...entry('b4', 'Taxes', 'misc', 9), reason: 'No free time left this week' }],
  fitnessMissedCount: 1,
};

function IntakeStub(): React.JSX.Element {
  return <Text testID="screen-Intake">Intake</Text>;
}

async function renderReview(services = createTestServices()) {
  await render(
    <AppServicesProvider services={services}>
      <NavigationContainer>
        <Stack.Navigator>
          <Stack.Screen name="SaturdayReview" component={SaturdayReviewScreen} />
          <Stack.Screen name="Intake" component={IntakeStub} />
        </Stack.Navigator>
      </NavigationContainer>
    </AppServicesProvider>,
  );
  return services;
}

describe('SaturdayReviewScreen', () => {
  it('shows a loading state while the review builds, then the review', async () => {
    const services = createTestServices({ reviews: { [WEEK]: fullReview } });
    let finish: (r: ReviewResult) => void = () => {};
    services.review.build.mockImplementationOnce(() => new Promise<ReviewResult>((resolve) => (finish = resolve)));
    await renderReview(services);
    expect(screen.getByLabelText(REVIEW_LOADING_LABEL)).toBeTruthy();
    expect(services.review.build).toHaveBeenCalledTimes(1);

    await act(async () => finish({ weekId: WEEK, review: fullReview, usage: 'ok', fitnessMissed: [] }));
    expect(screen.queryByLabelText(REVIEW_LOADING_LABEL)).toBeNull();
    expect(screen.getByRole('header', { name: 'Saturday review' })).toBeTruthy();
  });

  it('shows finished, partly finished, and missed blocks with category text (R9.1)', async () => {
    await renderReview(createTestServices({ reviews: { [WEEK]: fullReview } }));
    const finished = await screen.findByTestId('review-section-finished');
    expect(within(finished).getByRole('header', { name: 'Finished (1)' })).toBeTruthy();
    expect(within(finished).getByText('Write report')).toBeTruthy();
    expect(within(finished).getByText(/^Work · /)).toBeTruthy();

    const partial = screen.getByTestId('review-section-partial');
    expect(within(partial).getByRole('header', { name: 'Partly finished (1)' })).toBeTruthy();
    expect(within(partial).getByText('Read book')).toBeTruthy();

    const missed = screen.getByTestId('review-section-missed');
    expect(within(missed).getByRole('header', { name: 'Missed (1)' })).toBeTruthy();
    expect(within(missed).getByText('Gym')).toBeTruthy();
    expect(within(missed).getByText(/^Fitness · /)).toBeTruthy();
  });

  it('shows screen time and distraction level, without the denied note when usage is ok (R9.2)', async () => {
    await renderReview(createTestServices({ reviews: { [WEEK]: fullReview } }));
    const usage = await screen.findByTestId('review-section-usage');
    expect(within(usage).getByText('Screen time: 2 h 15 min')).toBeTruthy();
    expect(within(usage).getByText('Distraction level: High')).toBeTruthy();
    expect(screen.queryByText(USAGE_DENIED_NOTE)).toBeNull();
  });

  it('notes when usage permission is denied (R9.2)', async () => {
    const services = createTestServices();
    services.review.build.mockResolvedValueOnce({ weekId: WEEK, review: emptyReview(WEEK), usage: 'permission-denied', fitnessMissed: [] });
    await renderReview(services);
    expect(await screen.findByText(USAGE_DENIED_NOTE)).toBeTruthy();
    expect(screen.getByText('Screen time: 0 min')).toBeTruthy();
  });

  it('shows what moved to next week and why, and the missed-workout count (R9.3, R8.1)', async () => {
    await renderReview(createTestServices({ reviews: { [WEEK]: fullReview } }));
    const moved = await screen.findByTestId('review-section-moved');
    expect(within(moved).getByRole('header', { name: 'Moved to next week (1)' })).toBeTruthy();
    expect(within(moved).getByText('Taxes')).toBeTruthy();
    expect(within(moved).getByText('Why: No free time left this week')).toBeTruthy();
    expect(screen.getByText('Workouts missed: 1')).toBeTruthy();
  });

  it('shows empty-state text for an empty week', async () => {
    await renderReview();
    await screen.findByTestId('review-section-finished');
    expect(screen.getAllByText(EMPTY_SECTION_TEXT)).toHaveLength(3);
    expect(screen.getByText(NOTHING_MOVED_TEXT)).toBeTruthy();
    expect(screen.getByText('Workouts missed: 0')).toBeTruthy();
  });

  it('opens Intake from "Paste or type next week\'s to-do list" (R9.4)', async () => {
    await renderReview();
    const prompt = await screen.findByRole('button', { name: "Paste or type next week's to-do list" });
    await act(async () => {
      fireEvent.press(prompt);
    });
    expect(await screen.findByTestId('screen-Intake')).toBeTruthy();
  });

  it('shows an error with Try again when building fails, and retries', async () => {
    const services = createTestServices();
    services.review.build.mockRejectedValueOnce(new Error('boom'));
    await renderReview(services);
    expect(await screen.findByRole('alert')).toHaveTextContent(REVIEW_ERROR_MESSAGE);
    await act(async () => {
      fireEvent.press(screen.getByRole('button', { name: 'Try again' }));
    });
    expect(services.review.build).toHaveBeenCalledTimes(2);
    expect(await screen.findByTestId('review-section-finished')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
