# Implementation Plan

## Overview

Tasks 1-11 built the pure scheduling engine, Google Calendar integration, the (now retained but unused in v1) AWS serverless backend, and the backend-mode flows. Tasks 12 onward implement the v1 on-device personal mode from the design's "On-Device App (v1 Personal Mode)" section, in TypeScript:

1. Make additive changes to the existing packages.
2. Extract the pure infra orchestration into `@timeblocker/flows`.
3. Build the pure `@timeblocker/app-core` (ports, fakes, repositories, auth, notifications, planning, sync, actions, review, view models).
4. Scaffold the bare React Native app `@timeblocker/mobile` with its adapters, the Kotlin `TimeBlockerAlarms` module, screens, and the composition root.

**Verification constraint for tasks 12+:** the user's Mac has Node 22 and npm but no Java, Android SDK, or Android Studio. Every new task must be verifiable with Node-only tooling: `tsc --noEmit`, Vitest (`vitest run`), and Jest with `@react-native/jest-preset`. No task may require running Gradle, an emulator, or a device. Building and installing the APK is a manual user step documented in the README (task 25.3). The Kotlin task (23) is verified statically: files present, manifest entries present, and TypeScript adapter tests against a mocked native module.

## Tasks

- [x] 1. Build the pure scheduling engine package
  - Implement `weekBounds(date)` returning Sunday-Saturday bounds in America/Toronto.
  - Implement `freeWindows(week, busyEvents, constraints, now)` with schedulable-window generation and subtraction of fixed constraints and real events; drop gaps under 15 minutes.
  - Implement `place(items, freeWindows, mode)` with priority-first greedy placement for "earliest-fit" and "spread" modes.
  - Implement `reschedule(block, week, busy, constraints)` next-slot search returning a slot or "no-fit".
  - Keep the package pure with no network or I/O.
  - Write unit tests for every R3 constraint (work window, holidays, commute Tue/Thu/Fri, sleep, wake-up, dinner, scheduling windows, 15-min gap, one-workout-per-day, morning routine, wind-down, Friday night) plus "no fit".
  - _Requirements: R2.1, R2.2, R2.3, R3.1-R3.12, R6.2, R6.3, R8.1_

- [x] 2. Google OAuth and Calendar integration
  - Implement OAuth flow with Calendar scopes and token storage.
  - Read the week's events.
  - Write solo block events with 🧱 prefix and per-category colors.
  - Disable default pop-up reminders and add no email reminders on created events.
  - _Requirements: R4.1, R4.2_

- [x] 3. AWS infrastructure (CDK)
  - Define API Gateway + Lambdas for intake, planning, reschedule, and calendar sync.
  - Define DynamoDB tables for items, blocks, settings, and weekly review data.
  - Define EventBridge Scheduler for 15-minute reminders, Sunday planning nudge, and Saturday review.
  - Store Google OAuth tokens in the DynamoDB settings table (key `google-oauth-tokens`, encrypted at rest with the table's AWS-managed key); no Secrets Manager.
  - _Requirements: R2.1, R4.1, R5.1, R9.1_

- [x] 4. Planning API
  - Wire the scheduling engine to the calendar integration.
  - Return placed and unplaced items, including the shrink/drop/roll alert for unplaced items.
  - _Requirements: R2.1, R2.2, R2.3_

- [x] 5. Intake flow
  - Implement the pure intake parser for a pasted/typed to-do list: a JSON item array (or `{items:[...]}` object) or plain text lines (one item per line), defaulting missing duration/priority/category. No Bedrock or ML model.
  - Build the review screen to confirm/edit duration, priority, and category.
  - Gate scheduling behind explicit confirmation, then trigger planning.
  - _Requirements: R1.1, R1.2, R1.3_

- [x] 6. Custom reminders
  - Fire a custom notification 15 minutes before each block and before meetings with other people.
  - Add actionable buttons "I'm in", "Skip", "Move it".
  - _Requirements: R5.1, R5.2_

- [x] 7. Reschedule flow
  - Implement the "Will you miss this block?" prompt (Yes/No).
  - On Yes, move the block to the next valid slot in the same week and show Undo.
  - On no valid slot, start the "nothing fits" flow.
  - _Requirements: R6.1, R6.2, R6.3_

- [x] 8. Android usage metrics
  - Implement the UsageStatsManager permission flow.
  - Aggregate screen time and per-app usage on-device; send only summary signals.
  - Implement the user-editable distraction app list.
  - _Requirements: R7.1, R7.2, R7.3_

- [x] 9. Meeting-conflict detection
  - Watch for new meetings overlapping existing blocks and trigger the "Will you miss this?" prompt.
  - _Requirements: R6.1_

- [x] 10. Saturday review and Sunday planning nudge
  - Build the Saturday review screen: finished, partial, missed, screen time, distraction level, what moved and why, and the prompt to paste or type next week's to-do list (JSON or text lines).
  - Mark workouts that could not happen this week as missed (do not roll to next Sunday).
  - Wire the Sunday planning nudge.
  - _Requirements: R8.1, R9.1, R9.2, R9.3, R9.4_

- [x] 11. End-to-end tests and README
  - Add end-to-end tests across intake → plan → calendar → reminder → reschedule → review.
  - Write a README covering Google OAuth setup and Android permissions.
  - _Requirements: R1.1, R4.1, R7.1_

- [x] 12. Additive changes to existing packages
  - [x] 12.1 Add `options.notBefore` to `reschedule` in scheduling-engine
    - Extend `reschedule(block, week, busy, constraints, options?: { notBefore?: string })` so the search starts at `max(block.start, notBefore)`.
    - Existing calls without `options` behave exactly as before; all existing engine tests pass unchanged.
    - Add unit tests: a block already started is never moved into the past; `notBefore` past the end of the week returns `"no-fit"`.
    - Verify: `tsc --noEmit` and `vitest run` in `packages/scheduling-engine`.
    - _Requirements: R6.2, R13.4, R13.6_

  - [x] 12.2 Extend calendar-integration types, reads, and HTTP client
    - Add `CalendarEvent.isBlock` (true when the summary starts with `🧱`) and optional `GoogleEventRequest.id`.
    - `readWeek` follows `nextPageToken` until exhausted and drops events with `status: "cancelled"`.
    - Add `CalendarHttpClient.delete(url, token)` and a matching `delete` on the `testkit` fake.
    - Add unit tests for pagination, cancelled-event filtering, and `isBlock` parsing (including leading spaces).
    - Verify: `tsc --noEmit` and `vitest run` in `packages/calendar-integration`; existing tests unchanged.
    - _Requirements: R14.1, R14.2, R14.4_

  - [x] 12.3 Add `deleteBlock`, `getEvent`, and idempotent `upsertBlock` to `GoogleCalendarClient`
    - `deleteBlock(eventId)`: `404/410` count as success.
    - `getEvent(eventId)` returns `CalendarEvent | "deleted"` (`404/410` or `status: "cancelled"` → `"deleted"`).
    - `upsertBlock(block)`: POST with the client-chosen `id`; `409` → `PUT` to that id. Uses `buildEventRequest` (🧱 prefix, category color, `reminders: { useDefault: false, overrides: [] }`).
    - `writeBlock`/`writeBlocks` keep their existing behavior for infra.
    - Add unit tests with the testkit fake for each status-code branch.
    - Verify: `tsc --noEmit` and `vitest run` in `packages/calendar-integration`.
    - _Requirements: R4.1, R4.2, R14.7, R14.8, R14.9_

- [x] 13. Extract pure orchestration into `@timeblocker/flows`
  - [x] 13.1 Scaffold `packages/flows` and unify the block model
    - Create `package.json` (exact versions only: typescript 5.9.3, vitest 2.1.9, fast-check 4.10.2; `file:` deps on scheduling-engine, calendar-integration, usage-metrics), `tsconfig.json` (strict), `vitest.config.ts`, `src/index.ts`.
    - Create `src/block.ts` with the single `BlockStatus` union (`scheduled`, `in-progress`, `done`, `partial`, `skipped`, `missed`, `rolled`, legacy `moved`) and one `PersistedBlock` type replacing the three infra copies.
    - Verify: `npm install`, `tsc --noEmit`, `vitest run` in `packages/flows`.
    - _Requirements: R12.6, R13.4_

  - [x] 13.2 Move intake, plan, reschedule, prompt, detect, and review modules into flows
    - Move `intake.ts` (`parseItemList`, `extractItems`, `confirmItems`), `plan.ts`, `reschedule.ts`, `prompt.ts`, `detect.ts`, `review.ts` from `packages/infra/lambda/*` into `flows/src`, using `PersistedBlock` from `block.ts`.
    - Split out pure `computePlan({ week, items, busy, settings, now })`; `runPlanning` becomes a thin wrapper with unchanged behavior.
    - Split out pure `computeReschedule({ block, week, busy, constraints, now })` returning `{ kind: "moved", slot } | { kind: "nothing-fits", alert }`, passing `notBefore = max(block.start, now)`; `runReschedule` and `applyUndo` wrap it unchanged.
    - Drop the `globalThis.nativeModuleProxy` lookup from `prompt.ts`.
    - `findConflicts` additionally excludes events with `isBlock === true`.
    - `buildWeeklyReview` applies the design's review mapping (`in-progress` past end → finished; `skipped` and past-end `scheduled` → missed; `rolled`/`moved` → movedToNextWeek); fitness blocks never land in movedToNextWeek.
    - Change the review prompt copy constant to "Paste or type next week's to-do list".
    - Move the corresponding existing unit tests with the modules.
    - _Requirements: R1.1, R2.1, R2.3, R6.2, R6.3, R8.1, R9.1, R9.3, R9.4, R12.6, R14.4_

  - [x] 13.3 Replace infra lambda modules with re-export shims
    - Each moved `packages/infra/lambda/**/x.ts` becomes a one-line re-export of the flows module; add `"@timeblocker/flows": "file:../flows"` to infra's `package.json`.
    - Update only the infra tests that assert the old photo-based review copy.
    - Verify (extraction gate): `tsc --noEmit` and `vitest run` in `packages/infra` pass with no other test edits; Lambda handlers still compile.
    - _Requirements: R9.4, R12.6_

  - [x] 13.4 Implement `validateIntakeInput(raw)` in flows
    - Return `{ ok: true, candidates }` or `{ ok: false, reason }` with reasons `too-long` (> 20,000 chars), `empty` (empty or whitespace only), `malformed-json` (first non-space char `[` or `{` and `JSON.parse` fails), `no-items`, `too-many-items` (> 100).
    - Plain text: each non-blank line is one item; defaults duration 30, priority 3, category misc.
    - Add unit tests for each reason and boundary (0, 1, 100, 101 items; exactly 20,000 and 20,001 chars).
    - _Requirements: R1.1, R11.4, R11.5, R11.6_

  - [ ]* 13.5 Write property test for conflict detection
    - **Property 17: Conflict detection matches the overlap definition**
    - fast-check, ≥ 100 runs, tag `// Feature: timeblocker, Property 17: ...`; generators include touching boundaries and 🧱 events.
    - **Validates: Requirements R14.4**

- [x] 14. Checkpoint - Ensure all tests pass
  - Run `tsc --noEmit` and `vitest run` in scheduling-engine, calendar-integration, reminders, usage-metrics, flows, and infra. Ensure all tests pass, ask the user if questions arise.

- [x] 15. `@timeblocker/app-core` foundation: ports, fakes, repositories, and auth
  - [x] 15.1 Scaffold `packages/app-core` with ports and models
    - `package.json` with exact versions only (typescript 5.9.3, vitest 2.1.9, fast-check 4.10.2; `file:` deps on flows, scheduling-engine, calendar-integration, reminders, usage-metrics), strict `tsconfig.json`, `vitest.config.ts`.
    - Define ports: `KeyValueStore`, `TokenVault`, `AuthClient`, `HttpTransport`, `Notifier`, `UsageSource`, `BackgroundJobs`, `SystemSettings`, `Clock`, `IdGenerator` (with base32hex `calendarEventId()`), and the narrow `CalendarApi` (`readWeek`, `getEvent`, `upsertBlock`, `deleteBlock`).
    - Define `DeviceBlock`, `PendingWrite`, `RegistryEntry`, `UndoToken`, `SyncState`, `AuthState`, `PermissionState`, and `SessionEnded`.
    - Add structural tests: app-core sources import no `react-native`, `@aws-sdk/*`, `aws-cdk-lib`, or `@timeblocker/infra`; `package.json` files in flows and app-core contain only exact versions.
    - _Requirements: R12.6, R12.8, R12.10_

  - [x] 15.2 Implement in-memory fakes in `app-core/src/testkit.ts`
    - Memory `KeyValueStore`, fake `TokenVault`, scriptable `AuthClient`, fake `HttpTransport`, fake calendar with a call log, failure injection, and lost-response simulation, fake `Notifier` (pending set, shown list, permission and exact-alarm toggles), fake `Clock`, deterministic `IdGenerator`, fake `BackgroundJobs`, fake `UsageSource`, fake `SystemSettings`.
    - _Requirements: R12.6_

  - [x] 15.3 Implement repositories over `KeyValueStore`
    - Repositories for items, intake draft, blocks, settings, reviews, outbox (coalesced per block), calendar cache, notification registry, open prompts, undo, sync state, auth state, permission state, using the design's key schema and `schemaVersion: 1`.
    - Atomic multi-document writes via `setMany`; unparseable documents or unknown `schemaVersion` return defaults.
    - Settings default to exactly one planning mode.
    - Add unit tests for defaults on corruption and outbox coalescing.
    - _Requirements: R1.3, R11.11, R12.7, R14.10_

  - [ ]* 15.4 Write property test for local persistence
    - **Property 8: Local persistence round trip**
    - **Validates: Requirements R11.11, R12.7**

  - [x] 15.5 Implement `GoogleOnlyHttp` and the device `CalendarApi`
    - `GoogleOnlyHttp` throws before any I/O unless the URL is `https:` with host exactly `www.googleapis.com`, `oauth2.googleapis.com`, or `accounts.google.com`.
    - Build a `CalendarHttpClient` on top of it and construct `GoogleCalendarClient` behind `CalendarApi`.
    - Add unit tests including lookalike hosts (`googleapis.com.evil.example`) and `http:` URLs.
    - _Requirements: R12.3, R12.8_

  - [ ]* 15.6 Write property test for token isolation
    - **Property 10: Tokens never leave the Keystore or go to non-Google hosts**
    - **Validates: Requirements R12.2, R12.3, R12.8, R12.9**

  - [x] 15.7 Implement `DeviceAccessTokenProvider`
    - Implements `AccessTokenProvider`: missing tokens → `SessionEnded("missing")`; refresh when `isExpired` (60 s skew), at most once per request, with a shared in-flight promise for concurrent callers.
    - Success saves rotated tokens to the vault; `invalid_grant` clears the vault and throws `SessionEnded`; a transport failure keeps the vault and throws `SessionEnded`.
    - A Calendar `401` triggers one forced refresh and retry; a second `401` → `SessionEnded("revoked")`.
    - Add unit tests for each branch.
    - _Requirements: R12.2, R12.4, R12.5_

  - [ ]* 15.8 Write property test for token refresh
    - **Property 11: Refresh exactly when needed, at most once per request**
    - **Validates: Requirements R12.4**

  - [x] 15.9 Implement `AuthService`
    - `signIn()` calls `AuthClient.authorize()` (PKCE, `access_type: offline`, `prompt: consent`), checks the granted scopes include `CALENDAR_SCOPE`, saves tokens to the vault only, sets auth state `signed-in`.
    - Cancel/error → "Sign-in didn't complete. Try again."; denied or missing scope → "TimeBlocker needs Calendar access to work."; nothing stored in either case.
    - When tokens are present after a transport-failure session end, `signIn()` first tries a silent refresh.
    - `signOut()` revokes and clears the vault; `onSessionEnded()` stops background sync, sets `session-ended`, and leaves all non-auth documents untouched.
    - Add unit tests for the cancel/error messages.
    - _Requirements: R11.2, R11.3, R12.1, R12.2, R12.5, R12.11, R14.12_

  - [ ]* 15.10 Write property test for sign-in scope gating
    - **Property 9: Sign-in requires the Calendar scope**
    - **Validates: Requirements R11.3, R12.1, R12.11**

  - [ ]* 15.11 Write property test for ended sessions
    - **Property 12: Ended sessions keep local data**
    - **Validates: Requirements R12.5, R14.12**

- [x] 16. app-core: `NotificationService`
  - [x] 16.1 Implement the pure desired-notification set
    - One block reminder per `scheduled` block with `start > now`: id `rem:block:<blockId>@<startMs>`, `fireAtMs = max(start − 15 min, now)`, actions exactly `REMINDER_ACTIONS` ("I'm in", "Skip", "Move it").
    - One meeting reminder per cached event with `withOthers && !isBlock && start > now` (id `rem:meeting:<eventId>@<startMs>`, no actions).
    - Weekly nudges: Saturday 18:00 review and Sunday 08:00 planning in America/Toronto.
    - Add unit tests for starts within 15 minutes and in the past.
    - _Requirements: R5.1, R5.2, R9.4, R13.1, R13.2, R13.3, R13.11_

  - [x] 16.2 Implement `reconcile()`
    - Diff desired vs `notifRegistry` and `Notifier.listPending()`: cancel undesired entries; schedule absent entries or `pending` entries whose `fireAtMs`/`exact` differ; leave `shown` entries alone; `showNow` and mark `shown` when `fireAtMs ≤ now`; prune entries whose start has passed; re-arm registry entries missing from the native pending set.
    - `exact` follows `Notifier.canScheduleExact()`.
    - _Requirements: R13.1, R13.2, R13.7, R13.10, R13.11, R14.7_

  - [x] 16.3 Implement permission, exact-alarm state, and indicators
    - `ensurePermissionOnce()`: on API ≥ 33 with `undetermined` and `notificationsRequested` false, set the flag, then request once; never request again.
    - Persist `exactAlarmsAvailable` and expose the "Reminder timing may vary" state; on a change to available, reconcile with `exact=true`.
    - `indicators(now)`: when permission is denied, blocks and qualifying meetings with `now < start ≤ now + 15 min` plus blocks with an entry in `openPrompts`.
    - _Requirements: R13.8, R13.9, R13.10_

  - [ ]* 16.4 Write property test for reconcile convergence
    - **Property 13: Notification reconcile converges to the desired set**
    - **Validates: Requirements R13.1, R13.2, R13.3, R13.7, R13.10, R13.11**

  - [ ]* 16.5 Write property test for reconcile idempotence
    - **Property 14: Reconcile is idempotent**
    - **Validates: Requirements R13.7**

  - [ ]* 16.6 Write property test for the permission request
    - **Property 15: Notification permission is requested at most once**
    - **Validates: Requirements R13.8**

  - [ ]* 16.7 Write property test for in-app indicators
    - **Property 16: In-app indicators when notifications are denied**
    - **Validates: Requirements R13.9**

- [x] 17. app-core: `SettingsService`, `IntakeService`, `PlanningService`
  - [x] 17.1 Implement `SettingsService`
    - Set planning mode (exactly one of `earliest-fit`/`spread`), add/remove holidays (YYYY-MM-DD validated), add/remove distraction apps via `addDistractionApp`/`removeDistractionApp`; persist each change immediately.
    - Add unit tests for invalid dates and duplicate entries.
    - _Requirements: R7.2, R11.11, R12.7_

  - [x] 17.2 Implement `IntakeService`
    - `validate(raw)` stores the exact text in `intakeDraft` and returns candidates or the typed rejection from `validateIntakeInput`.
    - `confirm(edits)` persists confirmed items via `confirmItems` and then calls planning; nothing is planned before confirm.
    - _Requirements: R1.1, R1.2, R1.3, R11.4, R11.5, R11.6_

  - [x] 17.3 Implement `PlanningService`
    - Optional foreground sync first; busy time = cached non-🧱 events ∪ local `scheduled`/`in-progress` blocks; call `computePlan`.
    - Persist new `DeviceBlock`s (status `scheduled`, pre-assigned `calendarEventId`) together with outbox upserts in one `setMany`; reconcile notifications; return placed/unplaced plus the nothing-fits alert.
    - Add unit tests for unplaced items and for blocks being persisted with outbox entries.
    - _Requirements: R2.1, R2.2, R2.3, R12.6, R13.1, R14.8_

  - [ ]* 17.4 Write property test for intake round trip
    - **Property 1: Intake round trip**
    - **Validates: Requirements R1.1, R1.3, R11.4, R11.5**

  - [ ]* 17.5 Write property test for intake rejection
    - **Property 2: Intake rejection preserves the input**
    - **Validates: Requirements R11.6**

- [x] 18. app-core: `SyncService` and `UsageRiskService`
  - [x] 18.1 Implement single-flight sync
    - In-memory promise guard so same-runtime callers join the in-flight sync; persisted lease in `syncState.lease` (`expiresAt = now + 2 min`) so a new process never starts a second sync while a valid lease exists.
    - _Requirements: R14.3_

  - [x] 18.2 Implement the outbox flush (writes before reads)
    - Flush `PendingWrite`s FIFO before any read: upsert via `upsertBlock` (client id, 409 → PUT) reading the block's current fields; delete via `deleteBlock` (404/410 ok); mark `calendarSynced` and drop entries on success.
    - `PUT` 404/410 on a synced block → treat as remote deletion. Network/timeout/5xx → keep entry, `attempts++`, set banner, skip the read. Other 4xx → keep entry, set banner, continue. `401` → handled by the token provider.
    - _Requirements: R14.8, R14.9, R14.10, R14.11_

  - [x] 18.3 Implement read, 🧱 reconciliation, and cache
    - `readWeek(weekBounds(now))`; for each synced local block without a pending write: moved → update start/end with `moveReason: "Moved in Google Calendar"`; missing → `getEvent`; deleted/cancelled → remove the block; found outside the week → update start/end and `weekId`.
    - Cache non-🧱 events in `calendarCache:<weekId>` with `syncedAt`.
    - _Requirements: R14.1, R14.2, R14.6, R14.7, R11.7_

  - [x] 18.4 Implement conflict prompts once per pair
    - Run `findConflicts`; for each block with meetings not in `promptedMeetingIds`, persist the pairs first, then show one `miss:<blockId>` prompt (Yes/No, body names the meeting) and add it to `openPrompts`.
    - _Requirements: R6.1, R13.5, R14.4, R14.5_

  - [x] 18.5 Implement sync completion, banner, session end, and foreground timeout
    - After a successful sync: run usage risk, reconcile notifications, set `lastSuccessAt`, clear the banner, release the lease. Banner is dismissible.
    - `SessionEnded` → `AuthService.onSessionEnded()`, keep local blocks, release the lease.
    - Foreground/pull syncs use a 14 s overall timeout so the spinner clears within 15 s.
    - Add unit tests for the 14 s timeout with a hanging transport and for banner set/clear.
    - _Requirements: R13.7, R14.2, R14.10, R14.12_

  - [x] 18.6 Implement `UsageRiskService`
    - For `scheduled` blocks starting in the next 30 minutes without `usagePrompted`, compute `missRiskSignal` from on-device `UsageSource` data and raise the same "Will you miss this block?" prompt when at risk; set `usagePrompted`. Raw usage never leaves the device.
    - Usage permission denied → no usage prompts, sync continues.
    - _Requirements: R6.1, R7.1, R7.3, R12.9_

  - [ ]* 18.7 Write property test for prompt-once
    - **Property 18: Each block-meeting pair prompts once**
    - **Validates: Requirements R13.5, R14.5**

  - [ ]* 18.8 Write property test for calendar-to-local reconciliation
    - **Property 19: Calendar-to-local reconciliation is correct and idempotent**
    - **Validates: Requirements R14.6, R14.7**

  - [ ]* 18.9 Write property test for outbox convergence
    - **Property 20: Outbox converges to one event per block, writes before reads**
    - Generators include lost write responses.
    - **Validates: Requirements R14.8, R14.11**

  - [ ]* 18.10 Write property test for failed syncs
    - **Property 21: Failed syncs keep local state and surface a banner**
    - **Validates: Requirements R14.10**

  - [ ]* 18.11 Write property test for block write markers
    - **Property 22: Every block write carries the TimeBlocker markers**
    - Generators include titles already starting with 🧱 or leading spaces.
    - **Validates: Requirements R4.1, R4.2, R14.9**

  - [ ]* 18.12 Write property test for single-flight sync
    - **Property 23: Syncs never overlap**
    - **Validates: Requirements R14.3**

- [x] 19. Checkpoint - Ensure all tests pass
  - Run `tsc --noEmit` and `vitest run` in flows and app-core. Ensure all tests pass, ask the user if questions arise.

- [x] 20. app-core: `BlockActionService`, `ReviewService`, `AppLifecycle`, and view models
  - [x] 20.1 Implement block actions
    - `imIn` → `in-progress`; `skip` → `skipped`; `answerPrompt(no)` → no change, prompt removed from `openPrompts`.
    - `moveIt` and `answerPrompt(yes)` use `computeReschedule` with busy = cache ∪ local blocks ∪ the original span; moved → new start/end, status `scheduled`, `movedFrom`/`moveReason`, one outbox upsert, reconcile. No fit → block unchanged and a `status` notification "Nothing fits this week" deep-linking to `timeblocker://nothing-fits/<id>`.
    - Uses only local data and the cache (no network needed); each action is one atomic `setMany`; best-effort outbox flush afterwards.
    - _Requirements: R6.2, R6.3, R11.8, R13.4, R13.6, R13.12, R13.13_

  - [x] 20.2 Implement Undo
    - A move from block detail or a "Yes" creates an `UndoToken` with `UNDO_WINDOW_MS = 10_000`; "Yes" also shows a status notification "Moved to …" with an Undo action.
    - `undo()` is valid only while `now < expiresAt` and the block is still at the moved-to slot; restores start/end/status, enqueues an upsert, reconciles reminders. Otherwise rejected with no change.
    - _Requirements: R6.2, R11.9_

  - [x] 20.3 Implement nothing-fits resolution
    - `resolveNothingFits(shrink | drop | roll)`: shrink to 75%, 50%, or custom ≥ 15 min and retry placement; drop removes the block and enqueues a delete; roll deletes this week's event, sets status `rolled` with "Didn't fit this week", and adds the confirmed item to `items:<nextWeekId>`.
    - Fitness items: roll is not offered; drop records `missed`.
    - Add unit tests for each outcome.
    - _Requirements: R2.3, R6.3, R8.1_

  - [x] 20.4 Implement `ReviewService`
    - Build the Saturday review with `buildWeeklyReview` from local blocks and `collectUsageSummary`; persist to `reviews:<weekId>`; mark un-happened workouts `missed`.
    - _Requirements: R8.1, R9.1, R9.2, R9.3, R9.4, R11.10, R12.6, R12.9_

  - [x] 20.5 Implement `AppLifecycle`
    - `onLaunch`: auth gate, `ensurePermissionOnce`, start background sync when signed in, foreground sync, reconcile.
    - `onForeground`: sync, refresh notification permission and exact-alarm state, re-arm exact within the same pass when newly available.
    - Add unit tests: sync is called on launch and foreground; background job starts and stops with auth.
    - _Requirements: R13.8, R13.10, R14.1, R14.3, R14.12_

  - [x] 20.6 Implement pure view models
    - `buildWeekView` (Toronto week range, category colors from `CATEGORY_COLOR_ID` hex map, distinct "Calendar" style for other events, indicators, banner, last synced), `buildBlockDetail`, `buildSettingsView` (mode, holidays, apps, permission statuses, "Reminder timing may vary"), `buildReviewView`.
    - _Requirements: R11.7, R11.8, R11.10, R11.11, R11.12, R13.9, R13.10, R14.10_

  - [ ]* 20.7 Write property test for the week view
    - **Property 3: Week view shows the Toronto week with distinct styling**
    - Generators include DST-transition weeks.
    - **Validates: Requirements R11.7**

  - [ ]* 20.8 Write property test for moves
    - **Property 4: Moves land in a valid slot or change nothing**
    - Generators include weeks with no free slot.
    - **Validates: Requirements R6.2, R6.3, R13.4, R13.6, R13.13**

  - [ ]* 20.9 Write property test for local actions without network
    - **Property 5: Local block actions need no network and apply the right status**
    - **Validates: Requirements R13.4, R13.12**

  - [ ]* 20.10 Write property test for Undo
    - **Property 6: Undo round trip**
    - **Validates: Requirements R11.9, R6.2**

  - [ ]* 20.11 Write property test for review classification
    - **Property 7: Review classification and no-roll workouts**
    - **Validates: Requirements R8.1, R9.1, R9.3, R11.10**

  - [ ]* 20.12 Write in-memory end-to-end loop test
    - intake → confirm → plan → flush → reminder registry → overlapping meeting → prompt → Yes → move → Undo → Saturday review, all on testkit fakes.
    - _Requirements: R1.3, R2.1, R13.1, R13.5, R13.6, R11.9, R9.1_

- [x] 21. Checkpoint - Ensure all tests pass
  - Run `tsc --noEmit` and `vitest run` in every package. Ensure all tests pass, ask the user if questions arise.

- [x] 22. `@timeblocker/mobile` scaffold and port adapters
  - [x] 22.1 Scaffold the bare React Native CLI project at `packages/mobile`
    - React Native 0.88.1 (New Architecture, Hermes), application id `com.timeblocker.app`, Android only. Generate the template with the RN CLI's init using a skip-install option where needed, or write the `android/` files by hand; do not run Gradle.
    - `package.json` with exact versions from the design's dependency table and `file:` deps on all pure packages; `prebundle` script that builds linked packages in dependency order.
    - `metro.config.js` per the design (`watchFolders`, `nodeModulesPaths`, `unstable_enableSymlinks`, `unstable_enablePackageExports`, `blockList` for sibling `node_modules`); `babel.config.js`; strict `tsconfig.json`; Jest config using `@react-native/jest-preset` and React Native Testing Library; `src/config.ts` with an OAuth client id placeholder (no client secret).
    - Add a Jest smoke test that loads `metro.config.js` and asserts the watch folders and resolver flags, and a test that `package.json` uses only exact versions.
    - Verify: `npm install`, `tsc --noEmit`, `npx jest` in `packages/mobile`.
    - _Requirements: R11.1, R10.1, R10.2, R12.10_

  - [x] 22.2 Implement port adapters in `src/adapters`
    - `KeyValueStore` over `createAsyncStorage("timeblocker")` with a per-key async mutex; `TokenVault` over `react-native-keychain` (service `timeblocker.google`); `AuthClient` over `react-native-app-auth` (issuer `https://accounts.google.com`, redirect `com.timeblocker.app:/oauth2redirect`, PKCE); `HttpTransport` over `fetch` + `AbortController`; `BackgroundJobs` over `react-native-background-fetch` (30 min, `stopOnTerminate: false`, `startOnBoot: true`, `enableHeadless: true`); `SystemSettings`; `UsageSource` over the existing UsageMetrics module.
    - Jest tests for each adapter with the libraries mocked at the module boundary (including mutex serialization and timeout aborts).
    - _Requirements: R7.1, R12.1, R12.2, R12.7, R14.3_

  - [x] 22.3 Add mobile structural tests
    - `mobile/src` contains no backend URL (`execute-api`, `amazonaws.com`) and no `@timeblocker/infra` or `@aws-sdk/*` import.
    - _Requirements: R12.6, R12.8_

- [x] 23. Kotlin `TimeBlockerAlarms` native module and Android manifest (static verification only)
  - [x] 23.1 Write the Kotlin module and receivers
    - In `packages/reminders/android` alongside the existing `RemindersModule.kt` (keep `presentReminder`/`cancelReminder` and `TimeBlockerReminderAction`): `TimeBlockerAlarmsModule` (`schedule` with `setExactAndAllowWhileIdle`/`setAndAllowWhileIdle`, stable request-code hash, `FLAG_IMMUTABLE | FLAG_UPDATE_CURRENT`, payloads in private `SharedPreferences`; `showNow`, `cancel`, `listPending`, `canScheduleExactAlarms`, `notificationPermission`, settings intents), `AlarmReceiver` (posts natively), `ActionReceiver` (non-exported, starts the headless service), `BootReceiver` (`BOOT_COMPLETED`, `MY_PACKAGE_REPLACED` re-arm), `NotificationActionTaskService` (`HeadlessJsTaskService`, 4.5 s timeout, allowed in foreground), channels `reminders`, `prompts`, `status`, `nudges`, and the package registration.
    - Not compiled in this task (no Gradle); verified by 23.4.
    - _Requirements: R13.1, R13.3, R13.4, R13.6, R13.10, R13.12, R13.13_

  - [x] 23.2 Wire Android project files
    - `android/app/build.gradle`: `sourceSets.main.java.srcDirs` include `packages/reminders/android` and `packages/usage-metrics/android`; `manifestPlaceholders = [appAuthRedirectScheme: "com.timeblocker.app"]`; signing config read from `gradle.properties` outside version control.
    - `AndroidManifest.xml`: `POST_NOTIFICATIONS`, `RECEIVE_BOOT_COMPLETED`, `USE_EXACT_ALARM`, `SCHEDULE_EXACT_ALARM` (`android:maxSdkVersion="32"`), `INTERNET`, `PACKAGE_USAGE_STATS` (`tools:ignore="ProtectedPermissions"`); the three receivers and the headless service; a `timeblocker://` deep-link intent filter separate from the OAuth scheme.
    - Register the `MainApplication` packages for `TimeBlockerAlarms` and `UsageMetrics`.
    - _Requirements: R7.1, R11.1, R12.1, R13.8, R13.10_

  - [x] 23.3 Implement the TypeScript bridge and `Notifier` adapter
    - Extend `packages/reminders` `nativeModule.ts` with typed `schedule`, `showNow`, `cancel`, `listPending`, `canScheduleExactAlarms`, `notificationPermission` (additive; `selectReminders` unchanged).
    - `mobile/src/adapters/notifier.ts` implements `Notifier` over it, with `PermissionsAndroid.request(POST_NOTIFICATIONS)` for `requestPermission`.
    - Jest tests against a mocked `NativeModules.TimeBlockerAlarms`.
    - _Requirements: R13.1, R13.8, R13.10, R13.11_

  - [x] 23.4 Add static verification tests for the Android files
    - Jest/Vitest test that reads the Kotlin files and manifest as text and asserts the class names, `AlarmManager` calls, receiver/service declarations, permissions (including `maxSdkVersion="32"`), redirect placeholder, and Gradle `srcDirs` are present.
    - _Requirements: R11.1, R13.8, R13.10_

- [x] 24. Screens and navigation
  - [x] 24.1 Implement `RootNavigator`
    - `@react-navigation/native` + `native-stack`; renders only SignIn unless `authState` is `signed-in`; routes for Intake, WeekView, BlockDetail, NothingFits, SaturdayReview, Settings; deep links `timeblocker://block/<id>` and `timeblocker://nothing-fits/<id>`.
    - Component test: only SignIn renders when signed out or session ended.
    - _Requirements: R11.2, R12.5, R14.12_

  - [x] 24.2 Implement the SignIn screen
    - "Sign in with Google" button; error text for cancel/failure; "Calendar access is required" for missing scope; "Your Google session ended" after `SessionEnded`.
    - Component tests for each message and retry availability.
    - _Requirements: R11.2, R11.3, R12.1, R12.5, R12.11_

  - [x] 24.3 Implement the Intake screen
    - Intake: multiline paste box (`maxLength={20000}`, character counter), Submit, inline error; text kept on rejection.
    - (The review screen that once followed Intake was removed in 34.2; Submit now plans in one step.)
    - Component tests for rejection keeping text and Confirm gating.
    - _Requirements: R1.2, R1.3, R11.4, R11.5, R11.6_

  - [x] 24.4 Implement the WeekView screen
    - Renders `buildWeekView`: category-colored blocks with category labels, "Calendar"-styled other events (white fill, dashed grey border), `RefreshControl` pull-to-refresh, bell badges, dismissible error banner, "Last synced".
    - Component tests for labels, distinct style, banner dismissal, badges, and refresh calling sync.
    - _Requirements: R11.7, R13.9, R14.2, R14.10_

  - [x] 24.5 Implement the BlockDetail screen with Undo
    - Shows title, category, start, end, status; "I'm in", "Skip", "Move it"; 10 s Undo snackbar after a move; no-fit navigates to NothingFits.
    - Component tests with fake timers (Undo visible before 10 s, gone after).
    - _Requirements: R11.8, R11.9, R13.13_

  - [x] 24.6 Implement the NothingFits screen
    - Lists the item(s) with Shrink (75%, 50%, custom ≥ 15 min), Drop, and Roll to next week; Roll hidden for fitness items.
    - Component tests for the options and fitness no-roll.
    - _Requirements: R2.3, R6.3, R8.1_

  - [x] 24.7 Implement the SaturdayReview screen
    - Finished, partial, missed; screen time and distraction level; moved-to-next-week with reasons; "Paste or type next week's list" linking to Intake.
    - Component tests for each section.
    - _Requirements: R9.1, R9.2, R9.3, R9.4, R11.10_

  - [x] 24.8 Implement the Settings screen
    - Two-option planning mode radio group; holiday list with validated add and remove; distraction app list with add/remove; usage-access and notification permission rows with "Open settings"; "Reminder timing may vary" note; Sign out. Statuses refresh on focus and on `AppState` → `active`.
    - All screens use `accessibilityRole`/`accessibilityLabel`, 48 dp touch targets, and never rely on color alone.
    - Component tests for the radio, lists, permission rows, and the `AppState` refresh.
    - _Requirements: R7.2, R11.11, R11.12, R13.10_

- [x] 25. Composition root, headless tasks, and setup guide
  - [x] 25.1 Implement `src/bootstrap.ts`
    - Build all adapters, repositories, and services into one container; expose it to screens through React context; wire `AppState` changes to `AppLifecycle.onForeground`.
    - Jest test that bootstrap constructs with all native modules mocked.
    - _Requirements: R12.6, R14.1_

  - [x] 25.2 Register the app and headless tasks in `index.js`
    - Register the root component, the `NotificationActionTask` headless task (calls `BlockActionService` and resolves within the 4.5 s budget), and the background-fetch headless handler (calls `SyncService.sync("background")`, then `BackgroundFetch.finish(taskId)`).
    - Jest tests invoke each registered handler with mocked natives and assert the service calls and `finish`.
    - _Requirements: R13.4, R14.3_

  - [x] 25.3 Write `packages/mobile/README.md` setup guide and manual checklist
    - Android Studio install (bundled JDK, SDK Platform, Build-Tools, Platform-Tools, `ANDROID_HOME`); personal signing keystore and SHA-1 (never committed).
    - Google Cloud: enable Calendar API, External consent screen with the Calendar scope, Android OAuth client with package `com.timeblocker.app` + SHA-1, enable Custom URI scheme in Advanced settings, client id into `src/config.ts` (no secret), publish consent screen In production.
    - Build (`npm ci`, `npm run prebundle`, `npx react-native run-android` or `./gradlew assembleRelease`) and install over USB (`adb install -r`) or on an emulator, as manual user steps.
    - The 12-step manual on-device checklist from the design's testing strategy.
    - Link it from the root `README.md`.
    - _Requirements: R11.1, R12.1, R12.10_

  - [ ]* 25.4 Write a Jest integration test of the composed app
    - Render the app from bootstrap with mocked natives and fake calendar transport: sign in → intake → confirm → week view shows the planned blocks.
    - _Requirements: R11.2, R11.5, R11.7_

- [x] 26. Final checkpoint - Ensure all tests pass
  - Run `tsc --noEmit` and the test suites in every package (Vitest for pure packages and infra, Jest for mobile). No Gradle, emulator, or device. Ensure all tests pass, ask the user if questions arise.
- [x] 27. Estimated, one-step intake (R15)
  - [x] 27.1 Add the estimator to `packages/flows`
    - `estimate.ts`: `extractInlineDuration`, `similarity`, `inferCategory`, `estimateCandidate`; `parseItemList` leaves unstated fields undefined and `IntakeCandidate.source` records where each value came from. Unit tests for every duration format in R15.2, the similarity rule, keyword categories, and precedence (stated over history over calendar over default).
    - _Requirements: R15.2, R15.3, R15.4, R15.5, R15.6_
  - [x] 27.2 Add `HistoryReader` and `IntakeService.submit` to `packages/app-core`
    - Read the last 26 weeks of blocks and cached events; `submit(raw, weekId)` validates, estimates, confirms, and plans. Tests with in-memory repos: no history, history by median, skipped blocks ignored, explicit values kept.
    - _Requirements: R15.1, R15.3, R15.4, R15.7, R15.8_
  - [x] 27.3 Change the Intake screen flow and add "Change length" to Block detail
    - `IntakeScreen` calls `submit` and resets to WeekView (NothingFits on top when unplaced); remove the review step from the main flow but keep the route. `BlockDetailScreen` adds "Change length". Update the screen, navigation, and bootstrap tests.
    - _Requirements: R15.1, R15.8, R15.9_
- [x] 28. Google-Calendar-style week grid (R16)
  - [x] 28.1 Add `buildWeekGrid` to `packages/app-core/src/viewModels`
    - Positions, overlap lanes, clipping, now line, initial scroll; unit tests including overlaps, touching items, and midnight clipping.
    - _Requirements: R16.1, R16.2, R16.3, R16.4_
  - [x] 28.2 Render the grid in `WeekViewScreen`
    - Time grid with day headers, hour gutter, rectangles with category colors and dashed other events, tap behavior, accessibility labels in time order, existing toolbar/banner/refresh/indicators kept. Update `WeekViewScreen.test.tsx`.
    - _Requirements: R16.1, R16.2, R16.5, R16.6, R16.7_
- [x] 29. Heads-up reminders with a forecast (R17)
  - [x] 29.1 Add `forecastBlock` and wire it into `desiredNotifications` and `reconcile`
    - Pure forecast function with the thresholds in R17.3; reconcile diff includes the body; tests for likely, unlikely, unknown (fewer than 3 samples), meeting overlap, and body-change replacement.
    - _Requirements: R17.2, R17.3, R17.5_
  - [x] 29.2 Reduce the reminder to two actions and update every consumer
    - New labels and removal of `skip` from block reminders in `desired.ts`, `packages/reminders/src/types.ts`, the mobile notification-action adapter, headless routing, and their tests. Skip remains on Block detail.
    - _Requirements: R17.4, R17.6_
  - [x] 29.3 Make the reminder a heads-up on Android
    - Bump the reminders channel id, keep `IMPORTANCE_HIGH`, set priority/category/visibility in `AlarmScheduler.kt`, update the static Android tests, and add the manual check to the README checklist.
    - _Requirements: R17.1_
- [x] 30. Checkpoint for the refinements
- [x] 31. Counted tasks (R20)
  - [x] 31.1 Parse counts in `packages/flows`
    - `extractCount`, `IntakeCandidate.count`, similarity ignores `(i of n)`, duration + count on one line; tests for every form in R20.2 and the negatives in R20.3.
    - _Requirements: R20.2, R20.3, R20.4, R20.5_
  - [x] 31.2 Spread a series over different days in the scheduling engine
    - Optional `group` on engine `Item`, soft different-day preference in `place()`, `computePlan` passes it through; existing engine and property tests unchanged; new tests.
    - _Requirements: R20.5_
  - [x] 31.3 Expand counted candidates into items in `IntakeService`
    - `seriesId`/`seriesIndex`/`seriesSize` on `IntakeItem`, titles `"<title> (i of n)"`, expanded-limit check, `PlanningService` passes the group. Tests with in-memory repos.
    - _Requirements: R20.2, R20.5, R20.6_
- [x] 32. Sleep score and profile name (R19, R18.2)
  - [x] 32.1 Sleep window, score, and `SleepService`
    - `nightWindow`, `sleepScore` in usage-metrics; `SleepService`, `sleepScores` document in app-core; lifecycle and background-sync wiring in mobile bootstrap. Tests including DST nights, exclusions, retries, and no-permission.
    - _Requirements: R19.1, R19.2, R19.3, R19.4, R19.5_
  - [x] 32.2 Google profile name
    - Scopes, `idToken` passthrough, `givenNameFromIdToken`, `profile` document, sign-out clears it. Update auth and authClient tests.
    - _Requirements: R18.2_
- [x] 33. Dashboard view model (R18)
  - [x] 33.1 `buildDashboard` and `motivationMessage`
    - Pure functions with the widget definitions of R18.4 and the message rules of R18.3; unit tests for every bucket and edge (no tasks, rolled excluded, no fitness, no sleep data).
    - _Requirements: R18.2, R18.3, R18.4_
- [x] 34. Dashboard screen and one-step intake UI (R18, R20)
  - [x] 34.1 `DashboardScreen`, navigation, and the dashboard port
    - First route after sign-in, link `dashboard`, buttons to Week, Intake, Review, Settings, pull to refresh, focus/foreground refresh, accessibility; bootstrap wiring; tests.
    - _Requirements: R18.1, R18.5, R18.6_
  - [x] 34.2 Intake instruction text and removal of the review screen
    - New instruction line on `IntakeScreen`; delete `ItemReviewScreen`, its route, link, placeholder, type entries and tests; update README and spec references.
    - _Requirements: R20.1, R20.7_
- [x] 35. Checkpoint for dashboard and counted tasks
- [x] 36. Realistic lengths and non-tasks (R22)
  - [x] 36.1 Split long totals, strip separators, skip sleep lines in `packages/flows`
    - Use the user's real lines as fixtures; `ignored` lines on the validation result and through `IntakeService.submit`.
    - _Requirements: R22.1, R22.2, R22.3_
- [x] 37. Plan summary, next-week move, and clear week (R21)
  - [x] 37.1 `rollToNextWeek`, `dropUnplaced`, `WeekResetService` in app-core
    - Atomic commits, outbox deletes, reminders reconcile; tests including partial plans and past/done blocks kept.
    - _Requirements: R21.3, R21.4, R21.5_
  - [x] 37.2 `PlanSummaryScreen`, intake navigation, and the clear button
    - Summary content per R21.1-R21.3, confirm dialog per R21.4, results per R21.5; navigation, ports, bootstrap, tests.
    - _Requirements: R21.1, R21.2, R21.3, R21.4, R21.5_
- [x] 38. Learned placement and durations (R23)
  - [x] 38.1 Preferences, engine hook, and planning wiring
    - `buildPlacementPreferences`, engine `preferences` option, `HistoryReader.placementHistory`, planning wiring, duration preference for done/partial history; tests and properties.
    - _Requirements: R23.1, R23.2, R23.3, R23.4, R23.5_
- [x] 39. Checkpoint, rebuild, and install
  - Run `tsc --noEmit` and the tests in every package; rebuild the app and install it on the emulator.
  - Run `tsc --noEmit` and the tests in every package (Vitest for pure packages and infra, Jest for mobile). Ensure all tests pass.

## Notes

- Tasks marked with `*` are optional (property-based tests and nice-to-have integration tests) and can be skipped for a faster MVP. Required sub-tasks include their own unit or component tests so each one is verifiable.
- Tasks 1-11 are complete; only stale wording in tasks 3, 5, and 10 was updated.
- Every task from 12 onward is verifiable on Node 22 with `tsc`, Vitest, and Jest (`@react-native/jest-preset`). The Android build and install are manual user steps in `packages/mobile/README.md`.
- Task 23 is verified statically (files, manifest entries, and adapter tests against a mocked native module); the Kotlin code is first compiled when the user builds in Android Studio.
- Property tests use fast-check 4.10.2 under Vitest 2.1.9, run at least 100 iterations, and carry the tag `// Feature: timeblocker, Property N: ...`.
- `react-native-keychain` and `react-native-background-fetch` compatibility with RN 0.88 is unconfirmed until the first Android build; the design's fallbacks sit behind the same ports.
- Each task references specific requirements for traceability.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["12.1", "12.2", "13.1"] },
    { "id": 1, "tasks": ["12.3", "13.2"] },
    { "id": 2, "tasks": ["13.3", "13.4", "15.1"] },
    { "id": 3, "tasks": ["13.5", "15.2"] },
    { "id": 4, "tasks": ["15.3", "15.5"] },
    { "id": 5, "tasks": ["15.4", "15.7", "16.1", "17.1"] },
    { "id": 6, "tasks": ["15.8", "15.9", "16.2", "17.2"] },
    { "id": 7, "tasks": ["15.6", "15.10", "15.11", "16.3", "17.4", "17.5"] },
    { "id": 8, "tasks": ["16.4", "16.5", "16.6", "16.7", "17.3", "18.1", "22.1"] },
    { "id": 9, "tasks": ["18.2", "18.6", "22.2", "23.1"] },
    { "id": 10, "tasks": ["18.3", "23.2", "23.3"] },
    { "id": 11, "tasks": ["18.4", "22.3", "23.4"] },
    { "id": 12, "tasks": ["18.5"] },
    { "id": 13, "tasks": ["18.7", "18.8", "18.9", "18.10", "18.11", "18.12", "20.1", "20.4", "20.5", "20.6"] },
    { "id": 14, "tasks": ["20.2", "24.2", "24.3", "24.7", "24.8"] },
    { "id": 15, "tasks": ["20.3", "24.4"] },
    { "id": 16, "tasks": ["20.7", "20.8", "20.9", "20.10", "20.11", "20.12", "24.5", "24.6"] },
    { "id": 17, "tasks": ["24.1", "25.1"] },
    { "id": 18, "tasks": ["25.2", "25.3"] },
    { "id": 19, "tasks": ["25.4"] }
  ]
}
```
- [x] 40. Health sleep data and demo data (R24, R25)
  - [x] 40.1 Sleep scoring with health sessions and the demo data engine in app-core
    - `SleepSource` port (ports.ts, done), night-session selection, R25.3 score, `SleepScore` extended (`asleepMin?`, `source`, `demo?`); `SleepService` uses the source when permission is granted; deterministic demo generators (blocks, usage, sleep sessions), `DemoDataService` (load/remove, demo-usage switch), tests.
    - _Requirements: R24.2, R24.3, R24.4, R24.5, R25.2, R25.3, R25.4_
  - [x] 40.2 Health Connect native module, manifest, and adapter
    - Kotlin `HealthSleepModule` (availability, permission check and request, read sessions, debug-only write/delete of demo sessions), release manifest permission and package query, permission-rationale activity, debug manifest with write permission, minSdk 26, TS adapter implementing `SleepSource`, static and Jest tests, `compileDebugKotlin` passes.
    - _Requirements: R25.1, R25.5, R25.6_
  - [x] 40.3 Settings UI, bootstrap wiring, and dashboard caption
    - "Sleep data" row and connect button, debug-only "Demo data" section, demo usage switch wiring in bootstrap, dashboard sleep caption naming the sources; tests and README steps.
    - _Requirements: R24.1, R24.3, R24.4, R25.1, R25.4_
- [x] 41. Checkpoint, rebuild, and install
- [x] 42. Theme, dashboard v2, and settings defaults (R26, R27, R30)
  - [x] 42.1 Theme system, dark mode, dashboard v2 UI, Appearance and defaults in settings
    - Tokens, provider, contrast tests; `DashboardView` v2 fields; `DashboardScreen` per the mock; Settings Appearance, planning default spread, holidays UI removed.
    - _Requirements: R26.1, R26.2, R26.3, R26.4, R27.1, R30.1_
  - [x] 42.2 Holidays from the country calendar and built-in distraction apps
    - `HolidayService`, calendar read of the holiday calendar, planning integration, `DEFAULT_DISTRACTION_APPS`.
    - _Requirements: R30.2, R30.3_
  - [x] 42.3 Migrate the remaining screens to the theme
    - Week view and grid, Intake, Block detail, Nothing fits, Saturday review, Sign in, shared components.
    - _Requirements: R26.1, R26.3, R26.5_
- [x] 43. Dates, times, and deadlines in tasks (R28)
  - [x] 43.1 `extractSchedule` and engine constraints in flows and scheduling-engine
    - _Requirements: R28.1, R28.2, R28.3, R28.4, R28.5, R28.6_
  - [x] 43.2 Intake routing, planning, and the important-deadlines view model
    - Routing to weeks, plan merge, `buildImportantTasks`, dashboard port, summary notes.
    - _Requirements: R28.2, R28.5, R28.7, R27.2, R27.3_
- [x] 44. Edit timing from the plan summary (R29)
  - [x] 44.1 `BlockActionService.setTiming` with auto-reschedule and multi-block undo
    - _Requirements: R29.2, R29.3, R29.4_
  - [x] 44.2 `TimingEditor` and tappable rows in `PlanSummaryScreen`
    - _Requirements: R29.1, R29.3, R29.4_
- [x] 45. Two-week calendar sync (R31)
  - [x] 45.1 Read and cache next week; planning reads its week first
    - _Requirements: R31.1, R31.2, R31.3, R31.4_
- [x] 46. Checkpoint, rebuild, and install
- [x] 47. AI backend (R32)
  - [x] 47.1 Lambda handler: validation, allow-list, Bedrock Converse with tool-use schemas, grounding, tests with a mocked Bedrock client
    - _Requirements: R32.1, R32.2, R32.4, R32.5, R33.2, R34.3, R34.4_
  - [x] 47.2 `TimeBlockerAiStack`: HTTP API, JWT authorizer, throttling, reserved concurrency, scoped IAM, budget and alarms; CDK assertion tests; deploy guide
    - _Requirements: R32.1, R32.3, R32.6_
- [x] 48. AI in the app (R33, R34, R35)
  - [x] 48.1 `AiClient`, `GoogleIdTokenProvider`, config and settings plumbing in app-core and mobile
    - _Requirements: R35.1, R35.2, R35.3_
  - [x] 48.2 Smarter list reading through the intake `enhancer`
    - _Requirements: R33.1, R33.2, R33.3, R33.4_
  - [x] 48.3 Settings AI section, "Help me start", and the Application helper screen
    - _Requirements: R34.1, R34.2, R34.3, R34.4, R34.5, R34.6, R35.1, R35.4_
- [ ] 49. Deploy (owner) and end-to-end test
  - Owner runs bootstrap and deploy; paste `ApiUrl` into `src/config.ts`; add the `sub` shown in Settings to `allowedSubs`; verify on the emulator.
