/**
 * RootNavigator component tests (R11.2, R12.5, R14.12): only SignIn renders
 * while signed out or after a session end; signed in shows the dashboard;
 * deep links map to their routes.
 */
import React from 'react';
import { Pressable, Text } from 'react-native';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { getStateFromPath } from '@react-navigation/native';
import type { AuthState } from '@timeblocker/app-core';
import { RootNavigator, useAuthState, type RootNavigatorProps } from './RootNavigator';
import { createAuthStateStore, type AuthStateSource } from './authStateSource';
import { LINKING } from './linking';
import { PLACEHOLDER_SCREENS } from './placeholders';
import { ROUTE_TITLES, SIGNED_IN_ROUTES, type RootScreenProps, type RootStackParamList } from './types';

jest.mock('react-native-safe-area-context', () => require('react-native-safe-area-context/jest/mock').default);

/**
 * The navigator over placeholder screens, so these tests exercise routing
 * only (real screens need `AppServicesProvider` and have their own tests).
 */
function Nav({ screens, ...props }: RootNavigatorProps): React.JSX.Element {
  return <RootNavigator {...props} screens={{ ...PLACEHOLDER_SCREENS, ...screens }} />;
}

/** In-memory auth state with a push method for state changes. */
function fakeAuth(initial: AuthState): AuthStateSource & { push(next: AuthState): void } {
  let state = initial;
  const listeners = new Set<(s: AuthState) => void>();
  return {
    current: () => Promise.resolve(state),
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    push(next) {
      state = next;
      listeners.forEach((l) => l(next));
    },
  };
}

const linkingWith = (url: string) => ({ ...LINKING, getInitialURL: () => Promise.resolve(url) });

function expectOnlySignIn() {
  expect(screen.getByTestId('screen-SignIn')).toBeTruthy();
  for (const name of SIGNED_IN_ROUTES) expect(screen.queryByTestId(`screen-${name}`)).toBeNull();
}

describe('RootNavigator auth gate', () => {
  it('renders only SignIn when signed out (R11.2)', async () => {
    await render(<Nav authState={fakeAuth({ status: 'signed-out' })} />);
    expect(await screen.findByTestId('screen-SignIn')).toBeTruthy();
    expectOnlySignIn();
  });

  it('renders only SignIn when the session ended (R12.5, R14.12)', async () => {
    await render(<Nav authState={fakeAuth({ status: 'session-ended', reason: 'revoked' })} />);
    expect(await screen.findByTestId('screen-SignIn')).toBeTruthy();
    expectOnlySignIn();
  });

  it('shows the dashboard first when signed in', async () => {
    await render(<Nav authState={fakeAuth({ status: 'signed-in' })} />);
    expect(await screen.findByTestId('screen-Dashboard')).toBeTruthy();
    expect(screen.queryByTestId('screen-WeekView')).toBeNull();
    expect(screen.queryByTestId('screen-SignIn')).toBeNull();
    expect(SIGNED_IN_ROUTES[0]).toBe('Dashboard');
  });

  it('renders nothing before the auth state is known', async () => {
    const pending: AuthStateSource = { current: () => new Promise(() => {}), subscribe: () => () => {} };
    await render(<Nav authState={pending} />);
    expect(screen.queryByTestId('screen-SignIn')).toBeNull();
    expect(screen.queryByTestId('screen-Dashboard')).toBeNull();
  });

  it('moves to the dashboard on sign-in and back to SignIn when the session ends', async () => {
    const auth = fakeAuth({ status: 'signed-out' });
    await render(<Nav authState={auth} />);
    await screen.findByTestId('screen-SignIn');

    await act(async () => auth.push({ status: 'signed-in' }));
    expect(await screen.findByTestId('screen-Dashboard')).toBeTruthy();
    expect(screen.queryByTestId('screen-SignIn')).toBeNull();

    await act(async () => auth.push({ status: 'session-ended', reason: 'invalid-grant' }));
    expect(await screen.findByTestId('screen-SignIn')).toBeTruthy();
    expectOnlySignIn();
  });

  it('gives screens the current auth state through useAuthState', async () => {
    function SignInProbe(_: RootScreenProps<'SignIn'>) {
      const { status } = useAuthState();
      return <Text testID="screen-SignIn">{status}</Text>;
    }
    await render(
      <Nav authState={fakeAuth({ status: 'session-ended', reason: 'revoked' })} screens={{ SignIn: SignInProbe }} />,
    );
    expect(await screen.findByText('session-ended')).toBeTruthy();
  });
});

describe('RootNavigator deep links', () => {
  it('maps each timeblocker:// link to its route', () => {
    const route = (path: string) => {
      const state = getStateFromPath<RootStackParamList>(path, LINKING.config);
      const top = state?.routes[state.routes.length - 1];
      return { name: top?.name, params: top?.params };
    };
    expect(route('block/b1')).toEqual({ name: 'BlockDetail', params: { blockId: 'b1' } });
    expect(route('nothing-fits/b2')).toEqual({ name: 'NothingFits', params: { blockId: 'b2' } });
    expect(route('review')).toMatchObject({ name: 'SaturdayReview' });
    // The plan summary carries a list of ids, so it has no deep link.
    expect(getStateFromPath<RootStackParamList>('plan-summary', LINKING.config)).toBeUndefined();
    expect(route('intake')).toMatchObject({ name: 'Intake' });
    expect(route('dashboard')).toMatchObject({ name: 'Dashboard' });
    expect(route('week')).toMatchObject({ name: 'WeekView' });
    // The review step is gone, so `items` is no longer a link.
    expect(getStateFromPath<RootStackParamList>('items', LINKING.config)).toBeUndefined();
    // The dashboard sits under a linked screen so Back returns to it.
    expect(getStateFromPath<RootStackParamList>('block/b1', LINKING.config)?.routes[0]?.name).toBe('Dashboard');
    expect(getStateFromPath<RootStackParamList>('week', LINKING.config)?.routes.map((r) => r.name)).toEqual([
      'Dashboard',
      'WeekView',
    ]);
    expect(LINKING.prefixes).toEqual(['timeblocker://']);
  });

  it('opens BlockDetail from a link when signed in', async () => {
    await render(
      <Nav authState={fakeAuth({ status: 'signed-in' })} linking={linkingWith('timeblocker://block/b1')} />,
    );
    expect(await screen.findByTestId('screen-BlockDetail')).toBeTruthy();
    expect(screen.getByText(JSON.stringify({ blockId: 'b1' }))).toBeTruthy();
  });

  it('opens the dashboard from timeblocker://dashboard', async () => {
    await render(
      <Nav authState={fakeAuth({ status: 'signed-in' })} linking={linkingWith('timeblocker://dashboard')} />,
    );
    expect(await screen.findByTestId('screen-Dashboard')).toBeTruthy();
  });

  it('opens the week view from timeblocker://week', async () => {
    await render(<Nav authState={fakeAuth({ status: 'signed-in' })} linking={linkingWith('timeblocker://week')} />);
    expect(await screen.findByTestId('screen-WeekView')).toBeTruthy();
  });

  it('keeps a link opened while signed out on SignIn, then applies it after sign-in', async () => {
    const auth = fakeAuth({ status: 'signed-out' });
    await render(<Nav authState={auth} linking={linkingWith('timeblocker://nothing-fits/b2')} />);
    await screen.findByTestId('screen-SignIn');
    expectOnlySignIn();

    await act(async () => auth.push({ status: 'signed-in' }));
    expect(await screen.findByTestId('screen-NothingFits')).toBeTruthy();
    expect(screen.queryByTestId('screen-SignIn')).toBeNull();
  });
});

describe('PlanSummary route', () => {
  it('is a signed-in route with a title and no deep link', () => {
    expect(SIGNED_IN_ROUTES).toContain('PlanSummary');
    expect(ROUTE_TITLES.PlanSummary).toBe('Plan summary');
    expect(getStateFromPath<RootStackParamList>('plan-summary', LINKING.config)).toBeUndefined();
  });
  it('opens with its params and Back returns to the dashboard after a reset', async () => {
    const params: RootStackParamList['PlanSummary'] = {
      weekId: '2025-01-05',
      blockIds: ['b1'],
      unplacedItemIds: ['i1'],
      mode: 'next-week',
      notes: ['Dentist: Date in the past was ignored'],
      reasons: { i1: 'clash' },
      otherWeeks: [{ weekId: '2025-01-12', blockIds: ['o1'], unplacedItemIds: ['o2'], reasons: { o2: 'past' } }],
    };
    function Home({ navigation }: RootScreenProps<'Dashboard'>) {
      return (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Go"
          onPress={() =>
            navigation.reset({ index: 1, routes: [{ name: 'Dashboard' }, { name: 'PlanSummary', params }] })
          }
        />
      );
    }
    function Summary({ route, navigation }: RootScreenProps<'PlanSummary'>) {
      return (
        <>
          <Text testID="screen-PlanSummary">{JSON.stringify(route.params)}</Text>
          <Pressable accessibilityRole="button" accessibilityLabel="Back" onPress={() => navigation.goBack()} />
        </>
      );
    }
    await render(<Nav authState={fakeAuth({ status: 'signed-in' })} screens={{ Dashboard: Home, PlanSummary: Summary }} />);
    await act(async () => {
      void fireEvent.press(await screen.findByRole('button', { name: 'Go' }));
    });
    expect(JSON.parse((await screen.findByTestId('screen-PlanSummary')).props.children)).toEqual(params);
    await act(async () => {
      void fireEvent.press(screen.getByRole('button', { name: 'Back' }));
    });
    expect(await screen.findByRole('button', { name: 'Go' })).toBeTruthy();
    expect(screen.queryByTestId('screen-PlanSummary')).toBeNull();
  });
});
describe('ApplicationHelper route', () => {
  it('is a signed-in route titled "Help me start" with no deep link', () => {
    expect(SIGNED_IN_ROUTES).toContain('ApplicationHelper');
    expect(ROUTE_TITLES.ApplicationHelper).toBe('Help me start');
    expect(getStateFromPath<RootStackParamList>('application-helper', LINKING.config)).toBeUndefined();
    expect(getStateFromPath<RootStackParamList>('application-helper/b1', LINKING.config)).toBeUndefined();
  });
  it('receives {blockId, weekId} from BlockDetail-style navigation', async () => {
    const params: RootStackParamList['ApplicationHelper'] = { blockId: 'b1', weekId: '2025-01-05' };
    function Home({ navigation }: RootScreenProps<'Dashboard'>) {
      return (
        <Pressable accessibilityRole="button" accessibilityLabel="Go" onPress={() => navigation.navigate('ApplicationHelper', params)} />
      );
    }
    function Helper({ route }: RootScreenProps<'ApplicationHelper'>) {
      return <Text testID="screen-ApplicationHelper">{JSON.stringify(route.params)}</Text>;
    }
    await render(<Nav authState={fakeAuth({ status: 'signed-in' })} screens={{ Dashboard: Home, ApplicationHelper: Helper }} />);
    await act(async () => {
      void fireEvent.press(await screen.findByRole('button', { name: 'Go' }));
    });
    expect(JSON.parse((await screen.findByTestId('screen-ApplicationHelper')).props.children)).toEqual(params);
  });
});
describe('createAuthStateStore', () => {
  it('re-reads on refresh and notifies subscribers until unsubscribed', async () => {
    let stored: AuthState = { status: 'signed-out' };
    const store = createAuthStateStore(() => Promise.resolve(stored));
    const seen: AuthState[] = [];
    const unsubscribe = store.subscribe((s) => seen.push(s));

    stored = { status: 'signed-in' };
    expect(await store.refresh()).toEqual({ status: 'signed-in' });
    expect(await store.current()).toEqual({ status: 'signed-in' });
    unsubscribe();
    stored = { status: 'session-ended', reason: 'revoked' };
    await store.refresh();
    expect(seen).toEqual([{ status: 'signed-in' }]);
  });
});
