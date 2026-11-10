import { AI_HELP_TIMEOUT_MS, AI_PARSE_TIMEOUT_MS, AiClient, reasonForStatus } from './aiClient';
import { FetchHttpTransport } from './httpTransport';
import { AI_HOST_SUFFIX } from '../config';

const BASE = `https://abc123xyz${AI_HOST_SUFFIX}`;
const TOKEN = 'id.token.value';

interface FetchCall {
  url: string;
  init: RequestInit;
}

/** A fetch mock that replies with `status` and `body` (object → JSON, string → raw). */
function mockFetch(status: number, body: unknown) {
  const calls: FetchCall[] = [];
  const impl = jest.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return { status, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) };
  }) as unknown as typeof fetch;
  return { impl, calls };
}

function makeClient(
  fetchImpl: typeof fetch,
  overrides: { enabled?: boolean; token?: string | undefined; baseUrl?: string; tokenFn?: () => Promise<string | undefined> } = {},
) {
  const enabled = overrides.enabled ?? true;
  const getIdToken = overrides.tokenFn ?? jest.fn(async () => ('token' in overrides ? overrides.token : TOKEN));
  const client = new AiClient({
    isEnabled: async () => enabled,
    getIdToken,
    baseUrl: overrides.baseUrl ?? BASE,
    transport: new FetchHttpTransport(fetchImpl),
  });
  return { client, getIdToken: getIdToken as jest.Mock };
}

const parseReply = (n: number) => ({
  items: Array.from({ length: n }, (_, i) => ({ index: i, category: 'work', kind: 'task' })),
});

afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

describe('AiClient.parseTasks', () => {
  it('posts the titles with the Bearer id token and returns validated items', async () => {
    const { impl, calls } = mockFetch(200, {
      items: [
        { index: 0, category: 'fitness', kind: 'workout' },
        { index: 1, category: 'misc', kind: 'errand' },
      ],
    });
    const { client } = makeClient(impl);
    const result = await client.parseTasks(['  Go run ', 'Buy milk']);
    expect(result).toEqual({
      ok: true,
      value: [
        { index: 0, category: 'fitness', kind: 'workout' },
        { index: 1, category: 'misc', kind: 'errand' },
      ],
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(`${BASE}/ai/parse-tasks`);
    expect(calls[0]!.init.method).toBe('POST');
    expect(calls[0]!.init.headers).toMatchObject({
      Authorization: `Bearer ${TOKEN}`,
      'Content-Type': 'application/json',
    });
    // Only the (trimmed) titles are sent.
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({ titles: ['Go run', 'Buy milk'] });
  });

  it('tolerates a trailing slash on the base URL', async () => {
    const { impl, calls } = mockFetch(200, parseReply(1));
    const { client } = makeClient(impl, { baseUrl: `${BASE}/` });
    await client.parseTasks(['a']);
    expect(calls[0]!.url).toBe(`${BASE}/ai/parse-tasks`);
  });

  it('cuts titles to 200 characters', async () => {
    const { impl, calls } = mockFetch(200, parseReply(1));
    await makeClient(impl).client.parseTasks(['x'.repeat(300)]);
    expect(JSON.parse(calls[0]!.init.body as string).titles[0]).toHaveLength(200);
  });

  it('rejects an empty list, a blank title, or more than 40 titles without a network call', async () => {
    const { impl } = mockFetch(200, parseReply(1));
    const { client } = makeClient(impl);
    expect(await client.parseTasks([])).toEqual({ ok: false, reason: 'rejected' });
    expect(await client.parseTasks(['a', '  '])).toEqual({ ok: false, reason: 'rejected' });
    expect(await client.parseTasks(Array(41).fill('a'))).toEqual({ ok: false, reason: 'rejected' });
    expect(impl).not.toHaveBeenCalled();
  });

  it('uses a 6 s timeout', async () => {
    const seen: number[] = [];
    const client = new AiClient({
      isEnabled: async () => true,
      getIdToken: async () => TOKEN,
      baseUrl: BASE,
      transport: {
        request: async (_m, _u, _h, _b, o) => {
          seen.push(o.timeoutMs);
          return { status: 200, body: JSON.stringify(parseReply(1)) };
        },
      },
    });
    await client.parseTasks(['a']);
    expect(seen).toEqual([AI_PARSE_TIMEOUT_MS]);
    expect(AI_PARSE_TIMEOUT_MS).toBe(6000);
    expect(AI_HELP_TIMEOUT_MS).toBe(25000);
  });

  describe('short circuits make no fetch and read no token', () => {
    it('disabled', async () => {
      const { impl } = mockFetch(200, parseReply(1));
      const { client, getIdToken } = makeClient(impl, { enabled: false });
      expect(await client.parseTasks(['a'])).toEqual({ ok: false, reason: 'disabled' });
      expect(impl).not.toHaveBeenCalled();
      expect(getIdToken).not.toHaveBeenCalled();
      expect(await client.availability()).toBe('disabled');
    });

    it.each(['', '   ', 'http://abc123xyz' + AI_HOST_SUFFIX, 'https://evil.example.com', `https://abc123xyz${AI_HOST_SUFFIX}.evil.example`, `https://abc123xyz${AI_HOST_SUFFIX.replace('ca-central-1', 'us-east-1')}`])(
      'not configured: %p',
      async baseUrl => {
        const { impl } = mockFetch(200, parseReply(1));
        const { client, getIdToken } = makeClient(impl, { baseUrl });
        expect(await client.parseTasks(['a'])).toEqual({ ok: false, reason: 'not-configured' });
        expect(await client.applicationHelp({ mode: 'study' })).toEqual({ ok: false, reason: 'not-configured' });
        expect(await client.availability()).toBe('not-configured');
        expect(impl).not.toHaveBeenCalled();
        expect(getIdToken).not.toHaveBeenCalled();
      },
    );

    it('an empty address is not configured', async () => {
      const { impl } = mockFetch(200, parseReply(1));
      const client = new AiClient({
        isEnabled: async () => true,
        getIdToken: async () => TOKEN,
        baseUrl: '',
        transport: new FetchHttpTransport(impl),
      });
      expect(await client.parseTasks(['a'])).toEqual({ ok: false, reason: 'not-configured' });
      expect(impl).not.toHaveBeenCalled();
    });

    it('a failing settings read counts as disabled', async () => {
      const { impl } = mockFetch(200, parseReply(1));
      const client = new AiClient({
        isEnabled: async () => {
          throw new Error('disk');
        },
        getIdToken: async () => TOKEN,
        baseUrl: BASE,
        transport: new FetchHttpTransport(impl),
      });
      expect(await client.parseTasks(['a'])).toEqual({ ok: false, reason: 'disabled' });
      expect(impl).not.toHaveBeenCalled();
    });
  });

  describe('failure reasons', () => {
    it('no id token -> no-token, without a fetch', async () => {
      const { impl } = mockFetch(200, parseReply(1));
      const { client } = makeClient(impl, { token: undefined });
      expect(await client.parseTasks(['a'])).toEqual({ ok: false, reason: 'no-token' });
      expect(impl).not.toHaveBeenCalled();
    });

    it('a throwing token provider -> no-token', async () => {
      const { impl } = mockFetch(200, parseReply(1));
      const { client } = makeClient(impl, {
        tokenFn: async () => {
          throw new Error('x');
        },
      });
      expect(await client.parseTasks(['a'])).toEqual({ ok: false, reason: 'no-token' });
    });

    it.each([
      [400, 'rejected'],
      [401, 'no-token'],
      [403, 'forbidden'],
      [404, 'rejected'],
      [429, 'throttled'],
      [500, 'server'],
      [502, 'server'],
      [503, 'server'],
      [504, 'timeout'],
    ])('HTTP %i -> %s', async (status, reason) => {
      const { impl } = mockFetch(status, { error: 'x' });
      expect(await makeClient(impl).client.parseTasks(['a'])).toEqual({ ok: false, reason });
      expect(reasonForStatus(status as number)).toBe(reason);
    });

    it('a network error -> offline', async () => {
      const impl = jest.fn(async () => {
        throw new TypeError('Network request failed');
      }) as unknown as typeof fetch;
      expect(await makeClient(impl).client.parseTasks(['a'])).toEqual({ ok: false, reason: 'offline' });
    });

    it('no reply within 6 s -> timeout (fake timers)', async () => {
      jest.useFakeTimers();
      const impl = jest.fn(
        (_url: string, init: RequestInit) =>
          new Promise((_resolve, reject) => {
            init.signal?.addEventListener('abort', () =>
              reject(Object.assign(new Error('Aborted'), { name: 'AbortError' })),
            );
          }),
      ) as unknown as typeof fetch;
      const pending = makeClient(impl).client.parseTasks(['a']);
      await jest.advanceTimersByTimeAsync(AI_PARSE_TIMEOUT_MS - 1);
      let settled = false;
      void pending.then(() => (settled = true));
      await jest.advanceTimersByTimeAsync(0);
      expect(settled).toBe(false);
      await jest.advanceTimersByTimeAsync(1);
      expect(await pending).toEqual({ ok: false, reason: 'timeout' });
    });

    it.each([
      ['non-JSON body', 'not json'],
      ['code-fenced JSON', '```json\n{"items":[]}\n```'],
      ['wrong item count', parseReply(2)],
      ['hallucinated category', { items: [{ index: 0, category: 'cooking', kind: 'task' }] }],
      ['hallucinated kind', { items: [{ index: 0, category: 'work', kind: 'meeting' }] }],
      ['wrong shape', { result: 'ok' }],
      ['null', 'null'],
      ['array', [{ index: 0, category: 'work', kind: 'task' }]],
    ])('a 200 with %s -> invalid-reply', async (_name, body) => {
      const { impl } = mockFetch(200, body);
      expect(await makeClient(impl).client.parseTasks(['a'])).toEqual({ ok: false, reason: 'invalid-reply' });
    });
  });

  it('never logs bodies, titles or tokens', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map(m =>
      jest.spyOn(console, m).mockImplementation(() => undefined),
    );
    const failing = jest.fn(async () => {
      throw new Error(`secret ${TOKEN}`);
    }) as unknown as typeof fetch;
    await makeClient(failing).client.parseTasks(['my private title']);
    const { impl } = mockFetch(200, parseReply(1));
    await makeClient(impl).client.parseTasks(['my private title']);
    await makeClient(mockFetch(500, 'oops').impl).client.parseTasks(['my private title']);
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });
});

describe('AiClient.applicationHelp', () => {
  it('posts the clamped request to /ai/application-help with a 25 s timeout and returns the validated reply', async () => {
    const reply = {
      points: [{ text: 'Led a team', quote: 'led a team of four' }],
      missing: [],
      draft: 'I led a team.',
    };
    const seen: Array<{ url: string; timeoutMs: number; body: string | undefined; auth: string | undefined }> = [];
    const client = new AiClient({
      isEnabled: async () => true,
      getIdToken: async () => TOKEN,
      baseUrl: BASE,
      transport: {
        request: async (_m, url, headers, body, o) => {
          seen.push({ url, timeoutMs: o.timeoutMs, body, auth: headers.Authorization });
          return { status: 200, body: JSON.stringify(reply) };
        },
      },
    });
    const result = await client.applicationHelp({
      mode: 'application',
      job: 'j'.repeat(7000),
      question: 'Why us?',
      background: 'I led a team of four.',
    });
    expect(result).toEqual({ ok: true, value: reply });
    expect(seen[0]!.url).toBe(`${BASE}/ai/application-help`);
    expect(seen[0]!.timeoutMs).toBe(25000);
    expect(seen[0]!.auth).toBe(`Bearer ${TOKEN}`);
    const sent = JSON.parse(seen[0]!.body!);
    expect(sent.job).toHaveLength(6000);
    expect(sent).toMatchObject({ mode: 'application', question: 'Why us?' });
  });

  it('validates the reply for the requested mode', async () => {
    const email = mockFetch(200, { subject: 'Hi', body: 'Hello there' });
    expect(await makeClient(email.impl).client.applicationHelp({ mode: 'email', intent: 'ask' })).toEqual({
      ok: true,
      value: { subject: 'Hi', body: 'Hello there' },
    });
    const study = mockFetch(200, { steps: ['a', 'b'] });
    expect(await makeClient(study.impl).client.applicationHelp({ mode: 'study' })).toEqual({
      ok: true,
      value: { steps: ['a', 'b'] },
    });
    // An email-shaped reply to a study request is invalid.
    const wrong = mockFetch(200, { subject: 'Hi', body: 'Hello' });
    expect(await makeClient(wrong.impl).client.applicationHelp({ mode: 'study' })).toEqual({
      ok: false,
      reason: 'invalid-reply',
    });
  });

  it('cuts an over-long draft to 120 words', async () => {
    const draft = Array.from({ length: 300 }, (_, i) => `w${i}`).join(' ');
    const { impl } = mockFetch(200, { points: [], missing: [], draft });
    const result = await makeClient(impl).client.applicationHelp({ mode: 'application' });
    expect(result.ok && 'draft' in result.value && result.value.draft.split(' ')).toHaveLength(120);
  });

  it('rejects an unknown mode without a network call; short-circuits when disabled', async () => {
    const { impl } = mockFetch(200, {});
    expect(await makeClient(impl).client.applicationHelp({ mode: 'poem' as never })).toEqual({
      ok: false,
      reason: 'rejected',
    });
    expect(await makeClient(impl, { enabled: false }).client.applicationHelp({ mode: 'study' })).toEqual({
      ok: false,
      reason: 'disabled',
    });
    expect(impl).not.toHaveBeenCalled();
  });

  it('times out after 25 s and maps HTTP failures', async () => {
    jest.useFakeTimers();
    const hang = jest.fn(
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () =>
            reject(Object.assign(new Error('Aborted'), { name: 'AbortError' })),
          );
        }),
    ) as unknown as typeof fetch;
    const pending = makeClient(hang).client.applicationHelp({ mode: 'study' });
    await jest.advanceTimersByTimeAsync(AI_HELP_TIMEOUT_MS);
    expect(await pending).toEqual({ ok: false, reason: 'timeout' });
    jest.useRealTimers();
    for (const [status, reason] of [
      [403, 'forbidden'],
      [429, 'throttled'],
      [502, 'server'],
    ] as const) {
      const { impl } = mockFetch(status, { error: 'x' });
      expect(await makeClient(impl).client.applicationHelp({ mode: 'study' })).toEqual({ ok: false, reason });
    }
  });
});

describe('AiClient.availability', () => {
  it('is ready only when enabled and configured', async () => {
    const { impl } = mockFetch(200, {});
    expect(await makeClient(impl).client.availability()).toBe('ready');
    expect(await makeClient(impl, { enabled: false }).client.availability()).toBe('disabled');
    expect(await makeClient(impl, { baseUrl: '' }).client.availability()).toBe('not-configured');
    expect(impl).not.toHaveBeenCalled();
  });
});
