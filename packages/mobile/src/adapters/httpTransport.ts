/**
 * `HttpTransport` over `fetch` + `AbortController`.
 *
 * Raw transport only: app-core always wraps it in `GoogleOnlyHttp`, which
 * refuses non-Google destinations before any I/O (R12.3). Each request is
 * aborted after `timeoutMs`, surfacing as {@link HttpTimeoutError}. Headers
 * and bodies are never logged.
 */
import type { HttpMethod, HttpResponse, HttpTransport } from '@timeblocker/app-core';

export class HttpTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`HTTP request timed out after ${timeoutMs} ms`);
    this.name = 'HttpTimeoutError';
  }
}

export class FetchHttpTransport implements HttpTransport {
  constructor(private readonly fetchImpl: typeof fetch = (...args) => fetch(...args)) {}

  async request(
    method: HttpMethod,
    url: string,
    headers: Readonly<Record<string, string>>,
    body: string | undefined,
    options: { timeoutMs: number },
  ): Promise<HttpResponse> {
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, options.timeoutMs);
    try {
      const init: RequestInit = { method, headers: { ...headers }, signal: controller.signal };
      if (body !== undefined) init.body = body;
      const response = await this.fetchImpl(url, init);
      const text = await response.text();
      return { status: response.status, body: text ?? '' };
    } catch (e) {
      if (timedOut) throw new HttpTimeoutError(options.timeoutMs);
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }
}
