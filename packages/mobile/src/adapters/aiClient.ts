/**
 * `AiClient`: the phone's client for the owner's private AI service (D28,
 * D30, R33-R35).
 *
 * - Checks `aiEnabled` and the build config BEFORE any network, so a switched
 *   off or unconfigured assistant makes no request and reads no token.
 * - Sends `Authorization: Bearer <Google id token>` over HTTPS to the
 *   configured address only (the host is validated by `isAiConfigured`).
 * - 6 s timeout for `parseTasks`, 25 s for `applicationHelp`.
 * - Every reply is validated with the contract validators; invalid replies
 *   are `invalid-reply`.
 * - Never throws for expected failures and never logs request or response
 *   bodies, titles, or tokens.
 */
import {
  AI_MAX_TITLES,
  AI_MAX_TITLE_CHARS,
  clampApplicationHelpRequest,
  isApplicationHelpMode,
  validateApplicationHelpResponse,
  validateParseTasksResponse,
  type AiAvailability,
  type AiFailureReason,
  type AiPort,
  type AiResult,
  type ApplicationHelpRequest,
  type ApplicationHelpResponse,
  type HttpTransport,
  type ParseTasksItem,
} from '@timeblocker/app-core';
import { AI_API_BASE_URL, isAiConfigured } from '../config';
import { FetchHttpTransport, HttpTimeoutError } from './httpTransport';

/** Timeout for the list-reading call (R33.3, R35.4). */
export const AI_PARSE_TIMEOUT_MS = 6000;
/** Timeout for the Application helper (R35.4). */
export const AI_HELP_TIMEOUT_MS = 25000;

export interface AiClientOptions {
  /** Reads the `aiEnabled` setting. */
  isEnabled: () => Promise<boolean>;
  /** A fresh Google id token, or `undefined` when none can be obtained. */
  getIdToken: () => Promise<string | undefined>;
  /** Service address; defaults to `AI_API_BASE_URL`. */
  baseUrl?: string;
  /** Raw HTTP; defaults to `fetch`-based transport. */
  transport?: HttpTransport;
}

const fail = <T>(reason: AiFailureReason): AiResult<T> => ({ ok: false, reason });

/** Map an HTTP status of a failed call to a reason (D28 errors). */
export function reasonForStatus(status: number): AiFailureReason {
  if (status === 401) return 'no-token';
  if (status === 403) return 'forbidden';
  if (status === 429) return 'throttled';
  if (status === 504 || status === 408) return 'timeout';
  if (status >= 500) return 'server';
  return 'rejected';
}

export class AiClient implements AiPort {
  private readonly isEnabled: () => Promise<boolean>;
  private readonly getIdToken: () => Promise<string | undefined>;
  private readonly baseUrl: string;
  private readonly transport: HttpTransport;

  constructor(options: AiClientOptions) {
    this.isEnabled = options.isEnabled;
    this.getIdToken = options.getIdToken;
    this.baseUrl = (options.baseUrl ?? AI_API_BASE_URL).trim().replace(/\/+$/, '');
    this.transport = options.transport ?? new FetchHttpTransport();
  }

  async availability(): Promise<AiAvailability> {
    if (!isAiConfigured(this.baseUrl)) return 'not-configured';
    try {
      return (await this.isEnabled()) ? 'ready' : 'disabled';
    } catch {
      return 'disabled';
    }
  }

  async parseTasks(titles: readonly string[]): Promise<AiResult<ParseTasksItem[]>> {
    try {
      const gate = await this.gate();
      if (gate) return fail(gate);
      const clean = titles
        .map(t => (typeof t === 'string' ? t.trim().slice(0, AI_MAX_TITLE_CHARS) : ''))
        .slice(0, AI_MAX_TITLES);
      if (clean.length === 0 || clean.length !== titles.length || clean.some(t => t.length === 0)) {
        return fail('rejected');
      }
      const data = await this.post('/ai/parse-tasks', { titles: clean }, AI_PARSE_TIMEOUT_MS);
      if (!data.ok) return fail(data.reason);
      const items = validateParseTasksResponse(data.value, clean.length);
      return items ? { ok: true, value: items } : fail('invalid-reply');
    } catch {
      return fail('server');
    }
  }

  async applicationHelp(request: ApplicationHelpRequest): Promise<AiResult<ApplicationHelpResponse>> {
    try {
      const gate = await this.gate();
      if (gate) return fail(gate);
      if (!request || !isApplicationHelpMode(request.mode)) return fail('rejected');
      const body = clampApplicationHelpRequest(request);
      const data = await this.post('/ai/application-help', body, AI_HELP_TIMEOUT_MS);
      if (!data.ok) return fail(data.reason);
      const value = validateApplicationHelpResponse(body.mode, data.value);
      return value ? { ok: true, value } : fail('invalid-reply');
    } catch {
      return fail('server');
    }
  }

  /** `disabled` / `not-configured` before any token or network use. */
  private async gate(): Promise<AiFailureReason | undefined> {
    if (!isAiConfigured(this.baseUrl)) return 'not-configured';
    let enabled = false;
    try {
      enabled = await this.isEnabled();
    } catch {
      enabled = false;
    }
    return enabled ? undefined : 'disabled';
  }

  private async post(
    path: string,
    body: unknown,
    timeoutMs: number,
  ): Promise<{ ok: true; value: unknown } | { ok: false; reason: AiFailureReason }> {
    let token: string | undefined;
    try {
      token = await this.getIdToken();
    } catch {
      token = undefined;
    }
    if (!token) return { ok: false, reason: 'no-token' };
    let status: number;
    let text: string;
    try {
      const response = await this.transport.request(
        'POST',
        `${this.baseUrl}${path}`,
        { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: `Bearer ${token}` },
        JSON.stringify(body),
        { timeoutMs },
      );
      status = response.status;
      text = response.body;
    } catch (e) {
      return { ok: false, reason: e instanceof HttpTimeoutError ? 'timeout' : 'offline' };
    }
    if (status < 200 || status >= 300) return { ok: false, reason: reasonForStatus(status) };
    try {
      return { ok: true, value: JSON.parse(text) as unknown };
    } catch {
      return { ok: false, reason: 'invalid-reply' };
    }
  }
}
