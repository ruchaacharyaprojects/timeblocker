/**
 * Application helper screen, route `ApplicationHelper { blockId, weekId }`
 * ("Help me start", R34, R35.4; design D30).
 *
 * - Three modes in a radio group: Application, Email, Study plan. The default
 *   comes from the block's `kind`, then its title.
 * - Application: job posting (6,000), question (600), background (3,000,
 *   prefilled from "About me for applications"). "Remember this background on
 *   my phone" saves it through `aiProfile.save` when the user taps the action.
 *   The button reads "Outline my application checklist" while the question is
 *   empty. Email and Study take one line (300).
 * - The call to `ai.applicationHelp` is raced against a 25 s ceiling. Every
 *   failure reason shows a friendly inline message; nothing blocks navigation.
 * - Results sit under the banner "Draft: check every claim before you use
 *   it." (role alert). Actions: "Copy" (core `Clipboard`; the text is also
 *   selectable) and "Save to this task" (`blockActions.saveNotes`, plain text).
 * - Model output is kept in memory only until the user taps "Save to this task" (R34.6).
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, Switch, Text, TextInput, View, type TextStyle, type ViewStyle } from 'react-native';
import {
  AI_MAX_BACKGROUND_CHARS,
  AI_MAX_INTENT_CHARS,
  AI_MAX_JOB_CHARS,
  AI_MAX_QUESTION_CHARS,
  type AiFailureReason,
  type ApplicationHelpMode,
  type ApplicationHelpRequest,
  type ApplicationHelpResponse,
  type ApplicationPointsResponse,
  type DeviceBlock,
  type EmailDraftResponse,
  type StudyStepsResponse,
} from '@timeblocker/app-core';
import { copyText } from '../clipboard';
import type { RootScreenProps } from '../navigation/types';
import { useAppServices } from '../services/AppServices';
import { useTheme, useThemedStyles, type Theme } from '../theme';

/** How long the screen waits for the AI service (R35.4). */
export const HELP_TIMEOUT_MS = 25_000;

export const HELP_BANNER = 'Draft: check every claim before you use it.';
export const WORKING_MESSAGE = 'Working on it…';
export const BACKGROUND_REQUIRED_MESSAGE = 'Add a few lines about your background first.';
export const EMAIL_INTENT_REQUIRED_MESSAGE = 'Say what you want to email in one line.';
export const STUDY_INTENT_REQUIRED_MESSAGE = 'Say what you are studying and by when.';
export const NOTHING_MATCHES_MESSAGE = 'Nothing in your background matches this question yet.';
export const SUGGESTED_PROMPTS: readonly string[] = [
  'What project used data to make a decision?',
  'When did you lead or coordinate others?',
  'What did you build and what was the result?',
];
export const SAVED_TO_TASK_MESSAGE = 'Saved to this task.';
export const SAVE_FAILED_MESSAGE = "That didn't save. Try again.";
export const TASK_MISSING_MESSAGE = 'This task no longer exists.';
export const COPIED_MESSAGE = 'Copied.';
export const COPY_UNAVAILABLE_MESSAGE = "Couldn't copy. Press and hold the text to select it.";
export const BLOCK_MISSING_MESSAGE = 'This block no longer exists. It may have been deleted or moved to another week.';

/** One friendly line per failure reason (R35.4). */
export const FAILURE_MESSAGES: Readonly<Record<AiFailureReason, string>> = {
  offline: "You're offline. Try again when you're connected.",
  timeout: 'That took too long. Try again.',
  forbidden: 'The AI service said no. Check that your Google ID is on the allow-list in Settings.',
  throttled: 'Too many requests. Wait a moment.',
  server: 'Something went wrong on the AI service. Try again.',
  'invalid-reply': 'Something went wrong on the AI service. Try again.',
  rejected: 'Something went wrong on the AI service. Try again.',
  disabled: 'Turn on the AI assistant in Settings.',
  'not-configured': 'The AI service is not set up yet.',
  'no-token': 'Sign in again from the Home screen.',
};

export const MODE_OPTIONS: ReadonlyArray<{ value: ApplicationHelpMode; label: string }> = [
  { value: 'application', label: 'Application' },
  { value: 'email', label: 'Email' },
  { value: 'study', label: 'Study plan' },
];

/** The mode to open with: the block's kind first, then words in its title. */
export function defaultHelpMode(block: Pick<DeviceBlock, 'kind' | 'title'>): ApplicationHelpMode {
  if (block.kind === 'application' || block.kind === 'email' || block.kind === 'study') return block.kind;
  const title = block.title ?? '';
  if (/\b(apply|application|applications|resume|cover letter)\b/i.test(title)) return 'application';
  if (/\b(email|e-mail)\b/i.test(title)) return 'email';
  if (/\b(study|exam)\b/i.test(title)) return 'study';
  return 'application';
}

const isPoints = (v: ApplicationHelpResponse): v is ApplicationPointsResponse => 'points' in v && Array.isArray(v.points);
const isEmail = (v: ApplicationHelpResponse): v is EmailDraftResponse => 'subject' in v && 'body' in v;
const isSteps = (v: ApplicationHelpResponse): v is StudyStepsResponse => 'steps' in v && Array.isArray(v.steps);

/** True when the reply has the shape the chosen mode expects. */
export function matchesMode(mode: ApplicationHelpMode, value: ApplicationHelpResponse): boolean {
  return mode === 'application' ? isPoints(value) : mode === 'email' ? isEmail(value) : isSteps(value);
}

/** The plain-text rendering used by Copy and "Save to this task". */
export function resultToText(value: ApplicationHelpResponse): string {
  const lines: string[] = [];
  if (isPoints(value)) {
    if (value.points.length > 0) {
      lines.push('Talking points');
      value.points.forEach((p, i) => {
        lines.push(`${i + 1}. ${p.text}`);
        lines.push(`   From your background: "${p.quote}"`);
      });
    }
    if (value.missing.length > 0) {
      lines.push('', 'Add your own example');
      value.missing.forEach((m) => lines.push(`- ${m}`));
    }
    if (value.draft.trim()) lines.push('', 'Draft', value.draft.trim());
    if (value.checklist && value.checklist.length > 0) {
      lines.push('', 'Checklist');
      value.checklist.forEach((c) => lines.push(`- ${c}`));
    }
  } else if (isEmail(value)) {
    lines.push(`Subject: ${value.subject}`, '', value.body);
  } else if (isSteps(value)) {
    value.steps.forEach((s, i) => lines.push(`${i + 1}. ${s}`));
  }
  return lines.join('\n').trim();
}

type Loaded = { kind: 'loading' } | { kind: 'missing' } | { kind: 'ready'; block: DeviceBlock };
interface Outcome {
  mode: ApplicationHelpMode;
  value: ApplicationHelpResponse;
  /** Whether the user asked a question (an empty one means a checklist request). */
  asked: boolean;
}

export function ApplicationHelperScreen({ route }: RootScreenProps<'ApplicationHelper'>): React.JSX.Element {
  const { repos, ai, aiProfile, blockActions } = useAppServices();
  const { theme } = useTheme();
  const styles = useThemedStyles(createStyles);
  const { blockId, weekId } = route.params;

  const [loaded, setLoaded] = useState<Loaded>({ kind: 'loading' });
  const [mode, setMode] = useState<ApplicationHelpMode>('application');
  const [job, setJob] = useState('');
  const [question, setQuestion] = useState('');
  const [background, setBackground] = useState('');
  const [remember, setRemember] = useState(false);
  const [intent, setIntent] = useState('');
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [notice, setNotice] = useState<{ text: string; error: boolean } | null>(null);
  const mounted = useRef(true);
  const inFlight = useRef(false);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const blocks = await repos.blocks.get(weekId);
        const block = blocks.find((b) => b.id === blockId);
        if (cancelled || !mounted.current) return;
        if (!block) {
          setLoaded({ kind: 'missing' });
          return;
        }
        const profile = await aiProfile.get().catch(() => null);
        if (cancelled || !mounted.current) return;
        setMode(defaultHelpMode(block));
        setBackground(profile?.background ?? '');
        setLoaded({ kind: 'ready', block });
      } catch {
        if (!cancelled && mounted.current) setLoaded({ kind: 'missing' });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [repos, aiProfile, blockId, weekId]);

  const selectMode = useCallback((next: ApplicationHelpMode) => {
    setMode(next);
    setError(null);
    setOutcome(null);
    setNotice(null);
  }, []);

  const asking = question.trim().length > 0;

  const onSubmit = useCallback(async () => {
    if (inFlight.current || loaded.kind !== 'ready') return;
    setNotice(null);
    setOutcome(null);
    const title = loaded.block.title;
    let request: ApplicationHelpRequest;
    if (mode === 'application') {
      if (background.trim().length === 0) {
        setError(BACKGROUND_REQUIRED_MESSAGE);
        return;
      }
      request = { mode, title, background: background.trim() };
      if (job.trim()) request.job = job.trim();
      if (question.trim()) request.question = question.trim();
    } else {
      if (intent.trim().length === 0) {
        setError(mode === 'email' ? EMAIL_INTENT_REQUIRED_MESSAGE : STUDY_INTENT_REQUIRED_MESSAGE);
        return;
      }
      request = { mode, title, intent: intent.trim() };
    }
    setError(null);
    inFlight.current = true;
    setWorking(true);
    if (mode === 'application' && remember) {
      // Saved only now, when the user asks for help (R34.2). A failure here does not stop the call.
      await aiProfile.save(background).catch(() => null);
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const ceiling = new Promise<{ ok: false; reason: AiFailureReason }>((resolve) => {
      timer = setTimeout(() => resolve({ ok: false, reason: 'timeout' }), HELP_TIMEOUT_MS);
    });
    let message: string | null = null;
    let next: Outcome | null = null;
    try {
      const result = await Promise.race([ai.applicationHelp(request), ceiling]);
      if (!result.ok) message = FAILURE_MESSAGES[result.reason] ?? FAILURE_MESSAGES.server;
      else if (!matchesMode(mode, result.value)) message = FAILURE_MESSAGES['invalid-reply'];
      else next = { mode, value: result.value, asked: Boolean(request.question) };
    } catch {
      message = FAILURE_MESSAGES.server;
    } finally {
      if (timer) clearTimeout(timer);
      inFlight.current = false;
    }
    if (!mounted.current) return;
    setWorking(false);
    setError(message);
    setOutcome(next);
  }, [loaded, mode, background, job, question, intent, remember, ai, aiProfile]);

  const resultText = useMemo(() => (outcome ? resultToText(outcome.value) : ''), [outcome]);

  const onCopy = useCallback(() => {
    setNotice(copyText(resultText) ? { text: COPIED_MESSAGE, error: false } : { text: COPY_UNAVAILABLE_MESSAGE, error: true });
  }, [resultText]);

  const onSaveToTask = useCallback(async () => {
    try {
      const result = await blockActions.saveNotes({ weekId, blockId }, resultText);
      if (!mounted.current) return;
      setNotice(
        result.kind === 'saved'
          ? { text: SAVED_TO_TASK_MESSAGE, error: false }
          : { text: TASK_MISSING_MESSAGE, error: true },
      );
    } catch {
      if (mounted.current) setNotice({ text: SAVE_FAILED_MESSAGE, error: true });
    }
  }, [blockActions, weekId, blockId, resultText]);

  if (loaded.kind === 'loading') {
    return (
      <View style={[styles.screen, styles.centered]} testID="screen-ApplicationHelper">
        <ActivityIndicator color={theme.outline} accessibilityLabel="Loading" />
      </View>
    );
  }
  if (loaded.kind === 'missing') {
    return (
      <View style={[styles.screen, styles.centered]} testID="screen-ApplicationHelper">
        <Text accessibilityRole="alert" style={styles.body} testID="helper-missing">
          {BLOCK_MISSING_MESSAGE}
        </Text>
      </View>
    );
  }

  const actionLabel =
    mode === 'application'
      ? asking
        ? 'Get talking points'
        : 'Outline my application checklist'
      : mode === 'email'
        ? 'Draft the email'
        : 'Plan my study steps';

  return (
    <ScrollView
      style={styles.screen}
      contentContainerStyle={styles.content}
      keyboardShouldPersistTaps="handled"
      testID="screen-ApplicationHelper"
    >
      <Text accessibilityRole="header" style={styles.title} testID="helper-title">
        {loaded.block.title}
      </Text>

      <View accessibilityRole="radiogroup" accessibilityLabel="Kind of help" testID="helper-modes">
        {MODE_OPTIONS.map((option) => {
          const selected = mode === option.value;
          return (
            <Pressable
              key={option.value}
              accessibilityRole="radio"
              accessibilityLabel={option.label}
              accessibilityState={{ checked: selected, disabled: working }}
              disabled={working}
              onPress={() => {
                if (!selected) selectMode(option.value);
              }}
              style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
              testID={`helper-mode-${option.value}`}
            >
              <View style={[styles.radioOuter, selected && styles.radioOuterSelected]}>
                {selected ? <View style={styles.radioInner} /> : null}
              </View>
              <Text style={styles.rowText}>{option.label}</Text>
            </Pressable>
          );
        })}
      </View>

      {mode === 'application' ? (
        <>
          <Text style={styles.label}>Job posting or description</Text>
          <TextInput
            accessibilityLabel="Job posting or description"
            accessibilityHint="Optional. Paste the posting. Up to 6,000 characters."
            multiline
            maxLength={AI_MAX_JOB_CHARS}
            value={job}
            onChangeText={setJob}
            editable={!working}
            textAlignVertical="top"
            placeholderTextColor={theme.textMuted}
            style={[styles.input, styles.tall]}
            testID="helper-job"
          />
          <Text style={styles.count}>
            {job.length}/{AI_MAX_JOB_CHARS}
          </Text>

          <Text style={styles.label}>Question to answer</Text>
          <TextInput
            accessibilityLabel="Question to answer"
            accessibilityHint="Optional. Leave empty to get a checklist. Up to 600 characters."
            multiline
            maxLength={AI_MAX_QUESTION_CHARS}
            value={question}
            onChangeText={setQuestion}
            editable={!working}
            textAlignVertical="top"
            placeholderTextColor={theme.textMuted}
            style={[styles.input, styles.medium]}
            testID="helper-question"
          />
          <Text style={styles.count}>
            {question.length}/{AI_MAX_QUESTION_CHARS}
          </Text>

          <Text style={styles.label}>Your background</Text>
          <TextInput
            accessibilityLabel="Your background"
            accessibilityHint="A few lines about your experience. Up to 3,000 characters."
            multiline
            maxLength={AI_MAX_BACKGROUND_CHARS}
            value={background}
            onChangeText={setBackground}
            editable={!working}
            textAlignVertical="top"
            placeholderTextColor={theme.textMuted}
            style={[styles.input, styles.tall]}
            testID="helper-background"
          />
          <Text style={styles.count}>
            {background.length}/{AI_MAX_BACKGROUND_CHARS}
          </Text>
          <View style={styles.row}>
            <Text style={[styles.rowText, styles.rowBody]}>Remember this background on my phone</Text>
            <Switch
              accessibilityRole="switch"
              accessibilityLabel="Remember this background on my phone"
              accessibilityState={{ checked: remember, disabled: working }}
              value={remember}
              disabled={working}
              onValueChange={setRemember}
              testID="helper-remember"
            />
          </View>
        </>
      ) : (
        <>
          <Text style={styles.label}>
            {mode === 'email' ? 'What do you want to say? (one line)' : 'What are you studying and by when?'}
          </Text>
          <TextInput
            accessibilityLabel={mode === 'email' ? 'What do you want to say? (one line)' : 'What are you studying and by when?'}
            accessibilityHint="Up to 300 characters."
            maxLength={AI_MAX_INTENT_CHARS}
            value={intent}
            onChangeText={setIntent}
            editable={!working}
            placeholderTextColor={theme.textMuted}
            style={styles.input}
            testID="helper-intent"
          />
          <Text style={styles.count}>
            {intent.length}/{AI_MAX_INTENT_CHARS}
          </Text>
        </>
      )}

      <Pressable
        accessibilityRole="button"
        accessibilityLabel={actionLabel}
        accessibilityState={{ disabled: working, busy: working }}
        disabled={working}
        onPress={() => void onSubmit()}
        style={({ pressed }) => [styles.primaryButton, (pressed || working) && styles.dimmed]}
        testID="helper-submit"
      >
        <Text style={styles.primaryText}>{actionLabel}</Text>
      </Pressable>

      {working ? (
        <View style={styles.progress} accessible accessibilityLiveRegion="polite" accessibilityLabel={WORKING_MESSAGE} testID="helper-working">
          <ActivityIndicator color={theme.outline} />
          <Text style={styles.body}>{WORKING_MESSAGE}</Text>
        </View>
      ) : null}
      {error ? (
        <Text accessibilityRole="alert" accessibilityLiveRegion="assertive" style={styles.error} testID="helper-error">
          {error}
        </Text>
      ) : null}

      {outcome ? <Results outcome={outcome} styles={styles} /> : null}

      {outcome ? (
        <View style={styles.actions}>
          <View style={styles.buttonRow}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Copy"
              accessibilityHint="Copies the result to the clipboard"
              onPress={onCopy}
              style={({ pressed }) => [styles.outlinedButton, pressed && styles.outlinedPressed]}
              testID="helper-copy"
            >
              <Text style={styles.outlinedText}>Copy</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Save to this task"
              accessibilityHint="Keeps the result in this task's notes on your phone"
              onPress={() => void onSaveToTask()}
              style={({ pressed }) => [styles.outlinedButton, pressed && styles.outlinedPressed]}
              testID="helper-save"
            >
              <Text style={styles.outlinedText}>Save to this task</Text>
            </Pressable>
          </View>
          {notice ? (
            <Text
              accessibilityRole="alert"
              accessibilityLiveRegion="polite"
              style={notice.error ? styles.error : styles.notice}
              testID="helper-notice"
            >
              {notice.text}
            </Text>
          ) : null}
        </View>
      ) : null}
    </ScrollView>
  );
}

type Styles = ReturnType<typeof createStyles>;

/** The result, in reading order: banner, then the content for the mode. */
function Results({ outcome, styles }: { outcome: Outcome; styles: Styles }): React.JSX.Element {
  const { value } = outcome;
  return (
    <View style={styles.results} testID="helper-results">
      <View style={styles.banner} accessibilityRole="alert" accessible accessibilityLabel={HELP_BANNER} testID="helper-banner">
        <Text style={styles.bannerText}>{HELP_BANNER}</Text>
      </View>
      {isPoints(value) ? <ApplicationResult value={value} asked={outcome.asked} styles={styles} /> : null}
      {isEmail(value) ? (
        <View style={styles.card}>
          <Text accessibilityRole="header" style={styles.cardTitle}>
            Subject
          </Text>
          <Text selectable style={styles.body} testID="helper-email-subject">
            {value.subject}
          </Text>
          <Text accessibilityRole="header" style={styles.cardTitle}>
            Email
          </Text>
          <Text selectable style={styles.body} testID="helper-email-body">
            {value.body}
          </Text>
        </View>
      ) : null}
      {isSteps(value) ? (
        <View style={styles.card} testID="helper-steps">
          <Text accessibilityRole="header" style={styles.cardTitle}>
            Study steps
          </Text>
          {value.steps.map((step, i) => (
            <Text key={`${i}-${step}`} selectable style={styles.body} testID={`helper-step-${i + 1}`}>
              {`${i + 1}. ${step}`}
            </Text>
          ))}
        </View>
      ) : null}
    </View>
  );
}

function ApplicationResult({
  value,
  asked,
  styles,
}: {
  value: ApplicationPointsResponse;
  asked: boolean;
  styles: Styles;
}): React.JSX.Element {
  const hasChecklist = (value.checklist?.length ?? 0) > 0;
  const hasDraft = value.draft.trim().length > 0;
  const empty = value.points.length === 0 && !hasDraft && !(hasChecklist && !asked);
  return (
    <>
      {empty ? (
        <View style={styles.card} testID="helper-empty">
          <Text style={styles.cardTitle}>{NOTHING_MATCHES_MESSAGE}</Text>
          <Text style={styles.label}>Try answering one of these in your background:</Text>
          {SUGGESTED_PROMPTS.map((p) => (
            <Text key={p} style={styles.body}>{`• ${p}`}</Text>
          ))}
        </View>
      ) : null}
      {value.points.length > 0 ? (
        <View style={styles.card} testID="helper-points">
          <Text accessibilityRole="header" style={styles.cardTitle}>
            Talking points
          </Text>
          {value.points.map((p, i) => (
            <View key={`${i}-${p.text}`} style={styles.point} testID={`helper-point-${i + 1}`}>
              <Text selectable style={styles.body}>{`${i + 1}. ${p.text}`}</Text>
              <Text selectable style={styles.muted}>{`From your background: "${p.quote}"`}</Text>
            </View>
          ))}
        </View>
      ) : null}
      {value.missing.length > 0 ? (
        <View style={styles.card} testID="helper-missing-list">
          <Text accessibilityRole="header" style={styles.cardTitle}>
            Add your own example
          </Text>
          {value.missing.map((m, i) => (
            <Text key={`${i}-${m}`} style={styles.body}>{`• ${m}`}</Text>
          ))}
        </View>
      ) : null}
      {hasDraft ? (
        <View style={styles.card} testID="helper-draft-card">
          <Text accessibilityRole="header" style={styles.cardTitle}>
            Draft
          </Text>
          <Text selectable style={styles.body} testID="helper-draft">
            {value.draft}
          </Text>
        </View>
      ) : null}
      {hasChecklist ? (
        <View style={styles.card} testID="helper-checklist">
          <Text accessibilityRole="header" style={styles.cardTitle}>
            Checklist
          </Text>
          {value.checklist!.map((c, i) => (
            <Text key={`${i}-${c}`} selectable style={styles.body}>{`• ${c}`}</Text>
          ))}
        </View>
      ) : null}
    </>
  );
}

const createStyles = (theme: Theme) =>
  ({
    screen: { flex: 1, backgroundColor: theme.background },
    content: { padding: 16, paddingBottom: 48, gap: 6 },
    centered: { alignItems: 'center', justifyContent: 'center', padding: 24 },
    title: { fontSize: 22, fontWeight: '700', color: theme.text, marginBottom: 8 },
    label: { marginTop: 12, fontSize: 14, fontWeight: '600', color: theme.textMuted },
    count: { fontSize: 12, color: theme.textMuted, textAlign: 'right' },
    body: { fontSize: 16, color: theme.text },
    muted: { fontSize: 14, color: theme.textMuted },
    row: { minHeight: 48, flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 8 },
    rowPressed: { backgroundColor: theme.pressed },
    rowBody: { flex: 1 },
    rowText: { fontSize: 16, color: theme.text },
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
    input: {
      minHeight: 48,
      borderWidth: 1,
      borderColor: theme.textMuted,
      borderRadius: 8,
      paddingHorizontal: 12,
      paddingVertical: 10,
      fontSize: 16,
      color: theme.text,
      backgroundColor: theme.surface,
    },
    tall: { minHeight: 140 },
    medium: { minHeight: 80 },
    primaryButton: {
      minHeight: 48,
      marginTop: 16,
      alignItems: 'center',
      justifyContent: 'center',
      borderRadius: 24,
      paddingHorizontal: 20,
      backgroundColor: theme.primary,
    },
    dimmed: { opacity: 0.6 },
    primaryText: { fontSize: 16, fontWeight: '600', color: theme.onPrimary },
    outlinedButton: {
      minHeight: 48,
      flex: 1,
      alignItems: 'center',
      justifyContent: 'center',
      borderRadius: 24,
      borderWidth: 2,
      borderColor: theme.primary,
      paddingHorizontal: 16,
    },
    outlinedPressed: { backgroundColor: theme.pressed },
    outlinedText: { fontSize: 16, fontWeight: '600', color: theme.outline },
    progress: { flexDirection: 'row', alignItems: 'center', gap: 12, marginTop: 12 },
    error: { marginTop: 12, fontSize: 16, fontWeight: '600', color: theme.danger },
    notice: { marginTop: 8, fontSize: 16, fontWeight: '600', color: theme.text },
    results: { marginTop: 16, gap: 12 },
    banner: {
      padding: 12,
      borderRadius: 8,
      borderWidth: 1,
      borderColor: theme.warning,
      backgroundColor: theme.surface,
    },
    bannerText: { fontSize: 16, fontWeight: '600', color: theme.text },
    card: {
      gap: 6,
      padding: 12,
      borderRadius: 8,
      borderWidth: 1,
      borderColor: theme.border,
      backgroundColor: theme.surface,
    },
    cardTitle: { fontSize: 16, fontWeight: '700', color: theme.text },
    point: { gap: 2, marginTop: 4 },
    actions: { marginTop: 16, gap: 8 },
    buttonRow: { flexDirection: 'row', gap: 8 },
  }) satisfies Record<string, ViewStyle | TextStyle>;
