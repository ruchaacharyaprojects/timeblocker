# @timeblocker/calendar-integration

Google Calendar + OAuth integration for TimeBlocker. OAuth with Calendar
scopes, token storage in **AWS Secrets Manager**, reading the week's events,
and writing solo blocks with a 🧱 title prefix, per-category colors, and
suppressed reminders (no default pop-ups, no email reminders).

Request building and response parsing are **pure and unit-tested**. The
networked parts (Google token endpoint, Calendar REST API) and AWS Secrets
Manager are reached through small injected ports, so the whole module is
testable without a network or AWS.

## Public API

```ts
// OAuth (R4.1) — Calendar scope, offline access, token refresh.
new GoogleOAuthClient(config, http, tokenStore, now?)
  .authUrl(state?)            // consent URL for the Calendar scope
  .exchangeCode(code)         // auth code -> tokens, persisted
  .refresh(existing)          // refresh access token, persisted
  .getValidAccessToken()      // valid token, refreshing if needed

// Token storage in Secrets Manager (design.md).
new SecretsManagerTokenStore(secretsManagerPort, secretId)

// Calendar read/write.
new GoogleCalendarClient(accessTokenProvider, http)
  .readWeek(week)             // normalized CalendarEvent[] for the week (R4.1)
  .writeBlock(soloBlock)      // create/update one solo block (R4.1, R4.2)
  .writeBlocks(soloBlocks)    // write several, order preserved

// Pure helpers.
buildEventRequest(block)      // 🧱 prefix + category color + no reminders
toBusyEvents(events)          // -> scheduling-engine BusyEvent[]
```

## Requirements covered

| Rule | Behavior                                                             |
| ---- | ------------------------------------------------------------------- |
| R4.1 | OAuth Calendar scope; read the week; solo events with 🧱 prefix and a distinct color per category |
| R4.2 | Default pop-up reminders disabled; no email reminders added          |

### Category colors (Google `colorId`, R4.1)

| Category          | Color id | Google name |
| ----------------- | -------- | ----------- |
| fitness           | 4        | Flamingo    |
| self-care         | 1        | Lavender    |
| work              | 9        | Blueberry   |
| self-development  | 10       | Basil       |
| misc              | 8        | Graphite    |

## Ports

The module depends on three small interfaces instead of concrete SDKs:

- `HttpClient` / `CalendarHttpClient` — thin wrappers over `fetch` in
  production.
- `SecretsManagerPort` — a thin adapter over
  `@aws-sdk/client-secrets-manager` (wired in the CDK Lambda layer, task 3).

## Commands

```bash
npm install      # once (links @timeblocker/scheduling-engine from ../)
npm test         # run the unit test suite (vitest)
npm run build    # compile to dist/
npm run typecheck
```
