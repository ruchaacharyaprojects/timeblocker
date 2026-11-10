# Requirements Document

## Introduction

TimeBlocker is a cross-platform mobile app (React Native with an Android native module) built for **one user**. It sits on top of her Google Calendar, turns a pasted/typed to-do list into color-coded time blocks, and uses calendar changes plus phone usage to ask "Will you miss this block?" and reschedule within the same week.

**Timezone:** America/Toronto (never the device timezone).
**Week definition:** Sunday morning through Saturday night.
**Scope:** Single user. No multi-user accounts, no sharing, no iOS in v1.

## Requirements

### R1. Intake

**User Story:** As the user, I want to paste or type my to-do list and review the parsed items, so that nothing is scheduled until I confirm it.

#### Acceptance Criteria

1. WHEN the user submits a to-do list as pasted JSON (an array of items) or plain text lines THEN the system SHALL parse it into candidate items, defaulting any missing duration/priority/category.
2. THE SYSTEM SHALL present a review screen where the user confirms or edits each item's duration, priority (1 = highest), and category (fitness, self-care, work, self-development, misc).
3. THE SYSTEM SHALL NOT schedule any item until the user confirms the review.

### R2. Planning

**User Story:** As the user, I want items placed into my free time by priority, so that my most important work gets the best slots.

#### Acceptance Criteria

1. THE SYSTEM SHALL place blocks highest-priority-first into free time, after subtracting real Google Calendar events and the fixed constraints in R3.
2. THE SYSTEM SHALL support two planning modes: "earliest fit" and "spread across the week".
3. IF an item fits nowhere in the week THEN the system SHALL alert the user to choose shrink, drop, or roll to next week, AND SHALL NOT force the item into a slot.

### R3. Fixed constraints

**User Story:** As the user, I want my fixed life constraints always respected, so that blocks never collide with work, meals, sleep, or commute.

#### Acceptance Criteria

1. THE SYSTEM SHALL treat work hours as Mon-Fri 8:30 AM-4:30 PM. Blocks MAY be placed inside this window, but only in time free of real meetings.
2. WHEN a date is a Canadian statutory holiday THEN the system SHALL treat it as a day off with no work window.
3. THE SYSTEM SHALL reserve commute time of 30 minutes each way on Tue/Thu/Fri only (8:00-8:30 AM and 4:30-5:00 PM); Mon and Wed are remote with no commute.
4. THE SYSTEM SHALL protect sleep from 10:00 PM-6:30 AM daily, with a wake time of 6:30 AM.
5. THE SYSTEM SHALL protect wake-up from 6:30-6:50 AM, AND weekday blocks SHALL start no earlier than 6:50 AM.
6. THE SYSTEM SHALL protect dinner from 6:00-7:00 PM daily.
7. THE SYSTEM SHALL use scheduling windows of weekdays 6:50 AM-10:00 PM and weekends 10:00 AM-9:00 PM.
8. THE SYSTEM SHALL treat any gap shorter than 15 minutes as unusable.
9. THE SYSTEM SHALL allow at most one workout per day, while allowing several short power walks per day.
10. THE SYSTEM SHALL honor a morning routine: a ~20 minute walk around 6:50 AM, no reading first thing, 20+ minutes to freshen up before the gym, and 30-40 minutes to get ready for work.
11. THE SYSTEM SHALL reserve at least 30 minutes of screen-free self-care wind-down before bed.
12. ON Friday night THE SYSTEM SHALL NOT place heavy work items, AND SHALL lean toward self-care and chill blocks.

### R4. Calendar write

**User Story:** As the user, I want blocks written to my primary calendar as clearly marked solo events, so that I can see them without noise.

#### Acceptance Criteria

1. THE SYSTEM SHALL create solo events on the primary Google Calendar with a 🧱 title prefix and a distinct color per category.
2. THE SYSTEM SHALL disable Google's default pop-up reminders on its blocks AND SHALL NOT add email reminders.

### R5. Custom reminders

**User Story:** As the user, I want my own reminders before blocks and meetings, so that I can act without unlocking into the app.

#### Acceptance Criteria

1. THE SYSTEM SHALL fire a custom notification 15 minutes before each block AND before meetings that include other people.
2. THE SYSTEM SHALL present notification actions "I'm in", "Skip", and "Move it".

### R6. "Will you miss this?" prompt

**User Story:** As the user, I want to be asked when I'm likely to miss a block, so that it reschedules itself before the time is lost.

#### Acceptance Criteria

1. WHEN a new meeting overlaps a block OR phone usage near the block's start suggests she will miss it THEN the system SHALL send a notification "Will you miss this block?" with Yes and No.
2. WHEN the user taps Yes THEN the system SHALL immediately move the block to the next valid slot in the same Sunday-Saturday week AND show an Undo option.
3. IF no valid slot exists THEN the system SHALL start the "nothing fits" flow from R2.

### R7. Phone metrics (Android only)

**User Story:** As the user, I want usage measured privately on the device, so that only summaries leave my phone.

#### Acceptance Criteria

1. THE SYSTEM SHALL read screen time and per-app usage with UsageStatsManager after the user grants permission.
2. THE SYSTEM SHALL maintain "distraction" as a user-editable list of apps.
3. THE SYSTEM SHALL process usage on the device and send only summary signals to the backend, AND SHALL NOT upload raw app history.

### R8. Missed workouts

**User Story:** As the user, I want missed workouts to stay in their own week, so that they don't pile onto next week.

#### Acceptance Criteria

1. IF a workout cannot happen within its Sunday-Saturday week THEN it SHALL be counted as missed and shown in the Saturday review, AND SHALL NOT roll into the next Sunday.

### R9. Saturday review (about 7 minutes)

**User Story:** As the user, I want a short weekly review, so that I can close the week and set up the next one.

#### Acceptance Criteria

1. THE SYSTEM SHALL show what was finished, partly finished, and missed.
2. THE SYSTEM SHALL show phone screen time and distraction level.
3. THE SYSTEM SHALL show what moved to next week and why.
4. THE SYSTEM SHALL prompt the user to paste or type next week's to-do list.

### R10. Scope

**User Story:** As the user, I want a focused single-user v1, so that the app stays simple.

#### Acceptance Criteria

1. THE SYSTEM SHALL support a single user with no multi-user accounts and no sharing.
2. THE SYSTEM SHALL NOT support iOS in v1.

### R11. Mobile app screens (Android, React Native)

**User Story:** As the user, I want an installable Android app with the screens I need for the whole weekly loop, so that I can run TimeBlocker from my phone.

#### Acceptance Criteria

1. THE SYSTEM SHALL provide an Android app built with React Native, distributed as a sideloaded APK built locally with free tooling (Android Studio and the Android SDK), that installs and launches to its first screen without requiring any paid account, store listing, or AWS resource.
2. WHEN the user opens the app without a stored Google session, THE SYSTEM SHALL show a sign-in screen with a "Sign in with Google" action and SHALL NOT show any other app screen until sign-in completes.
3. IF the user cancels Google sign-in or sign-in fails, THEN THE SYSTEM SHALL remain on the sign-in screen, show an error message indicating that sign-in did not complete, and keep the "Sign in with Google" action available for another attempt.
4. THE SYSTEM SHALL provide an intake screen with a paste box that accepts up to 20,000 characters of input in either of two formats: a JSON array of items, or plain text lines where each non-blank line is one item.
5. WHEN the user submits the intake screen with input that parses to between 1 and 100 items, THE SYSTEM SHALL open the item review screen defined in R1.2, listing every parsed item with its duration, priority, and category editable, and SHALL NOT schedule any item until the user confirms that screen.
6. IF the user submits the intake screen with input that is empty, contains only whitespace, is malformed JSON beginning with "[", or parses to more than 100 items, THEN THE SYSTEM SHALL stay on the intake screen, keep the entered text unchanged in the paste box, and show an error message indicating the reason the input was rejected.
7. WHEN the user opens the week view, THE SYSTEM SHALL display the current Sunday 00:00 to Saturday 23:59 week in America/Toronto time, showing each TimeBlocker block in the color assigned to its category (per R4) and each non-TimeBlocker Google Calendar event from the latest completed sync in a visual style distinct from every category color.
8. WHEN the user taps a block in the week view, THE SYSTEM SHALL open a block detail screen showing the block's title, category, start time, end time, and current status, with the actions "I'm in", "Skip", and "Move it".
9. WHEN the user moves a block from the block detail screen, THE SYSTEM SHALL show an Undo option for 10 seconds, and WHEN the user selects Undo within those 10 seconds, THE SYSTEM SHALL restore the block to its previous start and end time and update the matching Google Calendar event to match.
10. WHEN the user opens the Saturday review screen, THE SYSTEM SHALL present the content defined in R9.1-R9.4 for the current Sunday-Saturday week: finished, partial, and missed blocks; screen time and distraction level; what moved and why; and the prompt to paste or type next week's list.
11. THE SYSTEM SHALL provide a settings screen where the user selects exactly one planning mode (earliest-fit or spread), adds and removes holiday dates, and adds and removes apps in the distraction app list, and WHEN the user changes any of these settings, THE SYSTEM SHALL persist the change on the device so it is still shown after the app is closed and reopened.
12. WHEN the user opens the settings screen or returns to it from an Android system setting, THE SYSTEM SHALL show the current status (granted or not granted) of the usage-access permission and the notification permission, each with an action that opens the matching Android system setting screen.

### R12. On-device operation mode

**User Story:** As the user, I want my first personal version to run entirely on my phone with no AWS, so that my data stays isolated and the app costs nothing to run.

#### Acceptance Criteria

1. THE SYSTEM SHALL perform Google OAuth on the device, requesting the Google Calendar scope, AND WHEN Google sign-in completes, THE SYSTEM SHALL verify that the granted consent includes the Calendar scope; IF the Calendar scope is not granted, THEN THE SYSTEM SHALL keep the user on the sign-in screen and show an explanation that Calendar access is required.
2. THE SYSTEM SHALL store Google OAuth tokens only on the device, in encrypted storage backed by the Android Keystore.
3. THE SYSTEM SHALL send Google OAuth tokens only to Google's OAuth and Calendar endpoints, AND SHALL NOT send the tokens to any other server.
4. WHEN a Google Calendar request is about to be made and the stored access token has expired or expires within 60 seconds, THE SYSTEM SHALL refresh the token on the device using the stored refresh token, making at most one refresh attempt per request.
5. IF the token refresh fails (Google rejects the refresh token or the refresh request fails), THEN THE SYSTEM SHALL keep local app data intact, show a message that the Google session ended, and return the user to the sign-in screen.
6. THE SYSTEM SHALL compute planning, rescheduling, reminder selection, and the Saturday review on the device using the existing pure modules (scheduling engine, reminders, usage metrics).
7. THE SYSTEM SHALL persist items, blocks, settings, and weekly reviews in local storage on the device.
8. WHILE the app runs in on-device mode, THE SYSTEM SHALL make no calls to AWS services or to the TimeBlocker backend API.
9. WHILE the app runs in on-device mode, THE SYSTEM SHALL keep usage data on the device, consistent with R7.3.
10. THE SYSTEM SHALL depend only on free services and tooling in on-device mode (no paid APIs, no paid hosting).
11. IF the user denies OAuth consent, THEN THE SYSTEM SHALL stay on the sign-in screen, store no tokens, and show that Calendar access is required.

### R13. Local notifications

**User Story:** As the user, I want reminders and "Will you miss this block?" prompts delivered as local notifications on my phone, so that they reach me without a push server.

#### Acceptance Criteria

1. WHEN a block is scheduled with a start time at least 15 minutes in the future, THE SYSTEM SHALL schedule exactly one local reminder notification for that block, set to fire 15 minutes before the block's start, satisfying R5.1 on the device.
2. WHEN a synced calendar meeting that includes at least one attendee other than the user has a start time at least 15 minutes in the future, THE SYSTEM SHALL schedule exactly one local reminder notification for that meeting, set to fire 15 minutes before the meeting's start.
3. THE SYSTEM SHALL attach exactly three actions, "I'm in", "Skip", and "Move it", to each block reminder notification, satisfying R5.2.
4. WHEN the user taps a block reminder notification action, THE SYSTEM SHALL, within 5 seconds and without opening the app, apply the action to the block ("I'm in" marks the block in progress, "Skip" marks the block skipped, "Move it" moves the block to the next valid slot in the same Sunday–Saturday week as defined in R6.2), save the updated block state, and dismiss the notification.
5. WHEN a calendar sync finishes and a newly synced meeting overlaps an existing block by at least 1 minute (meeting start is earlier than block end and meeting end is later than block start), THE SYSTEM SHALL, within 60 seconds of the sync finishing, show exactly one local "Will you miss this block?" notification for that meeting and block pair, with Yes and No actions, satisfying R6.1 on the device.
6. WHEN the user taps Yes on a "Will you miss this block?" notification, THE SYSTEM SHALL move the block to the next valid slot in the same Sunday–Saturday week with an Undo option as defined in R6.2, or, if no valid slot exists, start the "nothing fits" flow (shrink, drop, or roll) as defined in R6.3.
7. WHEN a block moves or a calendar sync finishes, THE SYSTEM SHALL, within 60 seconds, cancel every scheduled notification whose block or meeting time was removed or changed, and schedule notifications for the current block and meeting times, so that each future block and qualifying meeting has exactly one scheduled reminder and no duplicates remain.
8. WHEN the app launches on Android 13 or later and the notification permission has not been granted or denied, THE SYSTEM SHALL request the POST_NOTIFICATIONS permission once, and SHALL NOT request it again after the user denies it.
9. IF the notification permission is denied at the time the app comes to the foreground, THEN THE SYSTEM SHALL show an in-app indicator in the week view on each block or meeting starting within the next 15 minutes and on each block with an unanswered "Will you miss this block?" prompt, and SHALL keep each indicator visible until the item starts or the prompt is answered.
10. IF exact-alarm scheduling is unavailable on Android 12 or later, THEN THE SYSTEM SHALL schedule reminders as inexact alarms and show an indicator on the settings screen stating that reminder timing may vary, and SHALL remove the indicator and reschedule reminders as exact alarms within 60 seconds of the app coming to the foreground after exact-alarm scheduling becomes available.
11. IF a block or qualifying meeting is scheduled or synced with a start time less than 15 minutes in the future but not yet started, THEN THE SYSTEM SHALL show its reminder notification immediately instead of at the 15-minute mark, and SHALL NOT schedule any reminder for a block or meeting whose start time has passed.
12. WHEN the user taps No on a "Will you miss this block?" notification, THE SYSTEM SHALL leave the block's time and status unchanged, dismiss the notification, and keep the block's existing reminder scheduled.
13. IF the user taps "Move it" and no valid slot exists in the same Sunday–Saturday week, THEN THE SYSTEM SHALL leave the block at its original time, keep its status unchanged, and show a local notification indicating that nothing fits which, when tapped, opens the "nothing fits" flow defined in R6.3.

### R14. Calendar sync on device

**User Story:** As the user, I want my phone to keep my blocks and Google Calendar in step, so that conflicts are caught and the calendar always matches the app.

#### Acceptance Criteria

1. WHEN the app is opened or brought to the foreground while the user is signed in, THE SYSTEM SHALL read all events from the primary Google Calendar that overlap the current Sunday 00:00 to Saturday 23:59:59 week in America/Toronto.
2. WHEN the user pulls to refresh the week view, THE SYSTEM SHALL read all events from the primary Google Calendar that overlap the current Sunday-Saturday week, and SHALL show a progress indicator that disappears within 15 seconds, when the sync either completes or fails.
3. WHILE the user is signed in, THE SYSTEM SHALL schedule a periodic background calendar sync at an interval of no more than 60 minutes, and SHALL NOT run a second sync while one is already in progress. Android background-execution limits (for example Doze mode or battery saver) may delay a run.
4. WHEN a calendar sync completes, THE SYSTEM SHALL treat a local block as overlapped only when all of these hold: the block's status is "scheduled"; a calendar event includes at least one attendee other than the user; that event is not a TimeBlocker block event (🧱 title prefix); and the two spans overlap under half-open [start, end) rules, so touching at a boundary is not an overlap.
5. WHEN a calendar sync finds an overlap from criterion 4 between a block and a meeting that has not already caused a prompt for that block, THE SYSTEM SHALL trigger the R13.5 "Will you miss this block?" prompt once for that block. It SHALL NOT trigger it again on later syncs for the same block and meeting pair.
6. WHEN a calendar sync finds that a TimeBlocker block event was moved in Google Calendar, THE SYSTEM SHALL set the matching local block's start and end times to the calendar event's start and end times.
7. WHEN a calendar sync finds that a TimeBlocker block event was deleted from Google Calendar, THE SYSTEM SHALL remove the matching local block from the week view and cancel that block's scheduled local reminder (R13.1).
8. WHEN a local block is created, moved, or removed, THE SYSTEM SHALL create, update, or delete exactly one matching Google Calendar event, so that each local block maps to no more than one calendar event.
9. THE SYSTEM SHALL write every block event using the 🧱 title prefix, the color for the block's category, and the suppressed default pop-up and email reminders defined in R4.
10. IF a Google Calendar read or write request fails, THEN THE SYSTEM SHALL keep all local blocks unchanged, queue each failed write for retry on the next sync, and show a dismissible error banner that names the failed sync and leaves the rest of the app usable. The banner SHALL clear automatically after the next successful sync.
11. WHEN a calendar sync starts while queued local writes from criterion 10 exist, THE SYSTEM SHALL send the queued writes to Google Calendar before reading events, so that a pending local change is not overwritten by an older calendar state.
12. IF the Google Calendar authorization is missing, expired and cannot be refreshed, or revoked, THEN THE SYSTEM SHALL stop the background sync, keep all local blocks, and show a prompt asking the user to sign in to Google again.

### R15. Effortless intake with estimated durations
**User Story:** As the user, I want to paste or type my list and have it go straight onto my calendar, with durations estimated from what I have scheduled before, so that I never have to choose a category or a length.

#### Acceptance Criteria
1. WHEN the user submits a valid list on the intake screen, THE SYSTEM SHALL estimate each item's duration and category, plan the items into the current week, and show the week view, without showing an item review screen and without asking for a category, duration, or priority.
2. WHERE an item's text states a duration (for example "30 min", "1h", "1.5 hours", "45m", "for 2 hrs", or a time range such as "3-4pm"), THE SYSTEM SHALL use that duration, rounded to the nearest 5 minutes and limited to 5 to 480 minutes, and SHALL NOT replace it with an estimate. A trailing duration or range SHALL be removed from the block title.
3. WHERE an item's text states no duration, THE SYSTEM SHALL estimate the duration as the median length, rounded to the nearest 5 minutes, of the user's past blocks (any status except "skipped") whose titles are similar to the item, using the most recent 26 weeks stored on the device. Titles are similar when they share at least half of their words after lowercasing, removing punctuation, and ignoring common filler words.
4. IF no past block is similar, THEN THE SYSTEM SHALL estimate the duration from past non-TimeBlocker calendar events in the cached weeks with similar titles using the same rule, and IF there are none, THEN THE SYSTEM SHALL use the default for the inferred category: work 60, self-development 45, fitness 45, self-care 30, misc 30 minutes.
5. THE SYSTEM SHALL infer each item's category from the category of similar past blocks when any exist (the most common one), and otherwise from keywords in the text (for example gym, run, workout, yoga for fitness; email, report, meeting prep, client for work; read, study, course, practice for self-development; meditate, shower, skincare, sleep for self-care), and SHALL use "misc" when nothing matches. Priority SHALL default to 3.
6. THE SYSTEM SHALL keep every explicit value given in the pipe form (`text | minutes | priority | category`) or in JSON input, and SHALL estimate only the missing fields.
7. THE SYSTEM SHALL read only data stored on the device to make estimates, SHALL NOT send item text to any service other than Google Calendar when writing blocks, and SHALL keep working with no history, using the defaults in criterion 4.
8. WHEN planning leaves items unplaced, THE SYSTEM SHALL show the "nothing fits" flow from R6.3 on top of the week view, as before.
9. THE SYSTEM SHALL let the user change a block's length and time after planning from the block detail screen, because the user no longer reviews items before planning.

### R16. Google-Calendar-style week view
**User Story:** As the user, I want to see my week as a calendar grid like the Google Calendar app, so that I can see at a glance when my blocks and meetings are.

#### Acceptance Criteria
1. THE SYSTEM SHALL show the current Sunday to Saturday week (America/Toronto) as a time grid with one column per day, a day header (weekday and date, with today highlighted), an hour scale on the left, and horizontal hour lines.
2. THE SYSTEM SHALL draw each TimeBlocker block and each cached calendar event as a rectangle whose top and height match its start time and duration, using the category colors from R4 for blocks and the existing dashed outline style for other calendar events, and SHALL show the title (truncated if needed) inside the rectangle.
3. WHEN two items in a day overlap, THE SYSTEM SHALL place them side by side in equal-width lanes so that neither is hidden.
4. THE SYSTEM SHALL draw a line across today's column at the current time, and SHALL scroll the grid on opening so that the current time (or 07:00 when the current time is before 07:00) is near the top.
5. WHEN the user taps a block, THE SYSTEM SHALL open its detail screen, and WHEN the user taps a calendar event, THE SYSTEM SHALL show its title and time.
6. THE SYSTEM SHALL keep pull to refresh, the last-synced time, the sync error banner, the needs-attention indicator from R13.9, and the buttons for planning, review, and settings in the week view.
7. THE SYSTEM SHALL give every rectangle an accessibility label with the title, day, start and end times, category, and status, so the week is readable by a screen reader in time order.

### R17. Heads-up reminders with an attendance forecast
**User Story:** As the user, I want a pop-up at the top of my screen shortly before a block, telling me how likely I am to make it and letting me move it in one tap, so that I do not drift past blocks I will not do.

#### Acceptance Criteria
1. THE SYSTEM SHALL show each block reminder 15 minutes before the block starts as a heads-up notification that appears at the top of the screen over other apps, using a high-importance channel, and SHALL keep the lead time and the immediate-reminder rule from R13.1 and R13.11.
2. THE SYSTEM SHALL put a one-line attendance forecast in the reminder text after the start time. The forecast SHALL be "Likely to happen" with the supporting reason when the forecast is favorable, and "May not happen" with the reason when it is not. No forecast line SHALL be shown when there is not enough information to make one.
3. THE SYSTEM SHALL base the forecast on: (a) the share of the user's past blocks in the same category that ended as done or partial, versus missed or skipped, when at least 3 such blocks exist in the stored history; (b) whether a cached calendar event with other attendees overlaps the block; and (c) whether the user has already spent time in the distraction apps (R7) in the 10 minutes before the check, when usage access is granted. A block is forecast as "may not happen" when it overlaps a meeting with others, or when its category completion share is under 50%, or when recent distraction use crossed the R7 threshold.
4. THE SYSTEM SHALL offer exactly two actions on a block reminder: "I'll be there" and "Move to later this week". "I'll be there" SHALL mark the block in progress as "I'm in" does in R13.3. "Move to later this week" SHALL move the block to the earliest free slot later in the same Sunday to Saturday week that satisfies the scheduling constraints, as "Move it" does in R13.3, and SHALL show the "nothing fits" notification from R13.13 when no slot exists. Skipping a block SHALL remain available from the block detail screen.
5. THE SYSTEM SHALL compute the forecast when the reminder is scheduled or rescheduled (after planning, sync, and block actions, and when the app opens or comes to the foreground), and SHALL replace an armed reminder when its forecast text changes, so that the reminder never shows a forecast older than the last time the app ran.
6. These criteria replace the three-action reminder buttons in R13.3 and R13.4; the miss-prompt in R13.5 and its Yes and No actions are unchanged.

### R18. Dashboard home screen
**User Story:** As the user, I want the app to open on a clean, minimal dashboard that shows how my week is going, so that I see my progress and stay motivated before I look at the calendar.

#### Acceptance Criteria
1. WHEN the user is signed in and the app opens, THE SYSTEM SHALL show the dashboard as the first screen, and SHALL provide buttons on it to open the week calendar, add this week's tasks, the Saturday review, and settings. The back stack SHALL start at the dashboard.
2. THE SYSTEM SHALL show a greeting at the top, "Hi <first name>!", using the first name from the user's Google profile, and SHALL show "Hi there!" when no name is known. Below the greeting THE SYSTEM SHALL show one short motivation message.
3. THE SYSTEM SHALL choose the motivation message from a fixed on-device set, based on the week's progress (no tasks planned yet, just started, going well, nearly done, all done, or behind) and the day of the week, so that the same message shows all day and the text changes from day to day. No message SHALL shame the user, and no network or AI service SHALL be used.
4. THE SYSTEM SHALL show these four widgets for the current Sunday to Saturday week (America/Toronto), each as a card with a large number and a one-line label:
   a. Tasks completed: the percentage of this week's blocks with status "done", out of all blocks of the week except those rolled to next week. Show "—" and "No tasks planned yet" when the denominator is 0.
   b. Sleep score: the average of the nightly sleep scores recorded for the nights of this week, as a whole number from 0 to 100. Show "—" and a short reason when there is none (usage access not granted, or no night recorded yet).
   c. Fitness score: the percentage of this week's fitness blocks with status "done", out of all fitness blocks of the week. Show "—" and "No fitness tasks this week" when there are none.
   d. Moved tasks: the number of this week's blocks that were moved to a different slot, counting each block that has a previous slot recorded plus each block rolled to next week.
5. THE SYSTEM SHALL refresh the widgets when the dashboard gains focus, when the app returns to the foreground, and after a pull to refresh (which also runs the calendar sync as in R14.2), and SHALL make each widget readable by a screen reader as one item (label plus value).
6. THE SYSTEM SHALL keep the dashboard visually minimal: no more than the greeting, the message, the four cards, and the navigation buttons, with plenty of spacing and the existing color palette.

### R19. Sleep score from phone use during sleep hours
**User Story:** As the user, I want a sleep score based on whether I was on my phone during the night, so that I can see how well I protect my sleep.

#### Acceptance Criteria
1. WHERE usage access is granted, WHEN the app opens, comes to the foreground, or runs a background sync, THE SYSTEM SHALL score each night that has fully ended and has not been scored yet, for up to the last 3 nights. The sleep window of a night is 22:00 on that date to 06:30 the next day, America/Toronto, which is the same window the planner protects in R3.4.
2. THE SYSTEM SHALL measure phone use for a night as the total foreground time of all apps except TimeBlocker itself and the Android system UI inside that window, read from the usage statistics on the device, and SHALL compute the night's score as 100 minus 1.5 points per minute of use, rounded and limited to 0 to 100, so that no use scores 100 and about 67 minutes or more scores 0.
3. THE SYSTEM SHALL store only the date, the minutes of use, and the score for each scored night (no per-app data), keep these for at least 26 weeks, and SHALL NOT store or send raw usage records.
4. IF usage access is not granted, or the usage read fails, THEN THE SYSTEM SHALL record no score for that night and SHALL retry it on a later run while it is still within the last 3 nights.
5. THE SYSTEM SHALL NOT include nights that have not finished yet, and SHALL show the sleep widget average from the nights of the current week only.

### R20. Task-list intake with counts and no review
**User Story:** As the user, I want to type my tasks one per line, including how many times or how long, and have everything scheduled without a review step.

#### Acceptance Criteria
1. THE SYSTEM SHALL show this instruction at the top of the intake screen: "Provide a list of your tasks this week, one on each line."
2. WHERE a task line states a number of times, THE SYSTEM SHALL create that many separate tasks (and blocks) from the line. Recognized forms are: "3x", "x3", "3 x", "3 times", "3 sessions", "3 days a week" (also "per week", "this week", "each week"), "once", "twice", "thrice", and the words one to seven in "<word> times" (for example "three times"). The count text SHALL be removed from the title. The number SHALL be between 1 and 14; a larger or zero number SHALL be ignored and left in the title.
3. A number that is not in one of those forms (for example "Call 3 people", "Chapter 2", "Top 5 tasks") SHALL be left in the title and SHALL NOT change the count or the duration.
4. WHERE the same line also states a duration (R15.2), THE SYSTEM SHALL use it for each created task, so that "Gym 3x 45 min" creates three 45-minute tasks.
5. THE SYSTEM SHALL give the created tasks the same title with a suffix such as "(1 of 3)" when the count is greater than 1, SHALL treat that suffix as non-text when matching similar past blocks (R15.3), and SHALL place the tasks of one line on different days when the week allows it, falling back to the same day only when no other day has room.
6. THE SYSTEM SHALL count the expanded tasks against the 100-item limit and SHALL reject the list with the existing too-many-items message when the expanded total would exceed it.
7. THE SYSTEM SHALL NOT show an item review or confirmation screen at any point: submitting the list SHALL plan it and show the week calendar, using stated values first, then similar past blocks, then keywords (category) and category defaults (duration), with "Misc" when no category can be determined. The review route and its deep link SHALL be removed.

### R21. Clear plan summary, move to next week, and clear the week
**User Story:** As the user, I want to be told exactly what was added and what did not fit, to be able to move the leftovers to next week, and to clear this week's tasks, so that I am never confused about what is on my calendar.

#### Acceptance Criteria
1. WHEN the user submits a task list, THE SYSTEM SHALL show a plan summary screen instead of the "nothing fits" screen. It SHALL state how many tasks were added to this week and list them with their day and time, and, when some tasks did not fit, SHALL list those separately under "Didn't fit this week". It SHALL say "Nothing fits" only when no task at all could be placed.
2. WHEN every task was added, THE SYSTEM SHALL show only the confirmation ("Added N tasks to this week") with a "View my week" button.
3. WHEN some tasks did not fit, THE SYSTEM SHALL offer "Move these to next week" and "Leave them out". "Move these to next week" SHALL plan those tasks in the next Sunday to Saturday week, using the whole week as available time, and SHALL show a second summary of what was added next week and what still did not fit. "Leave them out" SHALL remove those unplaced tasks from this week so they are not offered again.
4. THE SYSTEM SHALL provide a "Clear this week's tasks" button on the intake screen. After the user confirms a dialog that states what will be removed, THE SYSTEM SHALL remove from the current week every task that has not happened yet: unplaced tasks and blocks with status "scheduled" that start after now. For each removed block it SHALL delete the matching Google Calendar event (through the outbox as in R14.8), cancel its reminder, and SHALL clear the saved intake draft. Blocks that are done, partial, missed, skipped, in progress, or already started SHALL be kept as history.
5. WHEN clearing finishes, THE SYSTEM SHALL tell the user how many tasks were removed and how many were kept as history.

### R22. Sensible block lengths and non-tasks
**User Story:** As the user, I want long totals such as "10 hours" turned into sessions that fit my days, and lines about sleep left out, so that my plan is realistic.

#### Acceptance Criteria
1. WHERE a line states a total time of more than 3 hours (up to 40 hours) and no count (R20.2), THE SYSTEM SHALL split it into the smallest number of equal sessions of at most 2 hours, each rounded to 5 minutes, up to 14 sessions, titled "<title> (i of n)" and placed on different days when possible as in R20.5. A line with a count keeps its stated duration for each session. Totals of 3 hours or less stay one block.
2. THE SYSTEM SHALL remove a trailing separator (a hyphen, en dash, em dash, comma, or colon) left over after the duration and count text is taken out of a title, so "Study – 10 hours" becomes "Study".
3. THE SYSTEM SHALL NOT schedule lines about sleeping (containing the word sleep, nap, or bedtime), because sleep time is already protected (R3.4). The plan summary SHALL list them as "Skipped: sleep is already protected".

### R23. Learned time-of-day placement and durations
**User Story:** As the user, I want blocks placed at the times of day I usually complete that kind of task, and lengths based on how long similar tasks really took, so that my plan fits how I actually work.

#### Acceptance Criteria
1. THE SYSTEM SHALL compute, on the device, from the user's blocks of the last 26 weeks, a completion rate for each category and each 2-hour time-of-day bucket of the block's start. A block counts as completed when its status is "done" (1 point) or "partial" (0.5 point), and as not completed when it is "missed" or "skipped". Blocks that are scheduled, in progress, rolled, or moved are ignored.
2. THE SYSTEM SHALL smooth each bucket's rate toward the category's overall rate with a prior weight of 3 blocks, and SHALL use the preferences for a category only when that category has at least 5 counted blocks. Otherwise the planner SHALL behave as before.
3. WHEN preferences exist for a task's category, THE SYSTEM SHALL start the task at the feasible start time (on a 15-minute grid, inside free time, satisfying all existing constraints) whose bucket has the highest smoothed rate, preferring the earlier time on ties, and SHALL NOT leave a task unplaced that would have fit without preferences.
4. THE SYSTEM SHALL estimate a task's duration (R15.3) from similar past blocks that ended "done" or "partial" when at least one exists, and otherwise from all similar blocks except "skipped".
5. THE SYSTEM SHALL use only on-device statistics for R23; it SHALL NOT use a language model or any network service.

### R24. Demo data for testing (debug builds only)
**User Story:** As the developer-user, I want realistic fake screen-usage, sleep and history data that I can load and remove, so that I can test the dashboard, sleep score, forecasts, and learned placement without waiting weeks.

#### Acceptance Criteria
1. WHERE the app is a debug build, THE SYSTEM SHALL show a "Demo data" section in settings with buttons "Load demo data" and "Remove demo data" and a switch "Use demo screen usage". Release builds SHALL NOT show or include this section's actions.
2. WHEN the user loads demo data, THE SYSTEM SHALL create about 8 past weeks of blocks (ids starting with `demo-`, marked as already in sync with Google Calendar so nothing is written to the calendar) in which completion depends on the time of day (for example work tasks are mostly done in the morning and mostly missed in the evening, fitness mostly done in the early evening), SHALL create nightly sleep scores for the last 14 nights with varied phone use and sleep length, and SHALL add common distraction apps to the settings when none are set. It SHALL NOT create or change any block in the current week and SHALL NOT call Google Calendar.
3. WHEN "Use demo screen usage" is on, THE SYSTEM SHALL answer every usage read with deterministic synthetic app usage (more night-time use on some nights, distraction-app use in the daytime) and report usage access as granted, so that sleep scoring, the Saturday review, and the miss-risk prompt can be tested without real usage. Turning the switch off SHALL restore the real usage source.
4. WHEN the user removes demo data, THE SYSTEM SHALL delete every demo block and demo sleep score, turn the demo usage switch off, ask Health Connect to delete the demo sleep records the app wrote (R25.6), and SHALL leave all real data unchanged.
5. THE SYSTEM SHALL keep demo-generated data distinguishable (the `demo-` id prefix and a `demo` flag on sleep scores) so that it is never mixed into real data on removal.

### R25. Sleep data from Samsung Health through Health Connect
**User Story:** As the user, I want my sleep to come from my Samsung Health sleep tracking, combined with how much I used my phone while asleep, so that the sleep score reflects how long and how well I really slept.

#### Acceptance Criteria
1. THE SYSTEM SHALL read the user's sleep sessions from Android Health Connect (which Samsung Health writes to), using only the read permission for sleep, and SHALL show in settings a "Sleep data" row with the status (connected, not connected, Health Connect not available) and a "Connect Samsung Health sleep" button that asks for the permission. The app SHALL work normally when the permission is not granted.
2. WHERE the sleep permission is granted, WHEN the app opens, comes to the foreground, or runs a background sync, THE SYSTEM SHALL score each of the last 3 ended nights that is not yet scored. A night's session is the longest sleep session that starts between 18:00 of that date and 04:00 of the next day and lasts at least 3 hours. Its asleep time is the session length minus awake stages when stages exist.
3. WHERE a session exists for the night, THE SYSTEM SHALL compute the night's score as `clamp(round(100 * min(asleepMinutes, 480) / 480) - round(1.5 * phoneMinutes), 0, 100)`, where phoneMinutes is the foreground time of all apps except TimeBlocker and the Android system UI between the session's start and end. Where no session exists or the permission is not granted, THE SYSTEM SHALL use the phone-use-only score of R19.2 for the fixed 22:00 to 06:30 window.
4. THE SYSTEM SHALL store for each scored night only the date, the score, the phone minutes, the asleep minutes (when known), and which sources were used ("health+usage" or "usage"), and SHALL NOT store per-stage data, heart rate, or any other health data. The dashboard sleep card SHALL name the sources used, "Samsung Health + phone use" or "Phone use only".
5. THE SYSTEM SHALL declare only the sleep read permission and the Health Connect package query in the release manifest, SHALL require Android 8.0 (API 26) or later, and SHALL NOT send any health data off the device.
6. WHERE the app is a debug build, THE SYSTEM SHALL be able to write and delete demo sleep sessions in Health Connect (using a debug-only manifest with the sleep write permission) so that the same read path used for Samsung Health can be tested on an emulator.

### R26. Visual theme and dark mode
**User Story:** As the user, I want a calm sage-green look with coral buttons and an optional dark mode, so that the app is pleasant and readable day and night.

#### Acceptance Criteria
1. THE SYSTEM SHALL use a mint/sage green background on every screen in light mode, vibrant coral / sunset orange for primary buttons and accents, and dark charcoal text, and SHALL define all colors in one theme (light and dark) used by every screen.
2. THE SYSTEM SHALL offer an "Appearance" setting with "Match phone", "Light", and "Dark" (default "Match phone"), applied immediately and kept across restarts. In dark mode THE SYSTEM SHALL use a dark green-grey background, lighter card surfaces, light text, and the same coral buttons.
3. THE SYSTEM SHALL keep every text and background pairing at a contrast ratio of at least 4.5:1 (3:1 for large text 24 sp and up) in both modes, and SHALL put dark text on coral buttons where white text would fall below that ratio.
4. WHEN a dashboard summary card shows great progress (tasks completed at least 75%, fitness score at least 75%, or sleep score at least 80), THE SYSTEM SHALL show that card's value and label in lightning yellow. Because yellow text is unreadable on light green, a great-progress card SHALL use a dark green surface in both modes so the yellow text stays readable. A card without great progress SHALL use the normal surface and text colors.
5. THE SYSTEM SHALL keep Google Calendar category colors for blocks in the week grid unchanged in both modes.

### R27. Dashboard layout and important deadlines
**User Story:** As the user, I want the dashboard to match my design and to surface my must-do deadlines, so that nothing important slips.

#### Acceptance Criteria
1. THE SYSTEM SHALL lay out the dashboard as: a large greeting ("Hi <name>!"), the motivation message in muted text, a 2x2 grid of rounded summary cards each with a colored round icon (check mark for tasks completed, moon for sleep, runner for fitness, double arrow for moved tasks) above the large value, the bold label, and the caption; then one wide rounded "Important deadlines" block; then four full-width rounded navigation rows (Week calendar as the filled primary row, then Add this week's tasks, Saturday review, Settings as outlined rows), each with an icon on the left, a centered label, and a chevron on the right.
2. THE SYSTEM SHALL show in the "Important deadlines" block up to 3 pending tasks that have a hard deadline, sorted by deadline (soonest first), each with its title, a due label ("Due today 5:00 PM", "Due Fri 5:00 PM", "Overdue"), and a colored marker (red for overdue, orange for due within 24 hours, neutral otherwise). A pending task is one that is not done, partial, or skipped, in the current week or any of the next 3 weeks, including tasks that did not fit and tasks scheduled for later. WHEN there are more than 3, THE SYSTEM SHALL show "+N more". WHEN there are none, THE SYSTEM SHALL show "No deadlines coming up".
3. THE SYSTEM SHALL make each deadline row tappable to open its block (or the plan summary for a task that did not fit), and SHALL give the whole block and each row accessibility labels that read the title and due label.

### R28. Dates, times, and deadlines in task text
**User Story:** As the user, I want "Dentist Tuesday 3pm" or "Report due Friday 5pm" understood, so that tasks land at the right time.

#### Acceptance Criteria
1. THE SYSTEM SHALL recognize in a task line (America/Toronto, relative to now): times ("3pm", "3:30 pm", "15:00", "noon"); days ("today", "tonight", "tomorrow", weekday names with optional "this"/"next"/"on", e.g. "Tue", "next Monday"); and dates ("Nov 12", "November 12th", "12 Nov", "2026-11-12", "11/12" read as month/day). A weekday means its next occurrence including today when the time is still ahead. The recognized text SHALL be removed from the title.
2. WHEN a line has a day or date and a time without a deadline word, THE SYSTEM SHALL schedule the task to start exactly then (a fixed time), using the stated or estimated duration. WHEN that time is already taken (a calendar event, another fixed task, or protected time such as sleep) or in the past, THE SYSTEM SHALL NOT place it and SHALL list it in the plan summary as "Couldn't schedule at <time>: <reason>" with the option to pick another time (R29).
3. WHEN a line has only a day or date, THE SYSTEM SHALL schedule the task on that day at any free time (planned in that day's week).
4. WHEN a line has a time only (no day), THE SYSTEM SHALL use today if the time is still ahead and otherwise tomorrow.
5. WHEN a line has a deadline word ("by", "due", "before", "until", "deadline", "no later than", "due on") with a day, date, and/or time, THE SYSTEM SHALL store a hard deadline (end of the day at 17:00 when only a day is given, unless a time is given), SHALL give the task top priority, SHALL schedule it to finish before the deadline (earliest suitable time in the current week), and SHALL keep the deadline on the task for R27. WHEN no slot before the deadline exists, THE SYSTEM SHALL list it as not fitting with the reason "No time before the deadline".
6. WHEN a line has a count (R20), a deadline applies to every created task, and a fixed time or single-day constraint is ignored with a note in the plan summary.
7. Dates in a later week SHALL be planned in that week's plan (and shown in the summary), and lines with a date in the past SHALL be treated as having no date, with a note in the summary.

### R29. Edit timing from the plan summary
**User Story:** As the user, I want to tap a task in the summary and change when it happens, with the other tasks shifting out of the way.

#### Acceptance Criteria
1. WHEN the user taps a task on the plan summary screen, THE SYSTEM SHALL open a time editor showing the day (Sunday to Saturday of the task's week, as chips), the start time (15-minute steps), and the length (5-minute steps), prefilled with the current values.
2. WHEN the user saves a new time, THE SYSTEM SHALL move the task there if the time is free of protected time (sleep, the Friday evening rule, holidays) and of calendar events with other people. IF it overlaps other TimeBlocker tasks that have not started, THEN THE SYSTEM SHALL move those tasks to the nearest later free slot (then the nearest earlier one, then any free slot of the same week), in order of start time, keeping the constraints in R3. Tasks that are done, in progress, or already started SHALL NOT be moved; the edit is rejected if it overlaps one.
3. IF any displaced task cannot be placed, THEN THE SYSTEM SHALL change nothing and show which task would not fit. Otherwise THE SYSTEM SHALL save the new time and the new times of the displaced tasks together, update Google Calendar and reminders for all of them, tell the user what moved ("Moved <task>. Also moved <A> and <B>."), and offer Undo for 10 seconds that restores every moved task.
4. THE SYSTEM SHALL update the plan summary list after the change, and SHALL record each moved task's previous slot so the dashboard "Moved tasks" count includes them.

### R30. Defaults, holidays, and distraction apps
**User Story:** As the user, I want sensible defaults without maintaining lists myself.

#### Acceptance Criteria
1. THE SYSTEM SHALL use the "spread" planning mode by default, including for installations that never changed the setting, and SHALL keep the option to switch in settings.
2. THE SYSTEM SHALL take public holidays from the Google public holiday calendar of the user's country (country taken from the phone's region, defaulting to Canada), SHALL read them for the current and next year through the Calendar API at most once a week, cache them on the device, and SHALL treat them as holidays in planning. The settings screen SHALL NOT offer adding or removing holidays and SHALL show the country and the next holiday instead. IF the holiday calendar cannot be read, THEN THE SYSTEM SHALL plan without holidays and retry later.
3. THE SYSTEM SHALL treat a built-in list of social media apps as distraction apps for sleep scoring, miss-risk prompts, and the review, including Instagram, Facebook, Messenger, X (Twitter), TikTok, Reddit, Snapchat, Pinterest, Threads, Tumblr, LinkedIn, Discord, Telegram, and YouTube, in addition to any apps the user adds in settings.

### R31. Calendar sync for tasks added outside the app
**User Story:** As the user, I want to know how quickly changes I make in Google Calendar show up, and I want next week's meetings to be considered too.

#### Acceptance Criteria
1. THE SYSTEM SHALL sync when the app opens, when it returns to the foreground, on pull to refresh, right after planning, and in the background about every 30 minutes (Android may delay background runs).
2. THE SYSTEM SHALL read the events of both the current week and the next Sunday to Saturday week on every sync, cache them per week, and use both caches when planning, so that meetings added outside the app are seen before the user plans.
3. THE SYSTEM SHALL treat events created outside the app as busy time (shown dashed in the week view, able to trigger "Will you miss this block?" prompts), not as tasks, and SHALL plan around them.
4. WHEN the user plans a week, THE SYSTEM SHALL read that week's events from Google Calendar first (within the existing 15-second budget) so the plan uses the freshest calendar.

### R32. AI assistant backend (Amazon Bedrock, Canada only)
**User Story:** As the owner, I want a small, locked-down cloud service that runs the AI model for me, so that the phone never holds AWS credentials and nobody else can use it.

#### Acceptance Criteria
1. THE SYSTEM SHALL provide an HTTPS API (API Gateway HTTP API plus one Lambda function) in the owner's AWS account in ca-central-1 with two POST routes, `/ai/parse-tasks` and `/ai/application-help`, and SHALL call Amazon Bedrock only through the Converse API using the Canada-only inference profile `ca.amazon.nova-lite-v1:0`, so that requests are processed in Canadian regions.
2. THE SYSTEM SHALL accept a request only when it carries a Google ID token that the API Gateway JWT authorizer accepts (issuer `https://accounts.google.com`, audience equal to the app's Android OAuth client id) AND whose `sub` claim is on the owner's allow-list configured at deploy time. A valid Google token with any other `sub` SHALL receive 403 and SHALL NOT reach Bedrock.
3. THE SYSTEM SHALL limit cost and abuse: stage throttling of 2 requests per second with a burst of 5, no reserved Lambda concurrency (the account quota is 10, which would make a reservation fail), a request body limit of 16 KB, a fixed `maxTokens` on every model call (700 for parse-tasks, 900 for application-help), a Lambda timeout of 25 seconds, an AWS Budget of 5 USD per month that emails the owner at 50% and 100%, and a CloudWatch alarm on Lambda errors.
4. THE SYSTEM SHALL NOT log request text, model output, or tokens; logs SHALL contain only the route, the status, the model latency, and the token counts. Bedrock model invocation logging SHALL stay off.
5. THE SYSTEM SHALL send the model only the text the user submitted for the request (task lines, or the pasted job description, question, and background). It SHALL NEVER include phone usage, sleep data, calendar events, or tokens.
6. THE SYSTEM SHALL be defined as code in `packages/infra` as a new stack named `TimeBlockerAiStack`, SHALL be testable offline (unit tests with a mocked Bedrock client, CDK assertions on the synthesized template), and SHALL be deployed only by the owner running the documented commands with the `timeblocker-deploy` profile.

### R33. Smarter list reading
**User Story:** As the user, I want messy task lines understood even when the built-in rules cannot read them.

#### Acceptance Criteria
1. WHERE the AI assistant is switched on in settings, WHEN the user submits a task list, THE SYSTEM SHALL send the task titles (up to 40 titles of 200 characters, taken after the built-in parser has removed dates, times, counts, and durations) to `/ai/parse-tasks` and SHALL use the reply only to improve the `category` and to set a `kind` (`task`, `application`, `email`, `study`, `workout`, `errand`, `other`) for each title. Titles, dates, times, deadlines, counts, and durations SHALL continue to come from the built-in parser (R15, R20, R22, R28), which is more reliable, and SHALL NOT be changed by the model. The `kind` SHALL be stored on the task and its blocks.
2. THE SYSTEM SHALL ask the model for structured output through the Converse tool-use schema and SHALL validate the reply on the server and again on the phone (types, allowed category values, same number of lines, title not empty and not longer than 120 characters); an invalid reply SHALL be discarded and the built-in result used.
3. THE SYSTEM SHALL wait at most 6 seconds for the reply. On any failure (offline, timeout, 4xx, 5xx, invalid reply, switched off) THE SYSTEM SHALL plan the list with the built-in parser exactly as it does today, without an error message to the user.
4. THE SYSTEM SHALL use a model-proposed category only when the built-in parser fell back to the default category ("Misc" without a keyword or history match) for that line, and SHALL never replace a category that came from the user, history, or a keyword.

### R34. Helpful-start drafts and application help
**User Story:** As the user, I want a head start on tasks like "email prof" or "apply to job xyz", with talking points I can trust.

#### Acceptance Criteria
1. WHERE the AI assistant is switched on, THE SYSTEM SHALL show a "Help me start" button on the detail screen of a block whose `kind` is `application`, `email`, or `study`, or whose title contains a word such as apply, application, email, draft, write, outline, or plan.
2. FOR an application block, THE SYSTEM SHALL open an "Application helper" screen with fields for the job posting or description (up to 6,000 characters), the question to answer (up to 600 characters), and the user's background (up to 3,000 characters, saved on the phone only, editable in settings under "About me for applications"), and a "Get talking points" button. It SHALL also offer "Outline my application checklist" when no question is entered.
3. THE SYSTEM SHALL return 4 to 6 talking points, each carrying a short quote copied from the user's background that supports it. The server SHALL verify that each quote appears in the background text (case-insensitive, whitespace-normalized); a point whose quote cannot be found SHALL be removed and replaced by a line "Add your own example for: <topic>". THE SYSTEM SHALL then offer a draft answer of at most 120 words built only from the verified points, with bracketed placeholders for missing details, and SHALL label the screen "Draft: check every claim before you use it."
4. THE SYSTEM SHALL NEVER present invented experience as fact, SHALL instruct the model to use only the background text, and SHALL show a plain "Nothing in your background matches this question yet" message with suggested questions to answer when no point can be verified.
5. FOR email and study blocks, THE SYSTEM SHALL offer a short draft (an email of at most 120 words from a one-line intent the user types, or a study schedule of at most 6 steps), using the same `/ai/application-help` route with a `mode` field.
6. THE SYSTEM SHALL let the user copy the result to the clipboard; it SHALL NOT store model output on the phone unless the user taps "Save to this task", which stores it in the block's notes on the phone.

### R35. AI settings, token handling, and failure behavior
**User Story:** As the user, I want to control the AI feature and know it never breaks the app.

#### Acceptance Criteria
1. THE SYSTEM SHALL provide a settings section "AI assistant" with an on/off switch (off by default), the text "Sends only the text you submit to your private AI service in Canada. Never your phone usage, sleep, or calendar.", the service address field (read from build configuration, shown read-only), and a "Your Google ID" row showing the sign-in `sub` so the owner can add it to the allow-list.
2. THE SYSTEM SHALL obtain a fresh Google ID token for each AI call through the token refresh already in use, keep it only in memory, never write it to storage or logs, and refresh it when it is within 60 seconds of expiring. IF no ID token can be obtained, THEN THE SYSTEM SHALL treat the call as failed (R33.3).
3. THE SYSTEM SHALL ask Google for the id token with the `openid profile` scopes already requested, SHALL send it as a Bearer token over HTTPS to the configured address only, and SHALL add the AI host to the structural test's allowed hosts (the amazonaws.com API endpoint of the owner's API) without allowing any other new host.
4. THE SYSTEM SHALL work fully with the assistant off or the service unreachable; no screen SHALL block on an AI call for more than 6 seconds except the Application helper, which shows a progress indicator for up to 25 seconds and then a retry message.
