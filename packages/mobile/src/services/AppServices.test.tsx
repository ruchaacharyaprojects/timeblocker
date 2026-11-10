/**
 * AppServices context tests: the real app-core classes satisfy every port
 * (checked by `tsc`), the hook requires the provider, and the test fakes
 * plug in.
 */
import React from 'react';
import { Text } from 'react-native';
import { render, screen } from '@testing-library/react-native';
import type {
  AiPort,
  AiProfileService,
  AuthService,
  BlockActionService,
  Clock,
  IntakeService,
  NotificationService,
  Notifier,
  PlanResult,
  PlanningService,
  Repositories,
  ReviewService,
  SettingsService,
  SyncService,
  SystemSettings,
  WeekResetService,
  UsageSource,
} from '@timeblocker/app-core';
import { AppServicesProvider, useAppServices, type AppServices } from './AppServices';
import { createTestServices } from './testServices';

/** What the composition root (25.1) passes: the real instances, unchanged. */
interface RealServices {
  auth: AuthService;
  intake: IntakeService<PlanResult>;
  planning: PlanningService;
  weekReset: WeekResetService;
  sync: SyncService;
  notifications: NotificationService;
  blockActions: BlockActionService;
  review: ReviewService;
  dashboard: AppServices['dashboard'];
  settings: SettingsService;
  holidays: AppServices['holidays'];
  repos: Repositories;
  systemSettings: SystemSettings;
  usage: UsageSource;
  notificationPermission: Notifier;
  clock: Clock;
  sleepData: AppServices['sleepData'];
  ai: AiPort;
  aiProfile: AiProfileService;
}

// Compile-time: fails `tsc --noEmit` if a port drifts from app-core.
const fromReal = (real: RealServices, authState: AppServices['authState']): AppServices => ({ ...real, authState });

function Probe(): React.JSX.Element {
  const { review } = useAppServices();
  return <Text>{review.currentWeekId()}</Text>;
}

describe('AppServices', () => {
  it('accepts the real app-core classes', () => {
    expect(typeof fromReal).toBe('function');
  });

  it('gives screens the provided services', async () => {
    const services = createTestServices();
    await render(
      <AppServicesProvider services={services}>
        <Probe />
      </AppServicesProvider>,
    );
    expect(screen.getByText(services.review.currentWeekId())).toBeTruthy();
  });

  it('exposes reconnect on the auth port (typed from AuthService)', () => {
    const reconnect: AppServices['auth']['reconnect'] = createTestServices().auth.reconnect;
    expect(typeof reconnect).toBe('function');
  });
  it('throws outside the provider', async () => {
    const error = jest.spyOn(console, 'error').mockImplementation(() => {});
    await expect(render(<Probe />)).rejects.toThrow('useAppServices must be used inside AppServicesProvider');
    error.mockRestore();
  });
});
