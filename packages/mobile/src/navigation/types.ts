/**
 * Route names and params for the root stack (design: "Navigation and
 * screens"). This file is the navigator's contract with the screens built in
 * tasks 24.2-24.8: screens type their props as `RootScreenProps<'Name'>` and
 * navigate with `navigation.navigate('Name', params)`.
 *
 * Params stay small and serializable (ids only). Screen data (intake draft,
 * blocks, review, settings) is read from the app-core services, not passed
 * through navigation.
 */
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type React from 'react';

/** Why planning left an item out. */
export type PlanSummaryReason = 'clash' | 'past' | 'no-time-before-deadline' | 'no-fit';

/** One extra week of a summary (tasks dated in a later week). */
export interface PlanSummaryWeek {
  weekId: string;
  blockIds: string[];
  unplacedItemIds: string[];
  reasons?: Record<string, PlanSummaryReason>;
}

export type RootStackParamList = {
  /** Google sign-in. The only route while not signed in (R11.2, R12.5, R14.12). */
  SignIn: undefined;
  /** Home dashboard (`timeblocker://dashboard`); the first app route after sign-in. */
  Dashboard: undefined;
  /** Current Toronto week (`timeblocker://week`). */
  WeekView: undefined;
  /** Paste box (`timeblocker://intake`). */
  Intake: undefined;
  /** `timeblocker://block/<blockId>`. `weekId` is optional (deep links carry only the id). */
  BlockDetail: { blockId: string; weekId?: string };
  /**
   * `timeblocker://nothing-fits/<blockId>` after "Move it" finds no slot, or
   * the unplaced items from planning (`itemIds`, no `blockId`).
   */
  NothingFits: { blockId?: string; weekId?: string; itemIds?: string[] };
  /**
   * What a Submit did: the added blocks, the items that did not fit, and the
   * ignored sleep lines. `mode: 'next-week'` after "Move these to next week".
   */
  PlanSummary: {
    weekId: string;
    blockIds: string[];
    unplacedItemIds: string[];
    ignored?: { text: string; reason: 'sleep' }[];
    mode?: 'this-week' | 'next-week';
    /** Schedule notes ("Dentist: Date in the past was ignored"). */
    notes?: string[];
    /** Why an item was not placed, by unplaced item id (R28.2, R28.5). */
    reasons?: Record<string, PlanSummaryReason>;
    /** Other weeks that also received tasks from the same Submit (R28.7). */
    otherWeeks?: PlanSummaryWeek[];
  };
  /** "Help me start" (R34): talking points, email draft, or study steps. No deep link. */
  ApplicationHelper: { blockId: string; weekId: string };
  /** Saturday review (`timeblocker://review`). */
  SaturdayReview: undefined;
  Settings: undefined;
};

export type RootRouteName = keyof RootStackParamList;

/** Props every root screen receives. */
export type RootScreenProps<Name extends RootRouteName> = NativeStackScreenProps<
  RootStackParamList,
  Name
>;

/** One component per route. */
export type RootScreenMap = {
  [Name in RootRouteName]: React.ComponentType<RootScreenProps<Name>>;
};

/** Routes rendered only while signed out or after a session end. */
export const SIGNED_OUT_ROUTES = ['SignIn'] as const satisfies readonly RootRouteName[];

/** Routes rendered only while signed in. `Dashboard` is first (the landing route). */
export const SIGNED_IN_ROUTES = [
  'Dashboard',
  'WeekView',
  'Intake',
  'BlockDetail',
  'ApplicationHelper',
  'NothingFits',
  'PlanSummary',
  'SaturdayReview',
  'Settings',
] as const satisfies readonly RootRouteName[];

/** Header titles for the signed-in routes. */
export const ROUTE_TITLES: Readonly<Record<RootRouteName, string>> = {
  SignIn: 'Sign in',
  Dashboard: 'Home',
  WeekView: 'This week',
  Intake: 'Plan your week',
  BlockDetail: 'Block',
  ApplicationHelper: 'Help me start',
  NothingFits: 'Nothing fits',
  PlanSummary: 'Plan summary',
  SaturdayReview: 'Saturday review',
  Settings: 'Settings',
};
