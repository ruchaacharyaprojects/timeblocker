import { FetchHttpTransport, HttpTimeoutError } from './httpTransport';

/** A fetch that answers after `delayMs` unless its signal aborts first. */
function delayedFetch(delayMs: number, status = 200, text = 'ok') {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const impl = ((url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => resolve({ status, text: async () => text }), delayMs);
      init.signal?.addEventListener('abort', () => {
        clearTimeout(timer);
        reject(Object.assign(new Error('Aborted'), { name: 'AbortError' }));
      });
    });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

describe('FetchHttpTransport', () => {
  it('passes method, headers, and body to fetch and returns status and text', async () => {
    const { impl, calls } = delayedFetch(0, 201, '{"id":"x"}');
    const transport = new FetchHttpTransport(impl);
    const res = await transport.request(
      'POST',
      'https://www.googleapis.com/calendar/v3/calendars/primary/events',
      { 'Content-Type': 'application/json' },
      '{"a":1}',
      { timeoutMs: 1000 },
    );
    expect(res).toEqual({ status: 201, body: '{"id":"x"}' });
    expect(calls[0]!.init).toMatchObject({
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"a":1}',
    });
    expect(calls[0]!.init.signal).toBeDefined();
  });

  it('sends no body when none is given and returns non-2xx responses as-is', async () => {
    const { impl, calls } = delayedFetch(0, 404, '');
    const res = await new FetchHttpTransport(impl).request('GET', 'https://www.googleapis.com/x', {}, undefined, {
      timeoutMs: 1000,
    });
    expect(res).toEqual({ status: 404, body: '' });
    expect('body' in calls[0]!.init).toBe(false);
  });

  it('aborts the request after timeoutMs and throws HttpTimeoutError', async () => {
    const { impl, calls } = delayedFetch(1000);
    const pending = new FetchHttpTransport(impl).request('GET', 'https://www.googleapis.com/x', {}, undefined, {
      timeoutMs: 20,
    });
    await expect(pending).rejects.toBeInstanceOf(HttpTimeoutError);
    expect(calls[0]!.init.signal?.aborted).toBe(true);
  });

  it('rethrows network errors unchanged', async () => {
    const failing = (async () => {
      throw new TypeError('Network request failed');
    }) as unknown as typeof fetch;
    await expect(
      new FetchHttpTransport(failing).request('GET', 'https://www.googleapis.com/x', {}, undefined, { timeoutMs: 1000 }),
    ).rejects.toThrow('Network request failed');
  });
});
