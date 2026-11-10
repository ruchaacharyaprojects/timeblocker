/**
 * Test-only in-memory fakes for the injected ports. Not part of the public
 * surface. They let the OAuth and Calendar clients be exercised end to end
 * without a network or AWS.
 */

import type { HttpClient, TokenStore } from "./oauth.js";
import type { SecretsManagerPort, TokenTablePort } from "./secrets.js";
import type { CalendarHttpClient } from "./calendar.js";
import type { OAuthTokens } from "./types.js";

/** In-memory token store. */
export class InMemoryTokenStore implements TokenStore {
  current: OAuthTokens | null;
  saves = 0;

  constructor(initial: OAuthTokens | null = null) {
    this.current = initial;
  }

  async load(): Promise<OAuthTokens | null> {
    return this.current;
  }

  async save(tokens: OAuthTokens): Promise<void> {
    this.current = tokens;
    this.saves += 1;
  }
}

/** In-memory Secrets Manager. */
export class InMemorySecretsManager implements SecretsManagerPort {
  private readonly values = new Map<string, string>();

  async getSecretString(secretId: string): Promise<string | null> {
    return this.values.get(secretId) ?? null;
  }

  async putSecretString(secretId: string, value: string): Promise<void> {
    this.values.set(secretId, value);
  }
}

/** In-memory DynamoDB settings-table token port. */
export class InMemoryTokenTable implements TokenTablePort {
  private readonly values = new Map<string, string>();

  async getTokenItem(settingKey: string): Promise<string | null> {
    return this.values.get(settingKey) ?? null;
  }

  async putTokenItem(settingKey: string, value: string): Promise<void> {
    this.values.set(settingKey, value);
  }
}

/** Scripted form-post HTTP client for the OAuth token endpoint. */
export class FakeHttpClient implements HttpClient {
  calls: Array<{ url: string; form: Record<string, string> }> = [];

  constructor(
    private readonly responder: (
      url: string,
      form: Record<string, string>,
    ) => { status: number; body: unknown },
  ) {}

  async postForm(
    url: string,
    form: Record<string, string>,
  ): Promise<{ status: number; body: unknown }> {
    this.calls.push({ url, form });
    return this.responder(url, form);
  }
}

/** Recording Calendar HTTP client with scripted responses. */
export class FakeCalendarHttp implements CalendarHttpClient {
  getCalls: Array<{ url: string; token: string }> = [];
  postCalls: Array<{ url: string; token: string; body: unknown }> = [];
  putCalls: Array<{ url: string; token: string; body: unknown }> = [];
  deleteCalls: Array<{ url: string; token: string }> = [];

  constructor(
    private readonly handlers: {
      get?: (url: string) => { status: number; body: unknown };
      post?: (url: string, body: unknown) => { status: number; body: unknown };
      put?: (url: string, body: unknown) => { status: number; body: unknown };
      delete?: (url: string) => { status: number; body: unknown };
    } = {},
  ) {}

  async get(url: string, accessToken: string) {
    this.getCalls.push({ url, token: accessToken });
    return this.handlers.get?.(url) ?? { status: 200, body: { items: [] } };
  }

  async post(url: string, accessToken: string, body: unknown) {
    this.postCalls.push({ url, token: accessToken, body });
    return this.handlers.post?.(url, body) ?? { status: 200, body: { id: "new-id" } };
  }

  async put(url: string, accessToken: string, body: unknown) {
    this.putCalls.push({ url, token: accessToken, body });
    return this.handlers.put?.(url, body) ?? { status: 200, body: { id: "put-id" } };
  }
  async delete(url: string, accessToken: string) {
    this.deleteCalls.push({ url, token: accessToken });
    return this.handlers.delete?.(url) ?? { status: 204, body: null };
  }
}
