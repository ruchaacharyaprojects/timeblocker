import type { AiAvailability, AiPort, AiResult, ParseTasksItem } from '@timeblocker/app-core';
import type { IntakeCandidate } from '@timeblocker/flows';
import { createAiEnhancer } from './aiEnhancer';

function candidate(text: string, category: IntakeCandidate['category'], source: 'default' | 'keyword' | 'stated' | 'history' | undefined): IntakeCandidate {
  return {
    text,
    durationMin: 30,
    priority: 3,
    category,
    lowConfidence: false,
    count: 1,
    ...(source ? { source: { duration: 'default' as const, category: source } } : {}),
  };
}

function fakeAi(result: AiResult<ParseTasksItem[]>, availability: AiAvailability = 'ready') {
  const parseTasks = jest.fn(async (_titles: readonly string[]) => result);
  const ai: AiPort = {
    availability: async () => availability,
    parseTasks,
    applicationHelp: async () => ({ ok: false, reason: 'rejected' }),
  };
  return { ai, parseTasks };
}

describe('createAiEnhancer (R33.1, R33.4)', () => {
  it('sets kind always; category only where the built-in source is default and not misc', async () => {
    const input = [
      candidate('Apply to job', 'misc', 'default'),
      candidate('Email prof', 'misc', 'default'),
      candidate('Gym', 'fitness', 'keyword'),
      candidate('Report', 'work', 'stated'),
      candidate('Learn', 'self-development', 'history'),
      candidate('Old draft', 'misc', undefined),
    ];
    const items: ParseTasksItem[] = [
      { index: 0, category: 'work', kind: 'application' },
      { index: 1, category: 'misc', kind: 'email' },
      { index: 2, category: 'self-care', kind: 'workout' },
      { index: 3, category: 'self-care', kind: 'task' },
      { index: 4, category: 'self-care', kind: 'study' },
      { index: 5, category: 'work', kind: 'errand' },
    ];
    const { ai, parseTasks } = fakeAi({ ok: true, value: items });
    const out = await createAiEnhancer(ai)(input);
    expect(out.map(c => [c.category, c.kind])).toEqual([
      ['work', 'application'], // default -> model category
      ['misc', 'email'], // model says misc -> unchanged
      ['fitness', 'workout'], // keyword category kept
      ['work', 'task'], // stated kept
      ['self-development', 'study'], // history kept
      ['misc', 'errand'], // no source info -> unchanged
    ]);
    expect(parseTasks).toHaveBeenCalledTimes(1);
  });

  it('never changes title, duration, priority, count, dates or flags', async () => {
    const input: IntakeCandidate = {
      ...candidate('Dentist', 'misc', 'default'),
      durationMin: 55,
      priority: 1,
      count: 3,
      fixedStart: '2025-07-07T14:00:00.000Z',
      onDay: '2025-07-07',
      dueAt: '2025-07-08T00:00:00.000Z',
      scheduleNotes: ['note'],
      lowConfidence: true,
    };
    const { ai } = fakeAi({ ok: true, value: [{ index: 0, category: 'self-care', kind: 'errand' }] });
    const [out] = await createAiEnhancer(ai)([input]);
    expect(out).toEqual({ ...input, category: 'self-care', kind: 'errand' });
  });

  it('sends only the titles, at most 40', async () => {
    const input = Array.from({ length: 45 }, (_, i) => candidate(`Task ${i}`, 'misc', 'default'));
    const value = Array.from({ length: 40 }, (_, i): ParseTasksItem => ({ index: i, category: 'work', kind: 'task' }));
    const { ai, parseTasks } = fakeAi({ ok: true, value });
    const out = await createAiEnhancer(ai)(input);
    expect(parseTasks).toHaveBeenCalledWith(input.slice(0, 40).map(c => c.text));
    expect(parseTasks.mock.calls[0]).toHaveLength(1);
    // The 5 beyond the limit stay as parsed.
    expect(out).toHaveLength(45);
    expect(out[44]).toEqual(input[44]);
    expect(out[0]!.kind).toBe('task');
  });

  it('does not call the service for an empty list or when AI is not ready', async () => {
    const a = fakeAi({ ok: true, value: [] });
    expect(await createAiEnhancer(a.ai)([])).toEqual([]);
    expect(a.parseTasks).not.toHaveBeenCalled();
    for (const availability of ['disabled', 'not-configured'] as const) {
      const b = fakeAi({ ok: true, value: [{ index: 0, category: 'work', kind: 'task' }] }, availability);
      const input = [candidate('x', 'misc', 'default')];
      expect(await createAiEnhancer(b.ai)(input)).toBe(input);
      expect(b.parseTasks).not.toHaveBeenCalled();
    }
  });

  it('returns the candidates unchanged on failure, a count mismatch, or a throw', async () => {
    const input = [candidate('x', 'misc', 'default'), candidate('y', 'misc', 'default')];
    const failed = fakeAi({ ok: false, reason: 'timeout' });
    expect(await createAiEnhancer(failed.ai)(input)).toBe(input);
    const short = fakeAi({ ok: true, value: [{ index: 0, category: 'work', kind: 'task' }] });
    expect(await createAiEnhancer(short.ai)(input)).toBe(input);
    const throwing: AiPort = {
      availability: async () => 'ready',
      parseTasks: async () => {
        throw new Error('boom');
      },
      applicationHelp: async () => ({ ok: false, reason: 'rejected' }),
    };
    expect(await createAiEnhancer(throwing)(input)).toBe(input);
  });
});
