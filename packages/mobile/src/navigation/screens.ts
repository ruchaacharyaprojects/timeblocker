/**
 * The screen for each route. The route names and params in `./types` do not
 * change; tests can override any entry through RootNavigator's `screens` prop.
 */
import { ApplicationHelperScreen } from '../screens/ApplicationHelperScreen';
import { BlockDetailScreen } from '../screens/BlockDetailScreen';
import { DashboardScreen } from '../screens/DashboardScreen';
import { IntakeScreen } from '../screens/IntakeScreen';
import { NothingFitsScreen } from '../screens/NothingFitsScreen';
import { PlanSummaryScreen } from '../screens/PlanSummaryScreen';
import { SaturdayReviewScreen } from '../screens/SaturdayReviewScreen';
import { SettingsScreen } from '../screens/SettingsScreen';
import { SignInScreen } from '../screens/SignInScreen';
import { WeekViewScreen } from '../screens/WeekViewScreen';
import type { RootScreenMap } from './types';

export const DEFAULT_SCREENS: RootScreenMap = {
  SignIn: SignInScreen,
  Dashboard: DashboardScreen,
  WeekView: WeekViewScreen,
  Intake: IntakeScreen,
  BlockDetail: BlockDetailScreen,
  ApplicationHelper: ApplicationHelperScreen,
  NothingFits: NothingFitsScreen,
  PlanSummary: PlanSummaryScreen,
  SaturdayReview: SaturdayReviewScreen,
  Settings: SettingsScreen,
};
