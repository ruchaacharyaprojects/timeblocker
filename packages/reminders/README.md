# @timeblocker/reminders

Custom reminders for TimeBlocker (R5).

On each 15-minute scheduler tick the backend selects the blocks and the
meetings-with-others starting ~15 minutes out and delivers a custom
notification for each (R5.1). Every notification carries the three actionable
buttons **"I'm in"**, **"Skip"**, and **"Move it"** (R5.2).

Google's own reminders on our blocks are suppressed upstream in
`@timeblocker/calendar-integration` (R4.2), so these are the only reminders the
user sees for blocks.

## Layout

- `src/select.ts` — pure, deterministic reminder selection. Given `now`, the
  week's blocks, and the week's meetings, returns the notifications to deliver.
  No network or I/O; fully unit-tested.
- `src/notify.ts` — the `NotificationPort` (injected push edge) and
  `runReminderTick`, which selects then delivers.
- `src/nativeModule.ts` — the TypeScript contract for the Android
  actionable-notification module, mirroring `@timeblocker/usage-metrics`.
- `android/` — the Kotlin `RemindersModule` / `RemindersPackage` that render
  the notifications with the three action buttons and emit button taps back to
  JS, plus the manifest snippet.

## Backend wiring

The scheduler Lambda's `reminders` branch (`packages/infra/lambda/scheduler`)
reads the current week's blocks and meetings, then calls `runReminderTick` with
a `NotificationPort` that pushes to the device. Selection stays pure; the
Lambda owns the I/O (DynamoDB read + push) behind injected ports.
