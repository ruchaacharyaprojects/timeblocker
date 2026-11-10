/**
 * Settings screen (design: "Navigation and screens"; R7.2, R11.11, R11.12,
 * R13.10).
 *
 * - Appearance (R26.2): "Match phone" / "Light" / "Dark" radios, applied
 *   immediately through the theme provider (which saves the choice).
 * - Planning mode: a two-option radio group (`accessibilityRole="radio"` with
 *   a `checked` state); exactly one option is selected ("Spread across days"
 *   is the default, R30.1).
 * - Holidays: a read-only line with the country and the next holiday (R30.2);
 *   there is nothing to add or remove.
 * - Distraction apps: Android package names with add and Remove.
 * - Permission rows for usage access and notifications: "Granted" or
 *   "Not granted" plus "Open settings" for the matching Android screen.
 * - "Reminder timing may vary" while exact alarms are unavailable, with a
 *   button to the exact-alarm settings screen.
 * - Sign out: `auth.signOut()` then `authState.refresh()`; the navigator then
 *   shows SignIn.
 *
 * Settings, permission statuses, and the exact-alarm state are re-read when
 * the screen gains focus and when the app returns to the foreground, so
 * coming back from an Android settings screen updates the rows (R11.12).
 * Every change is saved through the settings service, which persists it
 * immediately (R11.11). Status is always shown as text, never color alone.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  AppState,
  Pressable,
  ScrollView,
  Switch,
  Text,
  TextInput,
  View,
  type TextStyle,
  type ViewStyle,
} from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import {
  AI_MAX_BACKGROUND_CHARS,
  buildSettingsView,
  type AiAvailability,
  type DeviceSettings,
  type ThemeMode,
  type ExactAlarmState,
  type NotificationPermission,
  type PermissionRow,
  type SettingsError,
  type SettingsResult,
  type SleepAvailability,
  type SleepPermission,
  type UsagePermission,
} from '@timeblocker/app-core';
import { copyText } from '../clipboard';
import { AI_API_BASE_URL, aiHostOf } from '../config';
import type { RootScreenProps } from '../navigation/types';
import { useAppServices, type HolidaysPort } from '../services/AppServices';
import { useTheme, useThemedStyles, type Theme } from '../theme';

type HolidaySummary = NonNullable<Awaited<ReturnType<HolidaysPort['summary']>>>;

export const INVALID_APP_MESSAGE = 'Enter an Android package name, for example com.example.app.';
export const SAVE_FAILED_MESSAGE = "Couldn't save that change. Try again.";
export const LOAD_FAILED_MESSAGE = "Couldn't load settings. Try again.";
export const SIGN_OUT_FAILED_MESSAGE = "Couldn't sign out. Try again.";
export const SIGN_OUT_LABEL = 'Sign out';
export const HOLIDAYS_FALLBACK = 'Holidays load from Google Calendar for your country.';
export const AI_NOT_CONFIGURED_HINT = 'Not set up yet. Deploy the AI service and add its address to the app configuration.';
export const AI_PRIVACY_TEXT =
  'Sends only the text you submit to your private AI service in Canada. Never your phone usage, sleep, or calendar.';
export const AI_SERVICE_NOT_CONFIGURED = 'Not configured';
export const AI_SUB_HELP = 'Add this ID to the service allow-list when you deploy.';
export const AI_SUB_UNAVAILABLE = 'Unavailable. Reconnect Google from the Home screen.';
export const AI_PROFILE_NOTE = 'Stays on this phone. Sent only when you ask for application help.';
export const OPEN_EXACT_ALARM_LABEL = 'Open alarm settings';
export const APPEARANCE_OPTIONS: ReadonlyArray<{ value: ThemeMode; label: string }> = [
  { value: 'system', label: 'Match phone' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
];

/** "Holidays: Canada. Next: Remembrance Day, Nov 11." or the fallback text. */
export function holidaysText(summary: HolidaySummary | null): string {
  if (!summary) return HOLIDAYS_FALLBACK;
  const next = summary.next ? ` Next: ${summary.next.name}, ${formatShortDate(summary.next.date)}.` : '';
  return `Holidays: ${summary.country}.${next}`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** `YYYY-MM-DD` as "Nov 11"; anything else is returned unchanged. */
function formatShortDate(date: string): string {
  const m = /^\d{4}-(\d{2})-(\d{2})$/.exec(date);
  const month = m ? MONTHS[Number(m[1]) - 1] : undefined;
  return m && month ? `${month} ${Number(m[2])}` : date;
}

export const SLEEP_ROW_LABEL = 'Samsung Health sleep';
export const SLEEP_CONNECT_LABEL = 'Connect Samsung Health sleep';
export const SLEEP_PRIVACY_HINT = 'Only sleep start, end, and time asleep are used. Nothing leaves your phone.';
export const SLEEP_NEEDS_INSTALL_HINT = 'Install or update Health Connect, then reopen this screen';
export const DEMO_WARNING = 'Debug build only. Fake data for testing.';
export const DEMO_FAILED_MESSAGE = "That didn't work. Try again.";
export const DEMO_HEALTH_UNAVAILABLE_MESSAGE = "Health Connect write isn't available.";
export const REMOVE_DEMO_CONFIRM_TITLE = 'Remove demo data?';
export const REMOVE_DEMO_CONFIRM_MESSAGE = 'This deletes the demo tasks and sleep scores. Your real data stays.';

/** The status line for the Samsung Health sleep row. */
export function sleepStatusText(status: SleepStatus): string {
  if (status.availability === 'unsupported') return "Health Connect isn't available on this phone";
  if (status.availability === 'needs-install') return 'Health Connect needs an update';
  return status.permission === 'granted' ? 'Connected' : 'Not connected';
}

interface SleepStatus {
  availability: SleepAvailability;
  permission: SleepPermission;
}

type DemoAction = 'load' | 'remove' | 'write' | 'usage';

const ERROR_MESSAGES: Readonly<Record<SettingsError, string>> = {
  'invalid-theme-mode': SAVE_FAILED_MESSAGE,
  'invalid-app': INVALID_APP_MESSAGE,
  'invalid-planning-mode': SAVE_FAILED_MESSAGE,
  'invalid-ai-enabled': SAVE_FAILED_MESSAGE,
};

type PlanningMode = DeviceSettings['planningMode'];

interface Statuses {
  usagePermission: UsagePermission;
  notificationPermission: NotificationPermission;
  exactAlarm: ExactAlarmState;
}

type FieldError = { field: 'app' | 'mode' | 'general' | 'ai'; message: string } | null;

export function SettingsScreen(_props: RootScreenProps<'Settings'>): React.JSX.Element {
  const { settings: settingsService, holidays, usage, notificationPermission, notifications, systemSettings, auth, authState, sleepData, demo, ai, aiProfile } =
    useAppServices();

  const { theme, mode, setMode } = useTheme();
  const styles = useThemedStyles(createStyles);
  const [settings, setSettings] = useState<DeviceSettings | null>(null);
  const [statuses, setStatuses] = useState<Statuses | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [holidaySummary, setHolidaySummary] = useState<HolidaySummary | null>(null);
  const [appText, setAppText] = useState('');
  const [fieldError, setFieldError] = useState<FieldError>(null);
  const [saving, setSaving] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const [signOutError, setSignOutError] = useState(false);
  const [sleepStatus, setSleepStatus] = useState<SleepStatus | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [demoUsage, setDemoUsage] = useState(false);
  const [demoBusy, setDemoBusy] = useState<DemoAction | null>(null);
  const [demoResult, setDemoResult] = useState<string | null>(null);
  const [demoError, setDemoError] = useState(false);
  const demoInFlight = useRef(false);
  const [aiAvailability, setAiAvailability] = useState<AiAvailability>('disabled');
  /** `undefined` while loading, `null` when Google gave no ID. */
  const [googleSub, setGoogleSub] = useState<string | null | undefined>(undefined);
  const [showSub, setShowSub] = useState(false);
  const [subCopied, setSubCopied] = useState(false);
  const [profileText, setProfileText] = useState('');
  const [profileNote, setProfileNote] = useState<string | null>(null);
  const profileLoaded = useRef(false);

  const mounted = useRef(true);
  const loadSeq = useRef(0);
  /** Bumped by every saved change so an older in-flight reload cannot overwrite it. */
  const settingsVersion = useRef(0);
  const savingRef = useRef(false);
  const signOutInFlight = useRef(false);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  /** Re-read settings, permissions, and exact-alarm availability. The latest call wins. */
  const reload = useCallback(async () => {
    const seq = ++loadSeq.current;
    const version = settingsVersion.current;
    try {
      const exactAlarm = notifications
        .refreshExactAlarmState()
        .then(
          ({ exactAlarmsAvailable, reminderTimingMayVary }): ExactAlarmState => ({
            exactAlarmsAvailable,
            reminderTimingMayVary,
          }),
        )
        .catch(() => notifications.exactAlarmState());
      const [nextSettings, usagePermission, notifPermission, exact, nextSleep, nextDemoUsage, nextHolidays] = await Promise.all([
        settingsService.get(),
        usage.permission(),
        notificationPermission.permission(),
        exactAlarm,
        sleepData.status().catch((): SleepStatus => ({ availability: 'unsupported', permission: 'denied' })),
        demo ? demo.isUsageEnabled().catch(() => false) : Promise.resolve(false),
        holidays.summary().catch(() => null),
      ]);
      if (!mounted.current || seq !== loadSeq.current) return;
      const [nextAvail, nextSub, nextProfile] = await Promise.all([
        ai.availability().catch((): AiAvailability => 'disabled'),
        auth.googleSub().catch(() => undefined),
        profileLoaded.current ? Promise.resolve(undefined) : aiProfile.get().catch(() => null),
      ]);
      if (!mounted.current || seq !== loadSeq.current) return;
      setAiAvailability(nextAvail);
      setGoogleSub(nextSub ?? null);
      if (!profileLoaded.current && nextProfile !== undefined) {
        profileLoaded.current = true;
        setProfileText(nextProfile?.background ?? '');
      }
      setSleepStatus(nextSleep);
      setDemoUsage(nextDemoUsage);
      setHolidaySummary(nextHolidays);
      if (version === settingsVersion.current) setSettings(nextSettings);
      setStatuses({ usagePermission, notificationPermission: notifPermission, exactAlarm: exact });
      setLoadError(false);
    } catch {
      if (mounted.current && seq === loadSeq.current) setLoadError(true);
    }
  }, [ai, aiProfile, auth, demo, holidays, notificationPermission, notifications, settingsService, sleepData, usage]);

  useFocusEffect(
    useCallback(() => {
      void reload();
    }, [reload]),
  );

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (next) => {
      if (next === 'active') void reload();
    });
    return () => subscription.remove();
  }, [reload]);

  /** Run one settings change; returns whether it was accepted. */
  const save = useCallback(
    async (field: NonNullable<FieldError>['field'], change: () => Promise<SettingsResult>): Promise<boolean> => {
      if (savingRef.current) return false;
      savingRef.current = true;
      setSaving(true);
      let accepted = false;
      let error: FieldError = null;
      try {
        const result = await change();
        settingsVersion.current += 1;
        if (mounted.current) setSettings(result.settings);
        if (result.ok) accepted = true;
        else error = { field, message: ERROR_MESSAGES[result.error] };
      } catch {
        error = { field, message: SAVE_FAILED_MESSAGE };
      } finally {
        savingRef.current = false;
      }
      if (mounted.current) {
        setFieldError(error);
        setSaving(false);
      }
      return accepted;
    },
    [],
  );

  const onSelectMode = useCallback(
    (mode: PlanningMode) => {
      void save('mode', () => settingsService.setPlanningMode(mode));
    },
    [save, settingsService],
  );

  const onToggleAi = useCallback(
    async (enabled: boolean) => {
      if (aiAvailability === 'not-configured') return;
      if (await save('ai', () => settingsService.setAiEnabled(enabled))) {
        const next = await ai.availability().catch((): AiAvailability => 'disabled');
        if (mounted.current) setAiAvailability(next);
      }
    },
    [ai, aiAvailability, save, settingsService],
  );

  const onCopySub = useCallback(() => {
    if (googleSub && copyText(googleSub)) setSubCopied(true);
  }, [googleSub]);

  const onSaveProfile = useCallback(async () => {
    setProfileNote(null);
    try {
      const saved = await aiProfile.save(profileText);
      if (!mounted.current) return;
      if (saved === null) setProfileText('');
      setProfileNote(saved === null ? 'Cleared.' : 'Saved.');
    } catch {
      if (mounted.current) setProfileNote(SAVE_FAILED_MESSAGE);
    }
  }, [aiProfile, profileText]);

  const onClearProfile = useCallback(async () => {
    setProfileNote(null);
    try {
      await aiProfile.clear();
      if (!mounted.current) return;
      setProfileText('');
      setProfileNote('Cleared.');
    } catch {
      if (mounted.current) setProfileNote(SAVE_FAILED_MESSAGE);
    }
  }, [aiProfile]);

  const onAddApp = useCallback(async () => {
    const pkg = appText.trim();
    if (await save('app', () => settingsService.addDistractionApp(pkg))) {
      if (mounted.current) setAppText('');
    }
  }, [appText, save, settingsService]);

  const onRemoveApp = useCallback(
    (pkg: string) => {
      void save('general', () => settingsService.removeDistractionApp(pkg));
    },
    [save, settingsService],
  );

  const onOpenPermission = useCallback(
    (row: PermissionRow) => {
      systemSettings[row.action.target]().catch(() => {});
    },
    [systemSettings],
  );

  const onOpenExactAlarm = useCallback(() => {
    systemSettings.openExactAlarmSettings().catch(() => {});
  }, [systemSettings]);

  const onConnectSleep = useCallback(async () => {
    setConnecting(true);
    try {
      await sleepData.connect();
    } catch {
      // The status re-read below shows the real state.
    }
    await reload();
    if (mounted.current) setConnecting(false);
  }, [reload, sleepData]);

  /** Run one demo action with a busy state, a result line, and a generic error. */
  const runDemo = useCallback(async (action: DemoAction, run: () => Promise<string>) => {
    if (demoInFlight.current) return;
    demoInFlight.current = true;
    setDemoBusy(action);
    setDemoError(false);
    setDemoResult(null);
    let result: string | null = null;
    let failed = false;
    try {
      result = await run();
    } catch {
      failed = true;
    } finally {
      demoInFlight.current = false;
    }
    if (mounted.current) {
      setDemoResult(result);
      setDemoError(failed);
      setDemoBusy(null);
    }
  }, []);

  const onLoadDemo = useCallback(() => {
    if (!demo) return;
    void runDemo('load', async () => {
      const r = await demo.load();
      return `Loaded ${r.blocks} blocks and ${r.nights} nights.`;
    });
  }, [demo, runDemo]);

  const onRemoveDemo = useCallback(() => {
    if (!demo) return;
    Alert.alert(REMOVE_DEMO_CONFIRM_TITLE, REMOVE_DEMO_CONFIRM_MESSAGE, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Remove',
        style: 'destructive',
        onPress: () => {
          void runDemo('remove', async () => {
            const r = await demo.remove();
            const health = r.healthRemoved === false ? '' : ` Removed ${r.healthRemoved} sleep sessions from Health Connect.`;
            const out = `Removed ${r.blocks} blocks and ${r.nights} nights.${health}`;
            setDemoUsage(await demo.isUsageEnabled().catch(() => false));
            return out;
          });
        },
      },
    ]);
  }, [demo, runDemo]);

  const onWriteDemoSleep = useCallback(() => {
    if (!demo) return;
    void runDemo('write', async () => {
      const n = await demo.writeHealthSleep();
      return n === false ? DEMO_HEALTH_UNAVAILABLE_MESSAGE : `Wrote ${n} sleep sessions to Health Connect.`;
    });
  }, [demo, runDemo]);

  const onToggleDemoUsage = useCallback(
    (enabled: boolean) => {
      if (!demo) return;
      void runDemo('usage', async () => {
        await demo.setUsage(enabled);
        setDemoUsage(enabled);
        return enabled ? 'Demo screen usage is on.' : 'Demo screen usage is off.';
      });
    },
    [demo, runDemo],
  );

  const onSignOut = useCallback(async () => {
    if (signOutInFlight.current) return;
    signOutInFlight.current = true;
    setSigningOut(true);
    setSignOutError(false);
    let failed = false;
    try {
      await auth.signOut();
      await authState.refresh();
    } catch {
      failed = true;
    } finally {
      signOutInFlight.current = false;
    }
    // On success the navigator unmounts this screen; skip state updates then.
    if (mounted.current) {
      setSignOutError(failed);
      setSigningOut(false);
    }
  }, [auth, authState]);

  const view = useMemo(
    () =>
      settings && statuses
        ? buildSettingsView({
            settings,
            usagePermission: statuses.usagePermission,
            notificationPermission: statuses.notificationPermission,
            exactAlarm: statuses.exactAlarm,
          })
        : null,
    [settings, statuses],
  );

  const aiNotConfigured = aiAvailability === 'not-configured';
  const aiHost = aiHostOf(AI_API_BASE_URL);

  const errorFor = (field: NonNullable<FieldError>['field']) =>
    fieldError && fieldError.field === field ? (
      <Text accessibilityRole="alert" accessibilityLiveRegion="assertive" style={styles.error} testID={`error-${field}`}>
        {fieldError.message}
      </Text>
    ) : null;

  if (!view) {
    return (
      <View style={styles.centered} testID="screen-Settings">
        {loadError ? (
          <>
            <Text accessibilityRole="alert" style={styles.error}>
              {LOAD_FAILED_MESSAGE}
            </Text>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Retry"
              onPress={() => void reload()}
              style={({ pressed }) => [styles.secondaryButton, pressed && styles.secondaryPressed]}
            >
              <Text style={styles.secondaryText}>Retry</Text>
            </Pressable>
          </>
        ) : (
          <ActivityIndicator color={theme.outline} accessibilityLabel="Loading settings" />
        )}
      </View>
    );
  }

  return (
    <ScrollView
      style={styles.screen}
      contentContainerStyle={styles.content}
      keyboardShouldPersistTaps="handled"
      testID="screen-Settings"
    >
      {/* Appearance */}
      <Text accessibilityRole="header" style={[styles.sectionTitle, styles.firstSection]}>
        Appearance
      </Text>
      <View accessibilityRole="radiogroup" accessibilityLabel="Appearance" testID="appearance">
        {APPEARANCE_OPTIONS.map((option) => {
          const selected = mode === option.value;
          return (
            <Pressable
              key={option.value}
              accessibilityRole="radio"
              accessibilityLabel={option.label}
              accessibilityState={{ checked: selected }}
              onPress={() => {
                if (!selected) setMode(option.value);
              }}
              style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
              testID={`appearance-${option.value}`}
            >
              <View style={[styles.radioOuter, selected && styles.radioOuterSelected]}>
                {selected ? <View style={styles.radioInner} /> : null}
              </View>
              <Text style={styles.rowText}>{option.label}</Text>
              {selected ? <Text style={styles.statusText}>Selected</Text> : null}
            </Pressable>
          );
        })}
      </View>

      {/* Planning mode */}
      <Text accessibilityRole="header" style={styles.sectionTitle}>
        Planning mode
      </Text>
      <View accessibilityRole="radiogroup" accessibilityLabel="Planning mode" testID="planning-mode">
        {view.planningMode.options.map((option) => (
          <Pressable
            key={option.value}
            accessibilityRole="radio"
            accessibilityLabel={option.label}
            accessibilityState={{ checked: option.selected, disabled: saving }}
            disabled={saving}
            onPress={() => {
              if (!option.selected) onSelectMode(option.value);
            }}
            style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
            testID={`mode-${option.value}`}
          >
            <View style={[styles.radioOuter, option.selected && styles.radioOuterSelected]}>
              {option.selected ? <View style={styles.radioInner} /> : null}
            </View>
            <Text style={styles.rowText}>{option.label}</Text>
            {option.selected ? <Text style={styles.statusText}>Selected</Text> : null}
          </Pressable>
        ))}
      </View>
      {errorFor('mode')}

      {/* AI assistant (R35.1) */}
      <Text accessibilityRole="header" style={styles.sectionTitle}>
        AI assistant
      </Text>
      <View style={styles.row}>
        <Text style={[styles.rowText, styles.rowBody]}>AI assistant</Text>
        <Switch
          accessibilityRole="switch"
          accessibilityLabel="AI assistant"
          accessibilityState={{ checked: settings?.aiEnabled === true, disabled: aiNotConfigured || saving }}
          value={settings?.aiEnabled === true}
          disabled={aiNotConfigured || saving}
          onValueChange={(v) => void onToggleAi(v)}
          testID="ai-switch"
        />
      </View>
      {aiNotConfigured ? (
        <Text style={styles.subText} testID="ai-not-configured">
          {AI_NOT_CONFIGURED_HINT}
        </Text>
      ) : null}
      {errorFor('ai')}
      <Text style={styles.subText} testID="ai-privacy">
        {AI_PRIVACY_TEXT}
      </Text>
      <View style={styles.row} accessible accessibilityLabel={`Service: ${aiHost ?? AI_SERVICE_NOT_CONFIGURED}`} testID="ai-service-row">
        <Text style={styles.rowText}>Service</Text>
        <Text style={[styles.subText, styles.rowBody, styles.rightText]} testID="ai-service">
          {aiHost ?? AI_SERVICE_NOT_CONFIGURED}
        </Text>
      </View>
      <View style={styles.aiBlock} testID="ai-google-id-row">
        <Text style={styles.rowText}>Your Google ID</Text>
        <Text style={styles.subText}>{AI_SUB_HELP}</Text>
        {googleSub === null ? (
          <Text style={styles.subText} testID="ai-google-id-unavailable">
            {AI_SUB_UNAVAILABLE}
          </Text>
        ) : googleSub === undefined ? null : showSub ? (
          <>
            <Text selectable style={styles.monoText} testID="ai-google-id">
              {googleSub}
            </Text>
            <View style={styles.buttonRow}>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Copy Google ID"
                onPress={onCopySub}
                style={({ pressed }) => [styles.secondaryButton, pressed && styles.secondaryPressed]}
                testID="ai-google-id-copy"
              >
                <Text style={styles.secondaryText}>{subCopied ? 'Copied' : 'Copy'}</Text>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Hide Google ID"
                onPress={() => {
                  setShowSub(false);
                  setSubCopied(false);
                }}
                style={({ pressed }) => [styles.secondaryButton, pressed && styles.secondaryPressed]}
                testID="ai-google-id-hide"
              >
                <Text style={styles.secondaryText}>Hide</Text>
              </Pressable>
            </View>
          </>
        ) : (
          <View style={styles.buttonRow}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Show Google ID"
              onPress={() => setShowSub(true)}
              style={({ pressed }) => [styles.secondaryButton, pressed && styles.secondaryPressed]}
              testID="ai-google-id-show"
            >
              <Text style={styles.secondaryText}>Show</Text>
            </Pressable>
          </View>
        )}
      </View>
      <View style={styles.aiBlock} testID="ai-profile">
        <Text accessibilityRole="header" style={styles.rowText}>
          About me for applications
        </Text>
        <TextInput
          accessibilityLabel="About me for applications"
          accessibilityHint="Optional. A few lines about your experience. Stays on this phone."
          multiline
          maxLength={AI_MAX_BACKGROUND_CHARS}
          value={profileText}
          onChangeText={(t) => {
            setProfileText(t);
            setProfileNote(null);
          }}
          placeholderTextColor={theme.textMuted}
          textAlignVertical="top"
          style={[styles.input, styles.multiline]}
          testID="ai-profile-input"
        />
        <Text style={styles.subText} testID="ai-profile-count" accessibilityLabel={`${profileText.length} of ${AI_MAX_BACKGROUND_CHARS} characters`}>
          {profileText.length}/{AI_MAX_BACKGROUND_CHARS}
        </Text>
        <Text style={styles.subText}>{AI_PROFILE_NOTE}</Text>
        <View style={styles.buttonRow}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Save About me"
            onPress={() => void onSaveProfile()}
            style={({ pressed }) => [styles.primaryButton, pressed && styles.primaryPressed]}
            testID="ai-profile-save"
          >
            <Text style={styles.primaryText}>Save</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Clear About me"
            onPress={() => void onClearProfile()}
            style={({ pressed }) => [styles.secondaryButton, pressed && styles.secondaryPressed]}
            testID="ai-profile-clear"
          >
            <Text style={styles.secondaryText}>Clear</Text>
          </Pressable>
        </View>
        {profileNote ? (
          <Text accessibilityLiveRegion="polite" style={styles.statusText} testID="ai-profile-note">
            {profileNote}
          </Text>
        ) : null}
      </View>

      {/* Holidays (read-only, R30.2) */}
      <Text accessibilityRole="header" style={styles.sectionTitle}>
        Holidays
      </Text>
      <Text style={styles.rowText} testID="holidays-row">
        {holidaysText(holidaySummary)}
      </Text>

      {/* Distraction apps */}
      <Text accessibilityRole="header" style={styles.sectionTitle}>
        Distraction apps
      </Text>
      {view.distractionApps.length === 0 ? <Text style={styles.empty}>No apps added.</Text> : null}
      {view.distractionApps.map((app) => (
        <View key={app.packageName} style={styles.row} testID={`app-${app.packageName}`}>
          <Text style={[styles.rowText, styles.rowBody]}>{app.packageName}</Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Remove ${app.packageName}`}
            accessibilityState={{ disabled: saving }}
            disabled={saving}
            onPress={() => onRemoveApp(app.packageName)}
            style={({ pressed }) => [styles.secondaryButton, pressed && styles.secondaryPressed]}
          >
            <Text style={styles.secondaryText}>Remove</Text>
          </Pressable>
        </View>
      ))}
      <View style={styles.addRow}>
        <TextInput
          accessibilityLabel="App package name"
          accessibilityHint="Type a package name like com.example.app, then press Add app"
          placeholder="com.example.app"
          placeholderTextColor={theme.textMuted}
          value={appText}
          onChangeText={setAppText}
          onSubmitEditing={() => void onAddApp()}
          autoCapitalize="none"
          autoCorrect={false}
          style={styles.input}
          testID="app-input"
        />
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Add app"
          accessibilityState={{ disabled: saving }}
          disabled={saving}
          onPress={() => void onAddApp()}
          style={({ pressed }) => [styles.primaryButton, pressed && styles.primaryPressed]}
        >
          <Text style={styles.primaryText}>Add</Text>
        </Pressable>
      </View>
      {errorFor('app')}
      {errorFor('general')}

      {/* Permissions */}
      <Text accessibilityRole="header" style={styles.sectionTitle}>
        Permissions
      </Text>
      {view.permissions.map((row) => (
        <View
          key={row.id}
          style={styles.row}
          testID={`permission-${row.id}`}
        >
          <View style={styles.rowBody} accessible accessibilityLabel={`${row.label}: ${row.statusLabel}`}>
            <Text style={styles.rowText}>{row.label}</Text>
            <View style={styles.statusRow}>
              <Text style={[styles.statusText, row.granted ? styles.granted : styles.notGranted]}>
                {row.granted ? '✓' : '✕'}
              </Text>
              <Text
                style={[styles.statusText, row.granted ? styles.granted : styles.notGranted]}
                testID={`permission-status-${row.id}`}
              >
                {row.statusLabel}
              </Text>
            </View>
          </View>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`${row.action.label} for ${row.label}`}
            accessibilityHint="Opens the Android settings screen"
            onPress={() => onOpenPermission(row)}
            style={({ pressed }) => [styles.secondaryButton, pressed && styles.secondaryPressed]}
            testID={`permission-open-${row.id}`}
          >
            <Text style={styles.secondaryText}>{row.action.label}</Text>
          </Pressable>
        </View>
      ))}
      {view.reminderTimingNote ? (
        <View style={styles.note} testID="reminder-timing-note">
          <View style={styles.noteRow}>
            <Text style={styles.noteText} importantForAccessibility="no" accessibilityElementsHidden>
              ⚠
            </Text>
            <Text style={styles.noteText} testID="reminder-timing-note-text">
              {view.reminderTimingNote}
            </Text>
          </View>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={OPEN_EXACT_ALARM_LABEL}
            accessibilityHint="Opens the Android alarms and reminders setting"
            onPress={onOpenExactAlarm}
            style={({ pressed }) => [styles.secondaryButton, pressed && styles.secondaryPressed]}
          >
            <Text style={styles.secondaryText}>{OPEN_EXACT_ALARM_LABEL}</Text>
          </Pressable>
        </View>
      ) : null}

      {/* Sleep data */}
      <Text accessibilityRole="header" style={styles.sectionTitle}>
        Sleep data
      </Text>
      {sleepStatus ? (
        <View style={styles.row} testID="sleep-data-row">
          <View
            style={styles.rowBody}
            accessible
            accessibilityLabel={`${SLEEP_ROW_LABEL}: ${sleepStatusText(sleepStatus)}`}
          >
            <Text style={styles.rowText}>{SLEEP_ROW_LABEL}</Text>
            <Text
              style={[
                styles.statusText,
                sleepStatus.availability === 'available' && sleepStatus.permission === 'granted'
                  ? styles.granted
                  : styles.notGranted,
              ]}
              testID="sleep-data-status"
            >
              {sleepStatusText(sleepStatus)}
            </Text>
            {sleepStatus.availability === 'needs-install' ? (
              <Text style={styles.subText} testID="sleep-data-hint">
                {SLEEP_NEEDS_INSTALL_HINT}
              </Text>
            ) : null}
          </View>
          {sleepStatus.availability === 'available' && sleepStatus.permission !== 'granted' ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={SLEEP_CONNECT_LABEL}
              accessibilityState={{ disabled: connecting, busy: connecting }}
              disabled={connecting}
              onPress={() => void onConnectSleep()}
              style={({ pressed }) => [styles.secondaryButton, pressed && styles.secondaryPressed]}
              testID="sleep-data-connect"
            >
              <Text style={styles.secondaryText}>{connecting ? 'Connecting…' : 'Connect'}</Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}
      <Text style={styles.subText} testID="sleep-data-privacy">
        {SLEEP_PRIVACY_HINT}
      </Text>

      {demo ? (
        <View testID="demo-section">
          <Text accessibilityRole="header" style={styles.sectionTitle}>
            Demo data
          </Text>
          <Text style={styles.subText}>{DEMO_WARNING}</Text>
          <View style={styles.demoButtons}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Load demo data"
              accessibilityState={{ disabled: demoBusy !== null, busy: demoBusy === 'load' }}
              disabled={demoBusy !== null}
              onPress={onLoadDemo}
              style={({ pressed }) => [styles.secondaryButton, pressed && styles.secondaryPressed]}
              testID="demo-load"
            >
              <Text style={styles.secondaryText}>{demoBusy === 'load' ? 'Loading…' : 'Load demo data'}</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Remove demo data"
              accessibilityState={{ disabled: demoBusy !== null, busy: demoBusy === 'remove' }}
              disabled={demoBusy !== null}
              onPress={onRemoveDemo}
              style={({ pressed }) => [styles.secondaryButton, pressed && styles.secondaryPressed]}
              testID="demo-remove"
            >
              <Text style={styles.secondaryText}>{demoBusy === 'remove' ? 'Removing…' : 'Remove demo data'}</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Write demo sleep to Health Connect"
              accessibilityState={{ disabled: demoBusy !== null, busy: demoBusy === 'write' }}
              disabled={demoBusy !== null}
              onPress={onWriteDemoSleep}
              style={({ pressed }) => [styles.secondaryButton, pressed && styles.secondaryPressed]}
              testID="demo-write-sleep"
            >
              <Text style={styles.secondaryText}>
                {demoBusy === 'write' ? 'Writing…' : 'Write demo sleep to Health Connect'}
              </Text>
            </Pressable>
          </View>
          <View style={styles.row}>
            <Text style={[styles.rowText, styles.rowBody]}>Use demo screen usage</Text>
            <Switch
              accessibilityRole="switch"
              accessibilityLabel="Use demo screen usage"
              accessibilityState={{ checked: demoUsage, disabled: demoBusy !== null }}
              value={demoUsage}
              disabled={demoBusy !== null}
              onValueChange={onToggleDemoUsage}
              testID="demo-usage-switch"
            />
          </View>
          {demoBusy ? <ActivityIndicator accessibilityLabel="Working on demo data" /> : null}
          {demoResult ? (
            <Text accessibilityLiveRegion="polite" style={styles.statusText} testID="demo-result">
              {demoResult}
            </Text>
          ) : null}
          {demoError ? (
            <Text accessibilityRole="alert" accessibilityLiveRegion="assertive" style={styles.error} testID="demo-error">
              {DEMO_FAILED_MESSAGE}
            </Text>
          ) : null}
        </View>
      ) : null}

      {/* Account */}
      <Text accessibilityRole="header" style={styles.sectionTitle}>
        Account
      </Text>
      {signOutError ? (
        <Text accessibilityRole="alert" accessibilityLiveRegion="assertive" style={styles.error} testID="sign-out-error">
          {SIGN_OUT_FAILED_MESSAGE}
        </Text>
      ) : null}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={SIGN_OUT_LABEL}
        accessibilityState={{ disabled: signingOut, busy: signingOut }}
        disabled={signingOut}
        onPress={() => void onSignOut()}
        style={({ pressed }) => [styles.signOutButton, (pressed || signingOut) && styles.signOutPressed]}
        testID="sign-out-button"
      >
        {signingOut ? <ActivityIndicator color={theme.danger} accessibilityLabel="Signing out" /> : null}
        <Text style={styles.signOutText}>{signingOut ? 'Signing out…' : SIGN_OUT_LABEL}</Text>
      </Pressable>
    </ScrollView>
  );
}

const createStyles = (theme: Theme) =>
  ({
    screen: { flex: 1, backgroundColor: theme.background },
    content: { padding: 16, paddingBottom: 48 },
    centered: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24, gap: 16, backgroundColor: theme.background },
    sectionTitle: { marginTop: 24, marginBottom: 8, fontSize: 18, fontWeight: '700', color: theme.text },
    firstSection: { marginTop: 0 },
    row: {
      minHeight: 48,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 12,
      paddingVertical: 8,
      borderBottomWidth: 1,
      borderBottomColor: theme.border,
    },
    rowPressed: { backgroundColor: theme.pressed },
    rowBody: { flex: 1 },
    rowText: { fontSize: 16, color: theme.text },
    subText: { fontSize: 14, color: theme.textMuted },
    statusText: { fontSize: 14, fontWeight: '600', color: theme.text },
    statusRow: { flexDirection: 'row', gap: 4 },
    granted: { color: theme.text },
    notGranted: { color: theme.danger },
    empty: { fontSize: 14, color: theme.textMuted, paddingVertical: 8 },
    radioOuter: {
      width: 24,
      height: 24,
      borderRadius: 12,
      borderWidth: 2,
      borderColor: theme.textMuted,
      alignItems: 'center',
      justifyContent: 'center',
    },
    radioOuterSelected: { borderColor: theme.outline },
    radioInner: { width: 12, height: 12, borderRadius: 6, backgroundColor: theme.outline },
    aiBlock: { gap: 6, paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: theme.border },
    rightText: { textAlign: 'right' },
    monoText: { fontSize: 14, color: theme.text, fontFamily: 'monospace' },
    buttonRow: { flexDirection: 'row', gap: 8, marginTop: 4 },
    multiline: { flex: 0, minHeight: 120, paddingTop: 12 },
    addRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 8 },
    input: {
      flex: 1,
      minHeight: 48,
      borderWidth: 1,
      borderColor: theme.textMuted,
      borderRadius: 8,
      paddingHorizontal: 12,
      fontSize: 16,
      color: theme.text,
      backgroundColor: theme.surface,
    },
    primaryButton: {
      minHeight: 48,
      minWidth: 64,
      alignItems: 'center',
      justifyContent: 'center',
      borderRadius: 24,
      paddingHorizontal: 20,
      backgroundColor: theme.primary,
    },
    primaryPressed: { opacity: 0.8 },
    primaryText: { fontSize: 16, fontWeight: '600', color: theme.onPrimary },
    secondaryButton: {
      minHeight: 48,
      alignItems: 'center',
      justifyContent: 'center',
      borderRadius: 24,
      borderWidth: 2,
      borderColor: theme.primary,
      paddingHorizontal: 16,
    },
    secondaryPressed: { backgroundColor: theme.pressed },
    secondaryText: { fontSize: 16, fontWeight: '600', color: theme.outline },
    error: { marginTop: 8, fontSize: 14, color: theme.danger, fontWeight: '600' },
    note: {
      marginTop: 12,
      padding: 12,
      gap: 8,
      borderRadius: 8,
      borderWidth: 1,
      borderColor: theme.warning,
      backgroundColor: theme.surface,
    },
    noteRow: { flexDirection: 'row', gap: 8 },
    noteText: { fontSize: 16, fontWeight: '600', color: theme.text },
    demoButtons: { gap: 8, marginTop: 8, alignItems: 'stretch' },
    signOutButton: {
      minHeight: 48,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 8,
      borderRadius: 24,
      borderWidth: 1,
      borderColor: theme.danger,
      paddingHorizontal: 24,
    },
    signOutPressed: { backgroundColor: theme.pressed },
    signOutText: { fontSize: 16, fontWeight: '600', color: theme.danger },
  }) satisfies Record<string, ViewStyle | TextStyle>;
