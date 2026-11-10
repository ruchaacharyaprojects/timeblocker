/**
 * SignIn screen tests (R11.2, R11.3, R12.1, R12.5, R12.11): each message,
 * busy state, retry availability, and the navigator switch after sign-in.
 * Rendered through the real `RootNavigator` so the auth gate is exercised.
 */
import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import {
  CALENDAR_ACCESS_REQUIRED_MESSAGE,
  SESSION_ENDED_MESSAGE,
  SIGN_IN_INCOMPLETE_MESSAGE,
  type AuthState,
  type SignInResult,
} from '@timeblocker/app-core';
import { RootNavigator } from '../navigation/RootNavigator';
import { AppServicesProvider } from '../services/AppServices';
import { createTestServices } from '../services/testServices';

jest.mock('react-native-safe-area-context', () => require('react-native-safe-area-context/jest/mock').default);

const incomplete: SignInResult = { ok: false, reason: 'incomplete', message: SIGN_IN_INCOMPLETE_MESSAGE };
const calendarRequired: SignInResult = {
  ok: false,
  reason: 'calendar-access-required',
  message: CALENDAR_ACCESS_REQUIRED_MESSAGE,
};

async function renderSignIn(authState: AuthState = { status: 'signed-out' }) {
  const services = createTestServices({ authState });
  jest.spyOn(services.authState, 'refresh');
  await render(
    <AppServicesProvider services={services}>
      <RootNavigator authState={services.authState} />
    </AppServicesProvider>,
  );
  await screen.findByTestId('screen-SignIn');
  return services;
}

const button = () => screen.getByRole('button', { name: 'Sign in with Google' });

describe('SignInScreen', () => {
  it('shows an accessible "Sign in with Google" button and no message when signed out (R11.2)', async () => {
    await renderSignIn();
    expect(button()).toBeEnabled();
    expect(screen.getByRole('header', { name: 'TimeBlocker' })).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('signs in, refreshes the auth state, and leaves SignIn for the dashboard', async () => {
    const services = await renderSignIn();
    await act(async () => {
      fireEvent.press(button());
    });
    expect(services.auth.signIn).toHaveBeenCalledTimes(1);
    expect(services.authState.refresh).toHaveBeenCalledTimes(1);
    expect(await screen.findByTestId('screen-Dashboard')).toBeTruthy();
    expect(screen.queryByTestId('screen-SignIn')).toBeNull();
  });

  it('shows the incomplete message on cancel/failure and keeps retry available (R11.3)', async () => {
    const services = await renderSignIn();
    services.auth.signIn.mockResolvedValueOnce(incomplete);
    await act(async () => {
      fireEvent.press(button());
    });
    expect(screen.getByRole('alert')).toHaveTextContent(SIGN_IN_INCOMPLETE_MESSAGE);
    expect(screen.getByTestId('screen-SignIn')).toBeTruthy();
    expect(services.authState.refresh).not.toHaveBeenCalled();
    expect(button()).toBeEnabled();

    // Retry succeeds with the default fake.
    await act(async () => {
      fireEvent.press(button());
    });
    expect(services.auth.signIn).toHaveBeenCalledTimes(2);
    expect(await screen.findByTestId('screen-Dashboard')).toBeTruthy();
  });

  it('shows the Calendar-access message when the scope is missing or consent denied (R12.1, R12.11)', async () => {
    const services = await renderSignIn();
    services.auth.signIn.mockResolvedValueOnce(calendarRequired);
    await act(async () => {
      fireEvent.press(button());
    });
    expect(screen.getByRole('alert')).toHaveTextContent(CALENDAR_ACCESS_REQUIRED_MESSAGE);
    expect(screen.queryByText(SIGN_IN_INCOMPLETE_MESSAGE)).toBeNull();
    expect(services.state.authState).toEqual({ status: 'signed-out' });
    expect(button()).toBeEnabled();
  });

  it('treats a thrown sign-in error as incomplete', async () => {
    const services = await renderSignIn();
    services.auth.signIn.mockRejectedValueOnce(new Error('boom'));
    await act(async () => {
      fireEvent.press(button());
    });
    expect(screen.getByRole('alert')).toHaveTextContent(SIGN_IN_INCOMPLETE_MESSAGE);
    expect(button()).toBeEnabled();
  });

  it('shows "Your Google session ended" after a session end, replaced by the result of a new attempt (R12.5)', async () => {
    const services = await renderSignIn({ status: 'session-ended', reason: 'invalid-grant' });
    expect(screen.getByRole('alert')).toHaveTextContent(SESSION_ENDED_MESSAGE);
    expect(button()).toBeEnabled();

    services.auth.signIn.mockResolvedValueOnce(calendarRequired);
    await act(async () => {
      fireEvent.press(button());
    });
    expect(screen.queryByText(SESSION_ENDED_MESSAGE)).toBeNull();
    expect(screen.getByRole('alert')).toHaveTextContent(CALENDAR_ACCESS_REQUIRED_MESSAGE);
  });

  it('is busy and disabled while signing in, and does not start a second sign-in', async () => {
    const services = await renderSignIn();
    let finish: (result: SignInResult) => void = () => {};
    services.auth.signIn.mockImplementationOnce(() => new Promise<SignInResult>((resolve) => (finish = resolve)));
    await act(async () => {
      fireEvent.press(button());
    });
    const busyButton = screen.getByRole('button', { name: 'Sign in with Google' });
    expect(busyButton).toBeDisabled();
    expect(busyButton).toBeBusy();
    expect(screen.getByText('Signing in…')).toBeTruthy();
    await act(async () => {
      fireEvent.press(busyButton);
    });
    expect(services.auth.signIn).toHaveBeenCalledTimes(1);

    await act(async () => finish(incomplete));
    expect(button()).toBeEnabled();
    expect(screen.getByRole('alert')).toHaveTextContent(SIGN_IN_INCOMPLETE_MESSAGE);
  });
});
