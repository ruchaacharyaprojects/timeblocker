/**
 * NothingFits screen (design: "Nothing-fits flow", "Navigation and screens";
 * R2.3, R6.3, R8.1).
 *
 * Two entry modes, from the `NothingFits` route params:
 *
 * - `blockId` (deep link `timeblocker://nothing-fits/<id>`, or "Move it" with
 *   no slot): shows the block and the choices from `nothingFitsOptionsFor`:
 *   Shrink (75%, 50%, or a custom whole number of minutes ≥ 15 and shorter
 *   than the block), Drop, and Roll to next week. Roll is never offered for
 *   fitness, and a fitness Drop is recorded as missed (R8.1). Each choice
 *   calls `blockActions.resolveNothingFits`:
 *   - `shrunk` → back to the block (`popTo('BlockDetail')`).
 *   - `nothing-fits` → stays here with "Still doesn't fit" so she can pick again.
 *   - `dropped` / `missed` / `rolled` → back to the week (`popTo('WeekView')`).
 *   - `rejected` / `not-found` → stays here with a message.
 * - `itemIds` (unplaced items from planning; they have no block yet): lists
 *   the items with an explanation, plus "Edit my list" (Intake) and "Back to
 *   the week". The services contract has no shrink/drop/roll for an item
 *   without a block, so those choices are only offered in block mode.
 *
 * When `weekId` is missing (deep links carry only the block id) the block is
 * looked up in last week, this week, and next week, like `BlockActionService`.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import {
  CATEGORY_LABELS,
  MIN_SHRINK_MIN,
  STATUS_LABELS,
  formatMinutes,
  formatTimeRange,
  nothingFitsOptionsFor,
  reconcileWeekIds,
  shrinkDurationMin,
  spanMinutes,
  weekIdAt,
  type DeviceBlock,
  type NothingFitsRejection,
  type NothingFitsResolution,
  type NothingFitsResult,
  type ShrinkTo,
} from '@timeblocker/app-core';
import type { IntakeItem } from '@timeblocker/flows';
import type { RootScreenProps } from '../navigation/types';
import { useAppServices, type RepositoryReaders } from '../services/AppServices';
import { useTheme, useThemedStyles, type Theme } from '../theme';

const WEEK_MS = 7 * 24 * 3_600_000;
/** Statuses a resolution still applies to (mirrors `BlockActionService`). */
const OPEN_STATUSES: readonly DeviceBlock['status'][] = ['scheduled', 'in-progress', 'skipped'];

export const NOTHING_FITS_MESSAGES = {
  blockIntro: "There's no free time left this week for this block. Choose what to do with it.",
  fitnessNoRoll: "Workouts stay in their own week, so this one can't roll to next week. Dropping it counts it as missed.",
  cannotShrink: `This block is already ${MIN_SHRINK_MIN} min or shorter, so it can't be shrunk.`,
  notFound: "This block isn't here anymore. It may have been moved or removed.",
  itemsIntro:
    "These items didn't fit anywhere in this week's free time, so they weren't put on your calendar. You can edit your list (shorten or remove items) and plan again.",
  itemsMissing: "These items aren't in this week's list anymore.",
  noItems: 'Nothing to resolve here.',
  failed: "That didn't work. Try again.",
} as const;

const REJECTION_MESSAGES: Readonly<Record<NothingFitsRejection, string>> = {
  'roll-not-offered': "Workouts can't roll to next week.",
  'invalid-duration': `Pick a length of at least ${MIN_SHRINK_MIN} min that's shorter than the block.`,
  'not-open': 'This block was already resolved.',
};

/** Text shown after a shrink that still doesn't fit. */
export const stillDoesntFitMessage = (durationMin: number): string =>
  `Still doesn't fit at ${formatMinutes(durationMin)}. Try a shorter length, drop it, or roll it.`;

/** Text shown for an invalid custom length. */
export const customLengthError = (currentMin: number): string =>
  `Enter a whole number of minutes from ${MIN_SHRINK_MIN} to ${currentMin - 1}.`;

/** Finds a block in `weekId`, or in last/this/next week when no week is given. */
async function findBlock(
  repos: RepositoryReaders,
  blockId: string,
  weekId: string | undefined,
  now: number,
): Promise<DeviceBlock | null> {
  const weekIds = weekId ? [weekId] : [...new Set([weekIdAt(now - WEEK_MS), ...reconcileWeekIds(now)])];
  for (const id of weekIds) {
    const block = (await repos.blocks.get(id)).find((b) => b.id === blockId);
    if (block) return block;
  }
  return null;
}

export function NothingFitsScreen({ route, navigation }: RootScreenProps<'NothingFits'>): React.JSX.Element {
  const { blockId, weekId, itemIds } = route.params ?? {};
  return blockId ? (
    <BlockMode blockId={blockId} weekId={weekId} navigation={navigation} />
  ) : (
    <ItemsMode itemIds={itemIds ?? []} weekId={weekId} navigation={navigation} />
  );
}

type Navigation = RootScreenProps<'NothingFits'>['navigation'];

// --- Block mode -------------------------------------------------------------------------

interface BlockModeProps {
  blockId: string;
  weekId?: string;
  navigation: Navigation;
}

function BlockMode({ blockId, weekId, navigation }: BlockModeProps): React.JSX.Element {
  const { repos, clock, blockActions } = useAppServices();
  const { theme } = useTheme();
  const styles = useThemedStyles(createStyles);
  const [block, setBlock] = useState<DeviceBlock | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [custom, setCustom] = useState('');
  const [customError, setCustomError] = useState<string | null>(null);
  const mounted = useRef(true);
  const inFlight = useRef(false);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    let active = true;
    findBlock(repos, blockId, weekId, clock.now())
      .then((found) => active && setBlock(found))
      .catch(() => active && setBlock(null));
    return () => {
      active = false;
    };
  }, [repos, clock, blockId, weekId]);

  const handleResult = useCallback(
    (result: NothingFitsResult) => {
      switch (result.kind) {
        case 'shrunk':
          navigation.popTo('BlockDetail', { blockId: result.block.id, weekId: result.block.weekId });
          return;
        case 'dropped':
        case 'missed':
        case 'rolled':
          navigation.popTo('WeekView');
          return;
        case 'nothing-fits':
          setBlock(result.block);
          setMessage(stillDoesntFitMessage(result.durationMin));
          return;
        case 'rejected':
          setMessage(REJECTION_MESSAGES[result.reason]);
          return;
        case 'not-found':
          setBlock(null);
          setMessage(null);
          return;
      }
    },
    [navigation],
  );

  const resolve = useCallback(
    async (resolution: NothingFitsResolution) => {
      if (!block || inFlight.current) return;
      inFlight.current = true;
      setBusy(true);
      setMessage(null);
      let result: NothingFitsResult | null = null;
      try {
        result = await blockActions.resolveNothingFits({ weekId: block.weekId, blockId: block.id }, resolution);
      } catch {
        result = null;
      } finally {
        inFlight.current = false;
      }
      if (!mounted.current) return;
      setBusy(false);
      if (result) handleResult(result);
      else setMessage(NOTHING_FITS_MESSAGES.failed);
    },
    [block, blockActions, handleResult],
  );

  if (block === undefined) {
    return (
      <View style={[styles.container, styles.center]} testID="screen-NothingFits">
        <ActivityIndicator accessibilityLabel="Loading" color={theme.outline} />
      </View>
    );
  }

  if (block === null) {
    return (
      <View style={styles.container} testID="screen-NothingFits">
        <Text accessibilityRole="header" style={styles.title}>
          Nothing fits
        </Text>
        <Text accessibilityRole="alert" style={styles.notice} testID="nothing-fits-message">
          {NOTHING_FITS_MESSAGES.notFound}
        </Text>
        <ActionButton label="Back to the week" onPress={() => navigation.popTo('WeekView')} testID="nothing-fits-back" />
      </View>
    );
  }

  const currentMin = spanMinutes(block);
  const options = nothingFitsOptionsFor(block);
  const fitness = block.category === 'fitness';
  const open = OPEN_STATUSES.includes(block.status);
  const shrinkChoices = (['75%', '50%'] as const)
    .map((to) => ({ to, minutes: shrinkDurationMin(currentMin, to) }))
    .filter((c): c is { to: '75%' | '50%'; minutes: number } => c.minutes !== null);
  // Both presets collapse to 15 min on short blocks; offer that length once.
  const presets = shrinkChoices.filter((c, i) => shrinkChoices.findIndex((o) => o.minutes === c.minutes) === i);
  const canShrink = options.includes('shrink') && currentMin > MIN_SHRINK_MIN;

  const onCustom = () => {
    const trimmed = custom.trim();
    const minutes = /^\d+$/.test(trimmed) ? Number(trimmed) : NaN;
    const to: ShrinkTo = { customMin: minutes };
    if (shrinkDurationMin(currentMin, to) === null) {
      setCustomError(customLengthError(currentMin));
      return;
    }
    setCustomError(null);
    void resolve({ kind: 'shrink', to });
  };

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content} testID="screen-NothingFits">
      <Text accessibilityRole="header" style={styles.title}>
        Nothing fits this week
      </Text>
      <View style={styles.card} testID="nothing-fits-block">
        <Text style={styles.itemTitle}>{block.title}</Text>
        <Text style={styles.meta}>
          {CATEGORY_LABELS[block.category]} · {formatMinutes(currentMin)} · {formatTimeRange(block.start, block.end)}
        </Text>
      </View>

      {open ? (
        <Text style={styles.body}>{NOTHING_FITS_MESSAGES.blockIntro}</Text>
      ) : (
        <Text accessibilityRole="alert" style={styles.notice} testID="nothing-fits-resolved">
          {`${REJECTION_MESSAGES['not-open']} Status: ${STATUS_LABELS[block.status]}.`}
        </Text>
      )}
      {fitness && open ? (
        <Text style={styles.body} testID="nothing-fits-fitness-note">
          {NOTHING_FITS_MESSAGES.fitnessNoRoll}
        </Text>
      ) : null}

      {message ? (
        <Text accessibilityRole="alert" accessibilityLiveRegion="polite" style={styles.notice} testID="nothing-fits-message">
          {message}
        </Text>
      ) : null}
      {busy ? <ActivityIndicator accessibilityLabel="Working" color={theme.outline} style={styles.spinner} /> : null}

      {open ? (
        <>
          <Text accessibilityRole="header" style={styles.section}>
            Shrink
          </Text>
          {canShrink ? (
            <>
              {presets.map(({ to, minutes }) => (
                <ActionButton
                  key={to}
                  label={`Shrink to ${to} (${formatMinutes(minutes)})`}
                  hint="Tries to fit a shorter block this week"
                  disabled={busy}
                  onPress={() => void resolve({ kind: 'shrink', to })}
                  testID={`nothing-fits-shrink-${to === '75%' ? '75' : '50'}`}
                />
              ))}
              <Text style={styles.label}>
                Custom length (minutes, at least {MIN_SHRINK_MIN})
              </Text>
              <View style={styles.row}>
                <TextInput
                  accessibilityLabel="Custom length in minutes"
                  keyboardType="number-pad"
                  value={custom}
                  onChangeText={(text) => {
                    setCustom(text);
                    setCustomError(null);
                  }}
                  editable={!busy}
                  maxLength={4}
                  placeholder={String(MIN_SHRINK_MIN)}
                  placeholderTextColor={theme.textMuted}
                  selectionColor={theme.outline}
                  cursorColor={theme.outline}
                  style={styles.input}
                  testID="nothing-fits-custom-input"
                />
                <ActionButton
                  label="Shrink to custom length"
                  disabled={busy}
                  onPress={onCustom}
                  testID="nothing-fits-shrink-custom"
                  compact
                />
              </View>
              {customError ? (
                <Text accessibilityRole="alert" style={styles.error} testID="nothing-fits-custom-error">
                  {customError}
                </Text>
              ) : null}
            </>
          ) : (
            <Text style={styles.body}>{NOTHING_FITS_MESSAGES.cannotShrink}</Text>
          )}

          <Text accessibilityRole="header" style={styles.section}>
            Or
          </Text>
          {options.includes('drop') ? (
            <ActionButton
              label={fitness ? 'Drop (counts as missed)' : 'Drop'}
              hint={fitness ? 'Removes it from your calendar and records it as missed' : 'Removes it from your calendar and your list'}
              disabled={busy}
              onPress={() => void resolve({ kind: 'drop' })}
              testID="nothing-fits-drop"
              variant="secondary"
            />
          ) : null}
          {options.includes('roll-to-next-week') ? (
            <ActionButton
              label="Roll to next week"
              hint="Removes it from this week and adds it to next week's list"
              disabled={busy}
              onPress={() => void resolve({ kind: 'roll' })}
              testID="nothing-fits-roll"
              variant="secondary"
            />
          ) : null}
        </>
      ) : (
        <ActionButton label="Back to the week" onPress={() => navigation.popTo('WeekView')} testID="nothing-fits-back" />
      )}
    </ScrollView>
  );
}

// --- Unplaced-items mode -------------------------------------------------------------------

interface ItemsModeProps {
  itemIds: string[];
  weekId?: string;
  navigation: Navigation;
}

function ItemsMode({ itemIds, weekId, navigation }: ItemsModeProps): React.JSX.Element {
  const { repos, review } = useAppServices();
  const { theme } = useTheme();
  const styles = useThemedStyles(createStyles);
  const [items, setItems] = useState<IntakeItem[] | undefined>(undefined);
  const key = itemIds.join('\n');

  useEffect(() => {
    let active = true;
    const ids = key ? key.split('\n') : [];
    const week = weekId ?? review.currentWeekId();
    repos.items
      .get(week)
      .then((all) => {
        const byId = new Map(all.map((i) => [i.id, i]));
        if (active) setItems(ids.map((id) => byId.get(id)).filter((i): i is IntakeItem => i !== undefined));
      })
      .catch(() => active && setItems([]));
    return () => {
      active = false;
    };
  }, [repos, review, weekId, key]);

  if (items === undefined) {
    return (
      <View style={[styles.container, styles.center]} testID="screen-NothingFits">
        <ActivityIndicator accessibilityLabel="Loading" color={theme.outline} />
      </View>
    );
  }

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content} testID="screen-NothingFits">
      <Text accessibilityRole="header" style={styles.title}>
        Nothing fits this week
      </Text>
      {itemIds.length === 0 ? (
        <Text style={styles.body}>{NOTHING_FITS_MESSAGES.noItems}</Text>
      ) : (
        <>
          <Text style={styles.body} testID="nothing-fits-items-intro">
            {NOTHING_FITS_MESSAGES.itemsIntro}
          </Text>
          {items.length === 0 ? (
            <Text style={styles.notice}>{NOTHING_FITS_MESSAGES.itemsMissing}</Text>
          ) : (
            <View accessibilityRole="list" testID="nothing-fits-items">
              {items.map((item) => (
                <View
                  key={item.id}
                  style={styles.card}
                  accessible
                  accessibilityLabel={`${item.text}, ${CATEGORY_LABELS[item.category]}, ${formatMinutes(item.durationMin)}, priority ${item.priority}`}
                  testID={`nothing-fits-item-${item.id}`}
                >
                  <Text style={styles.itemTitle}>{item.text}</Text>
                  <Text style={styles.meta}>
                    {CATEGORY_LABELS[item.category]} · {formatMinutes(item.durationMin)} · Priority {item.priority}
                  </Text>
                </View>
              ))}
            </View>
          )}
        </>
      )}
      <ActionButton
        label="Edit my list"
        hint="Opens the paste box so you can shorten or remove items and plan again"
        onPress={() => navigation.navigate('Intake')}
        testID="nothing-fits-edit"
      />
      <ActionButton
        label="Back to the week"
        onPress={() => navigation.popTo('WeekView')}
        testID="nothing-fits-back"
        variant="secondary"
      />
    </ScrollView>
  );
}

// --- Shared ---------------------------------------------------------------------------------

interface ActionButtonProps {
  label: string;
  hint?: string;
  onPress: () => void;
  disabled?: boolean;
  testID: string;
  variant?: 'primary' | 'secondary';
  compact?: boolean;
}

function ActionButton({ label, hint, onPress, disabled = false, testID, variant = 'primary', compact }: ActionButtonProps) {
  const styles = useThemedStyles(createStyles);
  const secondary = variant === 'secondary';
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={hint}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        secondary && styles.buttonSecondary,
        compact && styles.buttonCompact,
        pressed && (secondary ? styles.buttonSecondaryPressed : styles.buttonPressed),
        disabled && styles.buttonDisabled,
      ]}
      testID={testID}
    >
      <Text style={[styles.buttonText, secondary && styles.buttonTextSecondary]}>{label}</Text>
    </Pressable>
  );
}

const createStyles = (theme: Theme) => StyleSheet.create({
  container: { flex: 1, backgroundColor: theme.background },
  content: { padding: 24, gap: 12 },
  center: { alignItems: 'center', justifyContent: 'center' },
  title: { fontSize: 24, fontWeight: '700', color: theme.text },
  section: { marginTop: 8, fontSize: 18, fontWeight: '600', color: theme.text },
  body: { fontSize: 16, color: theme.text },
  notice: { fontSize: 16, fontWeight: '600', color: theme.text },
  error: { fontSize: 14, fontWeight: '600', color: theme.danger },
  label: { fontSize: 14, color: theme.text },
  meta: { marginTop: 4, fontSize: 14, color: theme.textMuted },
  itemTitle: { fontSize: 16, fontWeight: '600', color: theme.text },
  card: { borderWidth: 1, borderColor: theme.border, backgroundColor: theme.surface, borderRadius: 14, padding: 12, marginBottom: 8 },
  spinner: { alignSelf: 'center' },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  input: {
    flex: 1,
    minHeight: 48,
    borderWidth: 1,
    borderColor: theme.border,
    backgroundColor: theme.surface,
    borderRadius: 14,
    paddingHorizontal: 12,
    fontSize: 16,
    color: theme.text,
  },
  button: {
    minHeight: 48,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 24,
    paddingHorizontal: 24,
    backgroundColor: theme.primary,
  },
  buttonCompact: { paddingHorizontal: 16 },
  buttonPressed: { opacity: 0.8 },
  buttonSecondary: { backgroundColor: theme.surface, borderWidth: 1, borderColor: theme.outline },
  buttonSecondaryPressed: { backgroundColor: theme.pressed },
  buttonDisabled: { opacity: 0.5 },
  buttonText: { fontSize: 16, fontWeight: '600', color: theme.onPrimary },
  buttonTextSecondary: { color: theme.outline },
});
