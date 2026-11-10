/** Every route in the shipped app uses its real screen, never a placeholder. */
jest.mock('react-native-safe-area-context', () => require('react-native-safe-area-context/jest/mock').default);
import { PLACEHOLDER_SCREENS } from './placeholders';
import { DEFAULT_SCREENS } from './screens';
import { ROUTE_TITLES, SIGNED_IN_ROUTES, SIGNED_OUT_ROUTES, type RootRouteName } from './types';

describe('DEFAULT_SCREENS', () => {
  it('maps every route to a real screen', () => {
    const routes = Object.keys(PLACEHOLDER_SCREENS) as RootRouteName[];
    expect(Object.keys(DEFAULT_SCREENS).sort()).toEqual([...routes].sort());
    for (const route of routes) {
      expect(DEFAULT_SCREENS[route]).toBeDefined();
      expect(DEFAULT_SCREENS[route]).not.toBe(PLACEHOLDER_SCREENS[route]);
    }
  });
  it('uses the real Application helper screen', () => {
    expect(Object.keys(DEFAULT_SCREENS)).toContain('ApplicationHelper');
    expect(DEFAULT_SCREENS.ApplicationHelper.name).toBe('ApplicationHelperScreen');
  });
  it('includes PlanSummary in the route lists and titles', () => {
    expect(Object.keys(DEFAULT_SCREENS)).toContain('PlanSummary');
    expect([...SIGNED_IN_ROUTES, ...SIGNED_OUT_ROUTES].sort()).toEqual(Object.keys(DEFAULT_SCREENS).sort());
    expect(Object.keys(ROUTE_TITLES).sort()).toEqual(Object.keys(DEFAULT_SCREENS).sort());
  });
});
