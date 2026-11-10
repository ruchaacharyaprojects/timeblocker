/** GridBlock geometry and rendering (R16). */
import React from 'react';
import { StyleSheet } from 'react-native';
import { fireEvent, render, screen } from '@testing-library/react-native';
import type { GridItem } from '@timeblocker/app-core';
import { GridBlock, itemGeometry, titleLines } from './GridBlock';
import { HOUR_HEIGHT, hourLabel } from './constants';

function item(overrides: Partial<GridItem> = {}): GridItem {
  return {
    id: 'x',
    kind: 'block',
    title: 'Run',
    topMin: 90,
    heightMin: 60,
    lane: 0,
    laneCount: 1,
    style: { fill: '#112233', border: '#445566', borderStyle: 'solid', text: '#FFFFFF' },
    timeLabel: '1:30 AM to 2:30 AM',
    a11yLabel: 'Run, Fitness',
    ...overrides,
  };
}

describe('itemGeometry', () => {
  it('maps minutes to dp and lanes to percentages', () => {
    expect(itemGeometry(item())).toEqual({ top: 1.5 * HOUR_HEIGHT, height: HOUR_HEIGHT - 2, left: '0%', width: '100%' });
    expect(itemGeometry(item({ lane: 2, laneCount: 4 }))).toMatchObject({ left: '50%', width: '25%' });
    expect(itemGeometry(item({ lane: 1, laneCount: 2 }))).toMatchObject({ left: '50%', width: '50%' });
  });

  it('keeps 15-minute items visible', () => {
    expect(itemGeometry(item({ heightMin: 15 })).height).toBe(HOUR_HEIGHT / 4 - 2);
  });
});

describe('titleLines / hourLabel', () => {
  it('uses one line below 30 minutes and up to three otherwise', () => {
    expect(titleLines(15)).toBe(1);
    expect(titleLines(29)).toBe(1);
    expect(titleLines(30)).toBe(3);
  });

  it('formats gutter labels', () => {
    expect([0, 1, 11, 12, 13, 23].map(hourLabel)).toEqual(['', '1 AM', '11 AM', '12 PM', '1 PM', '11 PM']);
  });
});

describe('GridBlock', () => {
  it('applies fill, border style and text color, and reports presses', async () => {
    const onPress = jest.fn();
    const it1 = item({ style: { fill: '#FFFFFF', border: '#999999', borderStyle: 'dashed', text: '#111111' }, kind: 'calendar' });
    await render(<GridBlock item={it1} onPress={onPress} />);
    const node = screen.getByTestId('grid-item-x');
    expect(StyleSheet.flatten(node.props.style)).toMatchObject({ backgroundColor: '#FFFFFF', borderColor: '#999999', borderStyle: 'dashed' });
    expect(screen.getByText('Run').props.style).toEqual(expect.arrayContaining([{ color: '#111111' }]));
    expect(screen.getByRole('button', { name: 'Run, Fitness' })).toBeTruthy();
    await fireEvent.press(node);
    expect(onPress).toHaveBeenCalledWith(it1);
  });

  it('limits title lines by height and adds the bell label', async () => {
    await render(<GridBlock item={item({ heightMin: 15, indicator: true })} onPress={jest.fn()} />);
    expect(screen.getByText(/Run/).props.numberOfLines).toBe(1);
    expect(screen.getByTestId('bell-x')).toBeTruthy();
    expect(screen.getByLabelText('Run, Fitness, Needs attention')).toBeTruthy();
  });
});
