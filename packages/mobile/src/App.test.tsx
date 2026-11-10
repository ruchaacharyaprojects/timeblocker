/**
 * App root tests (R14.1): services reach the screens through context, the
 * navigator is auth-gated, `onLaunch` runs on mount, and `onForeground` runs
 * each time `AppState` turns `active`.
 */
import React from 'react';
import { AppState, type AppStateStatus } from 'react-native';
import { act, render, screen, waitFor } from '@testing-library/react-native';
import App, { type AppRootRuntime } from './App';
import { createTestServices } from './services/testServices';
import { darkTheme } from './theme';

jest.mock('react-native-safe-area-context', () => require('react-native-safe-area-context/jest/mock').default);
// The real composition root is covered by bootstrap.test.ts; here App gets a fake runtime.
jest.mock('./bootstrap', () => ({ getAppRuntime: jest.fn() }));
const getAppRuntime = jest.requireMock<{ getAppRuntime: jest.Mock }>('./bootstrap').getAppRuntime;

type ChangeListener = (state: AppStateStatus) => void;

function fakeRuntime(seed: Parameters<typeof createTestServices>[0] = {}) {
  const services = createTestServices(seed);
  const lifecycle = {
    onLaunch: jest.fn(async () => ({ signedIn: false, backgroundStarted: false, reconciled: false, errors: [] })),
    onForeground: jest.fn(async () => ({ signedIn: false, errors: [] })),
  };
  const runtime: AppRootRuntime = { services, lifecycle };
  return { runtime, services, lifecycle };
}

let listeners: ChangeListener[];
let remove: jest.Mock;

beforeEach(() => {
  listeners = [];
  remove = jest.fn();
  jest.spyOn(AppState, 'addEventListener').mockImplementation((type, listener) => {
    if (type === 'change') listeners.push(listener as ChangeListener);
    return { remove } as ReturnType<typeof AppState.addEventListener>;
  });
});

afterEach(() => jest.restoreAllMocks());

const emit = async (state: AppStateStatus) => {
  await act(async () => {
    for (const l of listeners) l(state);
  });
};

describe('App', () => {
  it('renders SignIn through the provider when signed out and calls onLaunch once on mount', async () => {
    const { runtime, lifecycle } = fakeRuntime();
    await render(<App runtime={runtime} />);
    expect(await screen.findByRole('button', { name: /sign in with google/i })).toBeTruthy();
    expect(lifecycle.onLaunch).toHaveBeenCalledTimes(1);
    expect(lifecycle.onForeground).not.toHaveBeenCalled();
  });

  it('calls onForeground when AppState returns to active, not on other changes', async () => {
    const { runtime, lifecycle } = fakeRuntime();
    await render(<App runtime={runtime} />);
    await screen.findByRole('button', { name: /sign in with google/i });

    await emit('background');
    expect(lifecycle.onForeground).not.toHaveBeenCalled();
    await emit('active');
    expect(lifecycle.onForeground).toHaveBeenCalledTimes(1);
    // A repeated `active` without leaving it is not a new foreground.
    await emit('active');
    expect(lifecycle.onForeground).toHaveBeenCalledTimes(1);
    await emit('inactive');
    await emit('active');
    expect(lifecycle.onForeground).toHaveBeenCalledTimes(2);
    expect(lifecycle.onLaunch).toHaveBeenCalledTimes(1);
  });

  it('re-reads the auth state after a lifecycle step so a session end shows SignIn', async () => {
    const { runtime, services, lifecycle } = fakeRuntime({ authState: { status: 'signed-in' } });
    lifecycle.onForeground.mockImplementation(async () => {
      // The sync ended the session while the app was in the foreground.
      services.state.authState = { status: 'session-ended', reason: 'revoked' };
      return { signedIn: true, errors: [] };
    });
    await render(<App runtime={runtime} />);
    await waitFor(() => expect(services.auth.state).toHaveBeenCalled());
    await act(async () => {});
    expect(screen.queryByRole('button', { name: /sign in with google/i })).toBeNull();

    await emit('background');
    await emit('active');
    expect(await screen.findByRole('button', { name: /sign in with google/i })).toBeTruthy();
  });

  it('uses the process-wide runtime from bootstrap by default', async () => {
    const { runtime, lifecycle } = fakeRuntime();
    getAppRuntime.mockReturnValue(runtime);
    await render(<App />);
    expect(await screen.findByRole('button', { name: /sign in with google/i })).toBeTruthy();
    expect(getAppRuntime).toHaveBeenCalled();
    expect(lifecycle.onLaunch).toHaveBeenCalledTimes(1);
  });

  it('removes the AppState subscription on unmount', async () => {
    const { runtime } = fakeRuntime();
    const view = await render(<App runtime={runtime} />);
    await screen.findByRole('button', { name: /sign in with google/i });
    await act(async () => view.unmount());
    expect(remove).toHaveBeenCalledTimes(1);
  });
  it('wraps the navigator in the ThemeProvider, which reads the saved appearance', async () => {
    const { runtime, services } = fakeRuntime({
      authState: { status: 'signed-in' },
      settings: { planningMode: 'spread', holidays: [], distractionApps: [], themeMode: 'dark' },
    });
    await render(<App runtime={runtime} />);
    const dashboard = await screen.findByTestId('screen-Dashboard');
    expect(services.settings.get).toHaveBeenCalled();
    await waitFor(() => expect(dashboard).toHaveStyle({ backgroundColor: darkTheme.background }));
  });
});
