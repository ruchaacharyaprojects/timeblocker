/**
 * Deep links (design: "Navigation and screens"). The `timeblocker://` scheme
 * is separate from the OAuth redirect scheme. Links produced by app-core:
 *
 * - `timeblocker://block/<id>`        → BlockDetail { blockId }
 * - `timeblocker://nothing-fits/<id>` → NothingFits { blockId }
 * - `timeblocker://review`            → SaturdayReview
 * - `timeblocker://intake`            → Intake
 * - `timeblocker://dashboard`         → Dashboard
 * - `timeblocker://week`              → WeekView
 *
 * `initialRouteName: 'Dashboard'` puts the dashboard under a linked screen so
 * Back returns to it. A link opened while signed out is held by the
 * navigator and applied after sign-in (see `RootNavigator`).
 */
import type { LinkingOptions } from '@react-navigation/native';
import type { RootStackParamList } from './types';

export const DEEP_LINK_PREFIX = 'timeblocker://';

export const LINKING: LinkingOptions<RootStackParamList> = {
  prefixes: [DEEP_LINK_PREFIX],
  config: {
    initialRouteName: 'Dashboard',
    screens: {
      SignIn: 'sign-in',
      Dashboard: 'dashboard',
      WeekView: 'week',
      Intake: 'intake',
      BlockDetail: 'block/:blockId',
      NothingFits: 'nothing-fits/:blockId',
      SaturdayReview: 'review',
      Settings: 'settings',
    },
  },
};
