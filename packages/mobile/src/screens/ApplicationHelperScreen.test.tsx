/**
 * ApplicationHelperScreen tests (R34.2-R34.6, R35.4): mode defaults, input
 * caps, validation, every failure reason, results for the three modes, the
 * background "remember" toggle, Copy, Save to this task, and dark mode.
 */
import React from 'react';
import { StyleSheet } from 'react-native';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import type { AiFailureReason, ApplicationHelpResponse, DeviceBlock } from '@timeblocker/app-core';
import { AppServicesProvider } from '../services/AppServices';
import { ThemeProvider } from '../theme';
import { darkTheme } from '../theme/tokens';
import { createTestServices, type TestState } from '../services/testServices';
import {
  ApplicationHelperScreen,
  BACKGROUND_REQUIRED_MESSAGE,
  COPIED_MESSAGE,
  COPY_UNAVAILABLE_MESSAGE,
  EMAIL_INTENT_REQUIRED_MESSAGE,
  FAILURE_MESSAGES,
  HELP_BANNER,
  HELP_TIMEOUT_MS,
  NOTHING_MATCHES_MESSAGE,
  SAVED_TO_TASK_MESSAGE,
  STUDY_INTENT_REQUIRED_MESSAGE,
  SUGGESTED_PROMPTS,
  TASK_MISSING_MESSAGE,
  defaultHelpMode,
  resultToText,
} from './ApplicationHelperScreen';

jest.mock('react-native-safe-area-context', () => require('react-native-safe-area-context/jest/mock').default);
const mockCopy = jest.fn((_text: string) => true);
jest.mock('../clipboard', () => ({ copyText: (t: string) => mockCopy(t) }));

const WEEK = '2025-01-05';
const block = (overrides: Partial<DeviceBlock> = {}): DeviceBlock => ({
  id: 'b1',
  itemId: 'item-b1',
  title: 'Task',
  start: '2025-01-09T14:00:00.000Z',
  end: '2025-01-09T15:00:00.000Z',
  category: 'work',
  status: 'scheduled',
  weekId: WEEK,
  calendarEventId: 'evtb10000',
  calendarSynced: true,
  promptedMeetingIds: [],
  usagePrompted: false,
  updatedAt: 0,
  ...overrides,
});

const APPLICATION: ApplicationHelpResponse = {
  points: [
    { text: 'You led a data project', quote: 'led the analytics project' },
    { text: 'You shipped on time', quote: 'shipped two weeks early' },
  ],
  missing: ['Add your own example for: teamwork'],
  draft: 'I led an analytics project and shipped early. [add detail]',
  checklist: ['Update resume', 'Write cover letter'],
};

async function renderHelper(b: DeviceBlock = block({ kind: 'application' }), seed: Partial<TestState> = {}) {
  const services = createTestServices({ authState: { status: 'signed-in' }, blocks: { [WEEK]: [b] }, aiAvailability: 'ready', ...seed });
  const route = { key: 'k', name: 'ApplicationHelper', params: { blockId: b.id, weekId: WEEK } };
  await render(
    <AppServicesProvider services={services}>
      <ThemeProvider>
        <ApplicationHelperScreen {...(({ route, navigation: {} } as unknown) as React.ComponentProps<typeof ApplicationHelperScreen>)} />
      </ThemeProvider>
    </AppServicesProvider>,
  );
  await screen.findByTestId('helper-modes');
  return services;
}

const radio = (name: string) => screen.getByRole('radio', { name });
const submit = () => screen.getByTestId('helper-submit');
const press = async (el: ReturnType<typeof screen.getByTestId>) => {
  await fireEvent.press(el);
};
async function fillApplication(question = 'Why this role?') {
  await fireEvent.changeText(screen.getByTestId('helper-background'), 'I led the analytics project and shipped two weeks early.');
  if (question) await fireEvent.changeText(screen.getByTestId('helper-question'), question);
}

describe('defaultHelpMode', () => {
  it.each([
    [{ kind: 'email' as const, title: 'x' }, 'email'],
    [{ kind: 'study' as const, title: 'x' }, 'study'],
    [{ kind: 'application' as const, title: 'x' }, 'application'],
    [{ title: 'Apply to Acme' }, 'application'],
    [{ title: 'Update resume' }, 'application'],
    [{ title: 'Cover letter' }, 'application'],
    [{ title: 'Email prof' }, 'email'],
    [{ title: 'Study for exam' }, 'study'],
    [{ title: 'Exam prep' }, 'study'],
    [{ title: 'Write report' }, 'application'],
  ])('%j -> %s', (b, mode) => {
    expect(defaultHelpMode(b)).toBe(mode);
  });
});

describe('ApplicationHelperScreen: modes and inputs', () => {
  beforeEach(() => mockCopy.mockClear());

  it('opens in the mode matching the block and offers the three modes', async () => {
    await renderHelper(block({ title: 'Email prof about extension' }));
    expect(screen.getAllByRole('radio').map((r) => r.props.accessibilityLabel)).toEqual(['Application', 'Email', 'Study plan']);
    expect(radio('Email')).toBeChecked();
    expect(screen.getByLabelText('What do you want to say? (one line)')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Draft the email' })).toBeTruthy();
    await press(radio('Study plan'));
    expect(radio('Study plan')).toBeChecked();
    expect(screen.getByLabelText('What are you studying and by when?')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Plan my study steps' })).toBeTruthy();
    await press(radio('Application'));
    expect(screen.getByLabelText('Job posting or description')).toBeTruthy();
    expect(screen.getByLabelText('Question to answer')).toBeTruthy();
    expect(screen.getByLabelText('Your background')).toBeTruthy();
  });

  it('defaults to study for a study block', async () => {
    await renderHelper(block({ kind: 'study' }));
    expect(radio('Study plan')).toBeChecked();
  });

  it('caps the inputs and prefills the background from "About me"', async () => {
    await renderHelper(block({ kind: 'application' }), { aiProfile: { background: 'Saved bio', updatedAt: 1 } });
    expect(screen.getByTestId('helper-job').props.maxLength).toBe(6000);
    expect(screen.getByTestId('helper-question').props.maxLength).toBe(600);
    expect(screen.getByTestId('helper-background').props.maxLength).toBe(3000);
    expect(screen.getByTestId('helper-background').props.value).toBe('Saved bio');
    await press(radio('Email'));
    expect(screen.getByTestId('helper-intent').props.maxLength).toBe(300);
  });

  it('switches the button label when the question is empty', async () => {
    await renderHelper();
    expect(screen.getByRole('button', { name: 'Outline my application checklist' })).toBeTruthy();
    await fireEvent.changeText(screen.getByTestId('helper-question'), 'Why us?');
    expect(screen.getByRole('button', { name: 'Get talking points' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Outline my application checklist' })).toBeNull();
  });

  it('shows a message for a block that no longer exists', async () => {
    const services = createTestServices({ authState: { status: 'signed-in' }, aiAvailability: 'ready' });
    const route = { key: 'k', name: 'ApplicationHelper', params: { blockId: 'gone', weekId: WEEK } };
    await render(
      <AppServicesProvider services={services}>
        <ApplicationHelperScreen {...(({ route, navigation: {} } as unknown) as React.ComponentProps<typeof ApplicationHelperScreen>)} />
      </AppServicesProvider>,
    );
    expect(await screen.findByTestId('helper-missing')).toBeTruthy();
  });
});

describe('ApplicationHelperScreen: validation', () => {
  it('asks for a background before calling the service', async () => {
    const services = await renderHelper();
    await fireEvent.changeText(screen.getByTestId('helper-question'), 'Why us?');
    await press(submit());
    expect(screen.getByTestId('helper-error')).toHaveTextContent(BACKGROUND_REQUIRED_MESSAGE);
    expect(BACKGROUND_REQUIRED_MESSAGE).toBe('Add a few lines about your background first.');
    expect(services.ai.applicationHelp).not.toHaveBeenCalled();
  });

  it('asks for the email and study lines', async () => {
    const services = await renderHelper(block({ kind: 'email' }));
    await press(submit());
    expect(screen.getByTestId('helper-error')).toHaveTextContent(EMAIL_INTENT_REQUIRED_MESSAGE);
    await press(radio('Study plan'));
    expect(screen.queryByTestId('helper-error')).toBeNull();
    await press(submit());
    expect(screen.getByTestId('helper-error')).toHaveTextContent(STUDY_INTENT_REQUIRED_MESSAGE);
    expect(services.ai.applicationHelp).not.toHaveBeenCalled();
  });
});

describe('ApplicationHelperScreen: failures', () => {
  const EXPECTED: Record<AiFailureReason, string> = {
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
  it('has a message for every reason', () => {
    expect(FAILURE_MESSAGES).toEqual(EXPECTED);
  });
  it.each(Object.keys(EXPECTED) as AiFailureReason[])('shows the message for %s and stays usable', async (reason) => {
    const services = await renderHelper();
    services.ai.applicationHelp.mockResolvedValueOnce({ ok: false, reason });
    await fillApplication();
    await press(submit());
    expect(await screen.findByTestId('helper-error')).toHaveTextContent(EXPECTED[reason]);
    expect(screen.queryByTestId('helper-results')).toBeNull();
    expect(screen.queryByTestId('helper-working')).toBeNull();
    expect(submit()).not.toBeDisabled();
  });

  it('shows progress, then a timeout message after 25 seconds', async () => {
    jest.useFakeTimers();
    try {
      const services = await renderHelper();
      services.ai.applicationHelp.mockImplementationOnce(() => new Promise(() => undefined));
      await fillApplication();
      await press(submit());
      expect(screen.getByTestId('helper-working')).toHaveTextContent('Working on it…');
      expect(submit()).toBeDisabled();
      await act(async () => {
        jest.advanceTimersByTime(HELP_TIMEOUT_MS - 1);
      });
      expect(screen.queryByTestId('helper-error')).toBeNull();
      await act(async () => {
        jest.advanceTimersByTime(2);
      });
      expect(screen.getByTestId('helper-error')).toHaveTextContent(EXPECTED.timeout);
      expect(screen.queryByTestId('helper-working')).toBeNull();
    } finally {
      jest.useRealTimers();
    }
  });

  it('treats a reply of the wrong shape as an invalid reply', async () => {
    const services = await renderHelper();
    services.ai.applicationHelp.mockResolvedValueOnce({ ok: true, value: { steps: ['a'] } });
    await fillApplication();
    await press(submit());
    expect(await screen.findByTestId('helper-error')).toHaveTextContent(EXPECTED['invalid-reply']);
  });

  it('treats a thrown error as a service problem', async () => {
    const services = await renderHelper();
    services.ai.applicationHelp.mockRejectedValueOnce(new Error('boom'));
    await fillApplication();
    await press(submit());
    expect(await screen.findByTestId('helper-error')).toHaveTextContent(EXPECTED.server);
  });
});

describe('ApplicationHelperScreen: results', () => {
  beforeEach(() => mockCopy.mockClear());

  it('sends the application request and renders points, quotes, missing, draft, checklist and the banner', async () => {
    const services = await renderHelper(block({ kind: 'application', title: 'Apply to Acme' }));
    services.ai.applicationHelp.mockResolvedValueOnce({ ok: true, value: APPLICATION });
    await fireEvent.changeText(screen.getByTestId('helper-job'), 'Analyst at Acme');
    await fillApplication('Why this role?');
    await press(submit());
    await screen.findByTestId('helper-results');
    expect(services.ai.applicationHelp).toHaveBeenCalledWith({
      mode: 'application',
      title: 'Apply to Acme',
      job: 'Analyst at Acme',
      question: 'Why this role?',
      background: 'I led the analytics project and shipped two weeks early.',
    });
    expect(HELP_BANNER).toBe('Draft: check every claim before you use it.');
    const banner = screen.getByTestId('helper-banner');
    expect(banner).toHaveTextContent(HELP_BANNER);
    expect(banner.props.accessibilityRole).toBe('alert');
    expect(screen.getByTestId('helper-point-1')).toHaveTextContent(/1\. You led a data project/);
    expect(screen.getByTestId('helper-point-1')).toHaveTextContent(/From your background: "led the analytics project"/);
    expect(screen.getByTestId('helper-point-2')).toHaveTextContent(/From your background: "shipped two weeks early"/);
    expect(screen.getByText('Add your own example')).toBeTruthy();
    expect(screen.getByText('• Add your own example for: teamwork')).toBeTruthy();
    expect(screen.getByTestId('helper-draft').props.selectable).toBe(true);
    expect(screen.getByTestId('helper-draft')).toHaveTextContent(/I led an analytics project/);
    expect(screen.getByTestId('helper-checklist')).toHaveTextContent(/Write cover letter/);
    expect(screen.queryByTestId('helper-empty')).toBeNull();
  });

  it('omits empty fields from the request (checklist mode)', async () => {
    const services = await renderHelper();
    services.ai.applicationHelp.mockResolvedValueOnce({ ok: true, value: { points: [], missing: [], draft: '', checklist: ['Update resume'] } });
    await fillApplication('');
    await press(submit());
    await screen.findByTestId('helper-results');
    expect(services.ai.applicationHelp).toHaveBeenCalledWith({
      mode: 'application',
      title: 'Task',
      background: 'I led the analytics project and shipped two weeks early.',
    });
    expect(screen.getByTestId('helper-checklist')).toBeTruthy();
    expect(screen.queryByTestId('helper-empty')).toBeNull();
  });

  it('shows the exact empty message with suggested prompts when nothing matches', async () => {
    const services = await renderHelper();
    services.ai.applicationHelp.mockResolvedValueOnce({
      ok: true,
      value: { points: [], missing: ['Add your own example for: leadership'], draft: '' },
    });
    await fillApplication();
    await press(submit());
    await screen.findByTestId('helper-empty');
    expect(NOTHING_MATCHES_MESSAGE).toBe('Nothing in your background matches this question yet.');
    expect(screen.getByText(NOTHING_MATCHES_MESSAGE)).toBeTruthy();
    for (const p of SUGGESTED_PROMPTS) expect(screen.getByText(`• ${p}`)).toBeTruthy();
    expect(SUGGESTED_PROMPTS).toContain('What project used data to make a decision?');
    expect(screen.getByText('• Add your own example for: leadership')).toBeTruthy();
    expect(screen.queryByTestId('helper-draft')).toBeNull();
  });

  it('renders an email draft', async () => {
    const services = await renderHelper(block({ kind: 'email' }));
    services.ai.applicationHelp.mockResolvedValueOnce({ ok: true, value: { subject: 'Extension request', body: 'Hello Prof,\nMay I have more time?' } });
    await fireEvent.changeText(screen.getByTestId('helper-intent'), 'ask for an extension');
    await press(submit());
    await screen.findByTestId('helper-results');
    expect(services.ai.applicationHelp).toHaveBeenCalledWith({ mode: 'email', title: 'Task', intent: 'ask for an extension' });
    expect(screen.getByTestId('helper-email-subject')).toHaveTextContent('Extension request');
    expect(screen.getByTestId('helper-email-body')).toHaveTextContent(/May I have more time\?/);
    expect(screen.getByTestId('helper-banner')).toBeTruthy();
  });

  it('renders numbered study steps', async () => {
    const services = await renderHelper(block({ kind: 'study' }));
    services.ai.applicationHelp.mockResolvedValueOnce({ ok: true, value: { steps: ['Read chapter 1', 'Do practice problems'] } });
    await fireEvent.changeText(screen.getByTestId('helper-intent'), 'calculus by Friday');
    await press(submit());
    await screen.findByTestId('helper-steps');
    expect(services.ai.applicationHelp).toHaveBeenCalledWith({ mode: 'study', title: 'Task', intent: 'calculus by Friday' });
    expect(screen.getByTestId('helper-step-1')).toHaveTextContent('1. Read chapter 1');
    expect(screen.getByTestId('helper-step-2')).toHaveTextContent('2. Do practice problems');
  });

  it('clears the result when the mode changes', async () => {
    const services = await renderHelper(block({ kind: 'study' }));
    services.ai.applicationHelp.mockResolvedValueOnce({ ok: true, value: { steps: ['a'] } });
    await fireEvent.changeText(screen.getByTestId('helper-intent'), 'x');
    await press(submit());
    await screen.findByTestId('helper-steps');
    await press(radio('Email'));
    expect(screen.queryByTestId('helper-results')).toBeNull();
  });
});

describe('ApplicationHelperScreen: remember, copy and save', () => {
  beforeEach(() => mockCopy.mockClear());

  it('saves the background only when "Remember" is on and the action is tapped', async () => {
    const services = await renderHelper();
    services.ai.applicationHelp.mockResolvedValue({ ok: true, value: APPLICATION });
    await fillApplication();
    const toggle = screen.getByRole('switch', { name: 'Remember this background on my phone' });
    expect(toggle).not.toBeChecked();
    await press(submit());
    await screen.findByTestId('helper-results');
    expect(services.aiProfile.save).not.toHaveBeenCalled();
    await fireEvent(toggle, 'valueChange', true);
    expect(services.aiProfile.save).not.toHaveBeenCalled();
    await press(submit());
    await waitFor(() => expect(services.aiProfile.save).toHaveBeenCalledWith('I led the analytics project and shipped two weeks early.'));
    expect(services.state.aiProfile?.background).toContain('analytics project');
  });

  it('still calls the service when saving the background fails', async () => {
    const services = await renderHelper();
    services.aiProfile.save.mockRejectedValueOnce(new Error('disk'));
    services.ai.applicationHelp.mockResolvedValueOnce({ ok: true, value: APPLICATION });
    await fillApplication();
    await fireEvent(screen.getByRole('switch', { name: 'Remember this background on my phone' }), 'valueChange', true);
    await press(submit());
    await screen.findByTestId('helper-results');
    expect(services.ai.applicationHelp).toHaveBeenCalledTimes(1);
  });

  it('copies the plain-text result', async () => {
    const services = await renderHelper();
    services.ai.applicationHelp.mockResolvedValueOnce({ ok: true, value: APPLICATION });
    await fillApplication();
    await press(submit());
    await screen.findByTestId('helper-results');
    await press(screen.getByRole('button', { name: 'Copy' }));
    expect(mockCopy).toHaveBeenCalledWith(resultToText(APPLICATION));
    expect(screen.getByTestId('helper-notice')).toHaveTextContent(COPIED_MESSAGE);
  });

  it('points to text selection when copying fails', async () => {
    const services = await renderHelper(block({ kind: 'study' }));
    services.ai.applicationHelp.mockResolvedValueOnce({ ok: true, value: { steps: ['a'] } });
    await fireEvent.changeText(screen.getByTestId('helper-intent'), 'x');
    await press(submit());
    await screen.findByTestId('helper-steps');
    mockCopy.mockReturnValueOnce(false);
    await press(screen.getByRole('button', { name: 'Copy' }));
    expect(screen.getByTestId('helper-notice')).toHaveTextContent(COPY_UNAVAILABLE_MESSAGE);
  });

  it('saves the result to the task notes', async () => {
    const services = await renderHelper(block({ kind: 'email' }));
    services.ai.applicationHelp.mockResolvedValueOnce({ ok: true, value: { subject: 'Hi', body: 'Body' } });
    await fireEvent.changeText(screen.getByTestId('helper-intent'), 'say hi');
    await press(submit());
    await screen.findByTestId('helper-results');
    await press(screen.getByRole('button', { name: 'Save to this task' }));
    expect(services.blockActions.saveNotes).toHaveBeenCalledWith({ weekId: WEEK, blockId: 'b1' }, 'Subject: Hi\n\nBody');
    expect(await screen.findByText(SAVED_TO_TASK_MESSAGE)).toBeTruthy();
    expect(services.state.blocks[WEEK]![0]!.notes).toBe('Subject: Hi\n\nBody');
  });

  it('reports a task that no longer exists, and a failed save', async () => {
    const services = await renderHelper(block({ kind: 'email' }));
    services.ai.applicationHelp.mockResolvedValueOnce({ ok: true, value: { subject: 'Hi', body: 'Body' } });
    await fireEvent.changeText(screen.getByTestId('helper-intent'), 'say hi');
    await press(submit());
    await screen.findByTestId('helper-results');
    services.blockActions.saveNotes.mockResolvedValueOnce({ kind: 'not-found' });
    await press(screen.getByRole('button', { name: 'Save to this task' }));
    expect(await screen.findByText(TASK_MISSING_MESSAGE)).toBeTruthy();
    services.blockActions.saveNotes.mockRejectedValueOnce(new Error('x'));
    await press(screen.getByRole('button', { name: 'Save to this task' }));
    expect(await screen.findByText("That didn't save. Try again.")).toBeTruthy();
  });
});

describe('resultToText', () => {
  it('renders each shape as plain text', () => {
    expect(resultToText(APPLICATION)).toBe(
      [
        'Talking points',
        '1. You led a data project',
        '   From your background: "led the analytics project"',
        '2. You shipped on time',
        '   From your background: "shipped two weeks early"',
        '',
        'Add your own example',
        '- Add your own example for: teamwork',
        '',
        'Draft',
        'I led an analytics project and shipped early. [add detail]',
        '',
        'Checklist',
        '- Update resume',
        '- Write cover letter',
      ].join('\n'),
    );
    expect(resultToText({ subject: 'S', body: 'B' })).toBe('Subject: S\n\nB');
    expect(resultToText({ steps: ['a', 'b'] })).toBe('1. a\n2. b');
  });
});

describe('ApplicationHelperScreen: dark mode', () => {
  it('uses the dark tokens', async () => {
    const services = createTestServices({ authState: { status: 'signed-in' }, blocks: { [WEEK]: [block({ kind: 'email' })] }, aiAvailability: 'ready' });
    services.state.settings = { ...services.state.settings, themeMode: 'dark' };
    services.ai.applicationHelp.mockResolvedValueOnce({ ok: true, value: { subject: 'S', body: 'B' } });
    const route = { key: 'k', name: 'ApplicationHelper', params: { blockId: 'b1', weekId: WEEK } };
    await render(
      <AppServicesProvider services={services}>
        <ThemeProvider>
          <ApplicationHelperScreen {...(({ route, navigation: {} } as unknown) as React.ComponentProps<typeof ApplicationHelperScreen>)} />
        </ThemeProvider>
      </AppServicesProvider>,
    );
    const flat = (el: { props: { style?: unknown } }) => StyleSheet.flatten(el.props.style as never) as Record<string, unknown>;
    await screen.findByTestId('helper-modes');
    await waitFor(() => expect(flat(screen.getByTestId('screen-ApplicationHelper')).backgroundColor).toBe(darkTheme.background));
    expect(flat(screen.getByTestId('helper-intent'))).toMatchObject({ backgroundColor: darkTheme.surface, color: darkTheme.text });
    expect(flat(screen.getByText('Draft the email')).color).toBe(darkTheme.onPrimary);
    await fireEvent.changeText(screen.getByTestId('helper-intent'), 'x');
    await fireEvent.press(screen.getByTestId('helper-submit'));
    await screen.findByTestId('helper-banner');
    expect(flat(screen.getByText(HELP_BANNER)).color).toBe(darkTheme.text);
    expect(flat(screen.getByTestId('helper-banner')).backgroundColor).toBe(darkTheme.surface);
  });
});
