/**
 * NothingFits screen tests (R2.3, R6.3, R8.1): the shrink/drop/roll options,
 * fitness never offering roll, each result's navigation, custom-length
 * validation, and the unplaced-items mode from planning.
 */
import React from 'react';
import { Text, View } from 'react-native';
import { fireEvent, render, screen } from '@testing-library/react-native';
import { NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { CATEGORIES, weekIdAt, type DeviceBlock, type NothingFitsResult } from '@timeblocker/app-core';
import type { IntakeItem } from '@timeblocker/flows';

type Category = (typeof CATEGORIES)[number];
import type { RootScreenProps, RootStackParamList } from '../navigation/types';
import { AppServicesProvider } from '../services/AppServices';
import { TEST_NOW, createTestServices } from '../services/testServices';
import { NOTHING_FITS_MESSAGES, NothingFitsScreen, customLengthError, stillDoesntFitMessage } from './NothingFitsScreen';

jest.mock('react-native-safe-area-context', () => require('react-native-safe-area-context/jest/mock').default);

const WEEK = weekIdAt(TEST_NOW);
const Stack = createNativeStackNavigator<RootStackParamList>();

function makeBlock(overrides: Partial<DeviceBlock> = {}): DeviceBlock {
  return {
    id: 'b1',
    itemId: 'i1',
    title: 'Write report',
    start: '2025-01-09T18:00:00.000Z',
    end: '2025-01-09T19:00:00.000Z',
    category: 'work',
    status: 'scheduled',
    weekId: WEEK,
    calendarEventId: 'evt1',
    calendarSynced: true,
    promptedMeetingIds: [],
    usagePrompted: false,
    updatedAt: TEST_NOW,
    ...overrides,
  };
}

function Stub({ route }: { route: { name: string; params?: object } }) {
  return (
    <View testID={`screen-${route.name}`}>
      <Text testID={`params-${route.name}`}>{JSON.stringify(route.params ?? null)}</Text>
    </View>
  );
}

async function renderScreen(
  params: RootStackParamList['NothingFits'],
  seed: Parameters<typeof createTestServices>[0] = {},
) {
  const services = createTestServices({ authState: { status: 'signed-in' }, ...seed });
  await render(
    <AppServicesProvider services={services}>
      <NavigationContainer>
        <Stack.Navigator initialRouteName="NothingFits">
          <Stack.Screen name="WeekView" component={Stub as React.ComponentType<RootScreenProps<'WeekView'>>} />
          <Stack.Screen name="BlockDetail" component={Stub as React.ComponentType<RootScreenProps<'BlockDetail'>>} />
          <Stack.Screen name="Intake" component={Stub as React.ComponentType<RootScreenProps<'Intake'>>} />
          <Stack.Screen name="NothingFits" component={NothingFitsScreen} initialParams={params} />
        </Stack.Navigator>
      </NavigationContainer>
    </AppServicesProvider>,
  );
  await screen.findByTestId('screen-NothingFits');
  return services;
}

const button = (name: string | RegExp) => screen.getByRole('button', { name });
const press = async (name: string | RegExp) => {
  await fireEvent.press(button(name));
};

describe('NothingFitsScreen — block mode', () => {
  it('offers Shrink 75% / 50% / custom, Drop, and Roll for a non-fitness block (R2.3, R6.3)', async () => {
    await renderScreen({ blockId: 'b1', weekId: WEEK }, { blocks: { [WEEK]: [makeBlock()] } });
    expect(await screen.findByText('Write report')).toBeTruthy();
    expect(button('Shrink to 75% (45 min)')).toBeEnabled();
    expect(button('Shrink to 50% (30 min)')).toBeEnabled();
    expect(screen.getByLabelText('Custom length in minutes')).toBeTruthy();
    expect(button('Shrink to custom length')).toBeEnabled();
    expect(button('Drop')).toBeEnabled();
    expect(button('Roll to next week')).toBeEnabled();
  });

  it('never offers Roll for fitness, and labels Drop as counting as missed (R8.1)', async () => {
    await renderScreen({ blockId: 'b1', weekId: WEEK }, { blocks: { [WEEK]: [makeBlock({ category: 'fitness', title: 'Run' })] } });
    expect(await screen.findByText('Run')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Roll to next week' })).toBeNull();
    expect(button('Drop (counts as missed)')).toBeEnabled();
    expect(button('Shrink to 75% (45 min)')).toBeEnabled();
    expect(screen.getByText(NOTHING_FITS_MESSAGES.fitnessNoRoll)).toBeTruthy();
  });

  it.each(CATEGORIES.map((c) => [c] as [Category]))('%s: Roll is offered unless the block is fitness (R8.1)', async (category) => {
    await renderScreen({ blockId: 'b1', weekId: WEEK }, { blocks: { [WEEK]: [makeBlock({ category })] } });
    await screen.findByText('Write report');
    expect(screen.queryByRole('button', { name: 'Roll to next week' }) !== null).toBe(category !== 'fitness');
  });

  it('finds the block without a weekId (deep link) and shrinks it, then returns to the block', async () => {
    const block = makeBlock();
    const services = await renderScreen({ blockId: 'b1' }, { blocks: { [WEEK]: [block] } });
    await screen.findByText('Write report');
    const shrunk: NothingFitsResult = {
      kind: 'shrunk',
      block: { ...block, end: '2025-01-09T18:45:00.000Z' },
      from: { start: block.start, end: block.end },
      to: { start: block.start, end: '2025-01-09T18:45:00.000Z' },
      durationMin: 45,
    };
    services.blockActions.resolveNothingFits.mockResolvedValueOnce(shrunk);
    await press('Shrink to 75% (45 min)');
    expect(services.blockActions.resolveNothingFits).toHaveBeenCalledWith(
      { weekId: WEEK, blockId: 'b1' },
      { kind: 'shrink', to: '75%' },
    );
    expect(await screen.findByTestId('screen-BlockDetail')).toBeTruthy();
    expect(screen.getByTestId('params-BlockDetail')).toHaveTextContent(JSON.stringify({ blockId: 'b1', weekId: WEEK }));
  });

  it('stays with a message when the shorter block still does not fit', async () => {
    const block = makeBlock();
    const services = await renderScreen({ blockId: 'b1', weekId: WEEK }, { blocks: { [WEEK]: [block] } });
    await screen.findByText('Write report');
    services.blockActions.resolveNothingFits.mockResolvedValueOnce({
      kind: 'nothing-fits',
      block,
      durationMin: 30,
      alert: { message: 'Nothing fits', options: ['shrink', 'drop', 'roll-to-next-week'], items: [] },
    });
    await press('Shrink to 50% (30 min)');
    expect(screen.getByTestId('screen-NothingFits')).toBeTruthy();
    expect(screen.getByRole('alert')).toHaveTextContent(stillDoesntFitMessage(30));
    expect(button('Drop')).toBeEnabled();
  });

  it('validates the custom length (whole minutes, ≥ 15, shorter than the block) before calling the service', async () => {
    const services = await renderScreen({ blockId: 'b1', weekId: WEEK }, { blocks: { [WEEK]: [makeBlock()] } });
    await screen.findByText('Write report');
    const input = screen.getByLabelText('Custom length in minutes');
    for (const bad of ['10', '60', 'abc', '']) {
      await fireEvent.changeText(input, bad);
      await press('Shrink to custom length');
      expect(screen.getByTestId('nothing-fits-custom-error')).toHaveTextContent(customLengthError(60));
    }
    expect(services.blockActions.resolveNothingFits).not.toHaveBeenCalled();

    await fireEvent.changeText(input, '20');
    expect(screen.queryByTestId('nothing-fits-custom-error')).toBeNull();
    await press('Shrink to custom length');
    expect(services.blockActions.resolveNothingFits).toHaveBeenCalledWith(
      { weekId: WEEK, blockId: 'b1' },
      { kind: 'shrink', to: { customMin: 20 } },
    );
  });

  it.each<[string, string, NothingFitsResult['kind']]>([
    ['Drop', 'drop', 'dropped'],
    ['Roll to next week', 'roll', 'rolled'],
  ])('%s resolves and goes back to the week', async (label, kind, resultKind) => {
    const block = makeBlock();
    const services = await renderScreen({ blockId: 'b1', weekId: WEEK }, { blocks: { [WEEK]: [block] } });
    await screen.findByText('Write report');
    const result: NothingFitsResult =
      resultKind === 'dropped'
        ? { kind: 'dropped', blockId: 'b1', itemId: 'i1' }
        : {
            kind: 'rolled',
            block: { ...block, status: 'rolled' },
            nextWeekId: '2025-01-12',
            item: { id: 'i1', text: 'Write report', durationMin: 60, priority: 3, category: 'work', confirmed: true, weekId: '2025-01-12' },
          };
    services.blockActions.resolveNothingFits.mockResolvedValueOnce(result);
    await press(label);
    expect(services.blockActions.resolveNothingFits).toHaveBeenCalledWith({ weekId: WEEK, blockId: 'b1' }, { kind });
    expect(await screen.findByTestId('screen-WeekView')).toBeTruthy();
  });

  it('a fitness Drop records missed and goes back to the week (R8.1)', async () => {
    const block = makeBlock({ category: 'fitness' });
    const services = await renderScreen({ blockId: 'b1', weekId: WEEK }, { blocks: { [WEEK]: [block] } });
    await screen.findByText('Write report');
    services.blockActions.resolveNothingFits.mockResolvedValueOnce({ kind: 'missed', block: { ...block, status: 'missed' } });
    await press('Drop (counts as missed)');
    expect(services.blockActions.resolveNothingFits).toHaveBeenCalledWith({ weekId: WEEK, blockId: 'b1' }, { kind: 'drop' });
    expect(await screen.findByTestId('screen-WeekView')).toBeTruthy();
  });

  it('shows a message when the block is gone', async () => {
    await renderScreen({ blockId: 'missing', weekId: WEEK });
    expect(await screen.findByText(NOTHING_FITS_MESSAGES.notFound)).toBeTruthy();
    await press('Back to the week');
    expect(await screen.findByTestId('screen-WeekView')).toBeTruthy();
  });

  it('offers no choices for an already resolved block', async () => {
    await renderScreen({ blockId: 'b1', weekId: WEEK }, { blocks: { [WEEK]: [makeBlock({ status: 'rolled' })] } });
    await screen.findByText('Write report');
    expect(screen.queryByRole('button', { name: 'Drop' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Shrink/ })).toBeNull();
    expect(button('Back to the week')).toBeEnabled();
  });
});

describe('NothingFitsScreen — unplaced items from planning', () => {
  const item = (id: string, text: string, category: Category = 'work'): IntakeItem => ({
    id,
    text,
    durationMin: 90,
    priority: 2,
    category,
    confirmed: true,
    weekId: WEEK,
  });

  it('lists the unplaced items with an explanation and a way back to edit the list (R2.3)', async () => {
    await renderScreen(
      { itemIds: ['i2', 'i3'], weekId: WEEK },
      { items: { [WEEK]: [item('i1', 'Placed one'), item('i2', 'Deep work'), item('i3', 'Yoga', 'fitness')] } },
    );
    expect(await screen.findByText('Deep work')).toBeTruthy();
    expect(screen.getByText('Yoga')).toBeTruthy();
    expect(screen.queryByText('Placed one')).toBeNull();
    expect(screen.getByTestId('nothing-fits-items-intro')).toHaveTextContent(NOTHING_FITS_MESSAGES.itemsIntro);
    expect(screen.getByLabelText('Deep work, Work, 1 h 30 min, priority 2')).toBeTruthy();

    await press('Edit my list');
    expect(await screen.findByTestId('screen-Intake')).toBeTruthy();
  });

  it('uses the current week when no weekId is given, and goes back to the week', async () => {
    const services = await renderScreen({ itemIds: ['i2'] }, { items: { [WEEK]: [item('i2', 'Deep work')] } });
    expect(await screen.findByText('Deep work')).toBeTruthy();
    expect(services.repos.items.get).toHaveBeenCalledWith(WEEK);
    await press('Back to the week');
    expect(await screen.findByTestId('screen-WeekView')).toBeTruthy();
  });
});
