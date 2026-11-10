# @timeblocker/mobile — setup, build, and on-device checklist

TimeBlocker's Android app (bare React Native 0.88.1, New Architecture + Hermes).
In on-device mode it runs entirely on the phone: no AWS account, no backend, and
nothing paid. Every tool and service below is free.

The code was written and tested with Node only. Building the APK, installing it,
and running the on-device checklist are manual steps for you, in this order:

1. [Prerequisites](#1-prerequisites)
2. [Google Cloud OAuth client](#2-google-cloud-oauth-client-free)
3. [Paste the client id](#3-paste-the-client-id-into-srcconfigts)
4. [Install, build, and run](#4-install-build-and-run)
5. [First-run permissions](#5-first-run-permissions)
6. [Tests that run without Android](#6-tests-that-run-without-android)
7. [Manual on-device checklist](#7-manual-on-device-checklist)
8. [Troubleshooting](#8-troubleshooting)
9. [Privacy](#9-privacy)

Facts used throughout (from this repo):

| Item | Value | Where |
| --- | --- | --- |
| Android package / application id | `com.timeblocker.app` | `android/app/build.gradle`, `src/config.ts` |
| OAuth redirect URI | `com.timeblocker.app:/oauth2redirect` | `src/config.ts`; scheme set by `manifestPlaceholders = [appAuthRedirectScheme: "com.timeblocker.app"]` |
| OAuth scope | `https://www.googleapis.com/auth/calendar` | `src/config.ts` |
| Client id placeholder | `REPLACE_WITH_ANDROID_CLIENT_ID.apps.googleusercontent.com` | `src/config.ts` |
| SDK levels | `compileSdk 37`, `targetSdk 36`, `minSdk 24`, Build-Tools `37.0.0`, NDK `27.1.12297006` | `android/build.gradle` |
| Gradle | 9.4.1 (wrapper, downloaded on first build) | `android/gradle/wrapper/gradle-wrapper.properties` |
| Debug signing key | `android/app/debug.keystore` (the public React Native debug key) | `android/app/build.gradle` |

## 1. Prerequisites

You need Node, Android Studio (which brings a JDK, the Android SDK, and the
emulator), and a phone or emulator.

### Node 22.13 or newer

React Native 0.88.1 declares `node: ^22.13.0 || ^24.3.0 || >= 26.0.0`. Node 22.11
mostly works but prints `EBADENGINE` warnings, so upgrade. With
[nvm](https://github.com/nvm-sh/nvm):

```bash
nvm install 22        # latest 22.x (22.13+)
nvm use 22
node -v               # v22.13.0 or later
```

### Android Studio, JDK, and SDK

1. Install [Android Studio](https://developer.android.com/studio) (free) and run
   its setup wizard with the default components (Android SDK, SDK Platform,
   Android Virtual Device).
2. JDK: React Native recommends **JDK 17**. Gradle 9 and AGP 9 need at least
   JDK 17. Android Studio bundles a JDK (JetBrains Runtime, currently 21) at
   `/Applications/Android Studio.app/Contents/jbr/Contents/Home`; point
   `JAVA_HOME` at it (below). If Gradle fails with a JDK-version error, install
   JDK 17 instead (`brew install --cask zulu@17`, free) and point `JAVA_HOME` at
   `/Library/Java/JavaVirtualMachines/zulu-17.jdk/Contents/Home`.
3. In Android Studio open **Settings → Languages & Frameworks → Android SDK**
   (or **More Actions → SDK Manager** on the welcome screen), tick
   **Show Package Details**, and install:
   - **SDK Platforms:** Android SDK Platform **37** (the `compileSdk`). Also a
     **Google Play** system image (API 34 or newer) if you plan to use the emulator.
   - **SDK Tools:** Android SDK Build-Tools **37.0.0**, Android SDK
     Platform-Tools, Android SDK Command-line Tools (latest), NDK (Side by side)
     **27.1.12297006**, and CMake.

   If one of these isn't installed, the first Gradle build usually downloads it
   for you once the SDK licenses are accepted
   (`$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager --licenses`).
4. Add these lines to `~/.zshrc`, then run `source ~/.zshrc`:

   ```bash
   export JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home"
   export ANDROID_HOME="$HOME/Library/Android/sdk"
   export PATH="$JAVA_HOME/bin:$PATH"
   export PATH="$PATH:$ANDROID_HOME/emulator:$ANDROID_HOME/platform-tools"
   ```

   Check with `java -version`, `adb version`, and `echo $ANDROID_HOME`.
   Optional: `npx react-native doctor` (from `packages/mobile`) reports anything
   still missing.

### A phone or an emulator

- **Phone:** Settings → About phone → tap **Build number** 7 times to unlock
  Developer options, then Settings → System → Developer options → turn on
  **USB debugging**. Connect over USB, accept the "Allow USB debugging" prompt,
  and confirm `adb devices` lists it as `device`.
- **Emulator:** Android Studio → **Device Manager** → create a device with a
  **Google Play** image, API 34 or newer. Sign in to a Google account on it so
  the Google sign-in sheet works.

## 2. Google Cloud OAuth client (free)

The Google Calendar API is free and needs no billing account. The console labels
below follow the current **Google Auth Platform** menu (Branding, Audience,
Data access, Clients); older consoles call this the **OAuth consent screen**.

1. **Create a project.** Open the
   [Google Cloud Console](https://console.cloud.google.com/), project picker →
   **New project** (e.g. `timeblocker`).
2. **Enable the API.** **APIs & Services → Library** → search
   **Google Calendar API** → **Enable**.
3. **Consent screen.** **Google Auth Platform** (APIs & Services → OAuth consent
   screen):
   - **Branding:** app name `TimeBlocker`, your email as support and developer
     contact.
   - **Audience:** user type **External**. While it's in Testing, add your own
     Google account under **Test users**.
   - **Data access → Add or remove scopes:** add
     `https://www.googleapis.com/auth/calendar`. The app also requests the basic
     profile (your name) via `openid` and `profile`. These two are
     non-sensitive scopes that need no verification, and Google adds them
     automatically. Save. After updating to a version that asks for them, sign
     out and sign in once so the dashboard can greet you by name.
4. **Publish to production.** **Audience → Publish app → In production.**
   Refresh tokens for apps left in Testing expire after 7 days, which would sign
   you out every week. Because the Calendar scope is sensitive and the app is
   not verified, sign-in shows **"Google hasn't verified this app"**. That's
   expected for a personal app: tap **Advanced → Go to TimeBlocker (unsafe)**.
   You don't need to submit for verification for personal use.
5. **Get the SHA-1 of the key that signs your APK.** Debug builds (and release
   builds until you set up a personal key, see step 4.4) are signed with
   `android/app/debug.keystore`, *not* `~/.android/debug.keystore`. From
   `packages/mobile`:

   ```bash
   keytool -list -v -keystore android/app/debug.keystore \
     -alias androiddebugkey -storepass android -keypass android
   ```

   Copy the `SHA1:` line. (`cd android && ./gradlew signingReport` prints the
   same thing for every variant.) This key is the public React Native debug
   key: fine to get started on your own phone, but for everyday use switch to a
   personal key (4.4) and register its SHA-1 instead.
6. **Create the Android client.** **Clients → Create client** (Credentials →
   Create credentials → OAuth client ID) → application type **Android**:
   - Package name: `com.timeblocker.app`
   - SHA-1 certificate fingerprint: the value from step 5
   - **Create.** There is no client secret, and the app doesn't use one (PKCE).
7. **Enable the custom URI scheme.** Open the new client → **Advanced settings**
   → tick **Enable custom URI scheme** → **Save**. Without it Google rejects
   the redirect `com.timeblocker.app:/oauth2redirect`. Android clients have no
   redirect-URI field; the redirect is derived from the package name.
8. Copy the **Client ID** (it ends in `.apps.googleusercontent.com`).

## 3. Paste the client id into `src/config.ts`

In `src/config.ts`, change the `clientId` line inside `GOOGLE_OAUTH` to your id:

```ts
export const GOOGLE_OAUTH: GoogleOAuthConfig = {
  issuer: 'https://accounts.google.com',
  clientId: '1234567890-abc123.apps.googleusercontent.com', // your Android client id
  redirectUrl: `${APPLICATION_ID}:/oauth2redirect`,
  scopes: ['https://www.googleapis.com/auth/calendar'],
  usePKCE: true,
};
```

Leave `GOOGLE_OAUTH_CLIENT_ID_PLACEHOLDER` itself alone. `isOAuthConfigured()`
compares against it, and until the id differs from the placeholder and ends
with `.apps.googleusercontent.com`, sign-in shows "Google OAuth client id is not
configured". A client id isn't a secret, but there's nothing else to add: no
client secret and no API key.

## 4. Install, build, and run

### 4.1 Install dependencies

Packages are linked with `file:` references and each one has its own
`package-lock.json`, so install every package the app depends on, then the app:

```bash
cd packages
for p in scheduling-engine usage-metrics reminders calendar-integration flows app-core mobile; do
  (cd "$p" && npm ci)
done
```

(`npm install` works too; `npm ci` installs exactly what the lockfiles pin.)
`infra` isn't needed for the app.

### 4.2 Build the workspace packages

```bash
cd packages/mobile
npm run prebundle
```

`prebundle` runs `npm run build` (TypeScript → `dist/`) in scheduling-engine,
usage-metrics, reminders, calendar-integration, flows, and app-core, in that
order. Metro bundles their `dist/` output, so rerun it whenever you change one of
those packages.

### 4.3 Run a debug build (two terminals)

```bash
# Terminal 1 (packages/mobile): Metro bundler
npx react-native start

# Terminal 2 (packages/mobile): build, install, and launch on the phone/emulator
npx react-native run-android
```

`npm start` and `npm run android` are the same commands. The first build takes a
while (Gradle 9.4.1, the Android dependencies, and the NDK). It also compiles the
Kotlin sources in `packages/reminders/android` and `packages/usage-metrics/android`.
A debug build loads JavaScript from Metro, so keep Metro running and the phone
connected (or on the same Wi-Fi).

### 4.4 Standalone APK (no Metro needed)

A release APK bundles the JavaScript, so it runs without your Mac:

```bash
cd packages/mobile/android
./gradlew assembleRelease
adb install -r app/build/outputs/apk/release/app-release.apk
```

Signing (see `android/app/build.gradle`):

- **Until you configure a personal key,** release builds fall back to the public
  `android/app/debug.keystore` (the `TODO(signing)` in `build.gradle`). Anyone can
  reuse that key's SHA-1, so treat this as a getting-started setup only.
- **Personal key (recommended):** create it once, outside the repo, and never
  commit it or its passwords:

  ```bash
  keytool -genkeypair -v -keystore ~/.android/timeblocker.keystore \
    -alias timeblocker -keyalg RSA -keysize 2048 -validity 10000
  ```

  Then add all four properties to your user-level `~/.gradle/gradle.properties`
  (not `android/gradle.properties`, which is committed):

  ```properties
  TIMEBLOCKER_UPLOAD_STORE_FILE=/Users/<you>/.android/timeblocker.keystore
  TIMEBLOCKER_UPLOAD_KEY_ALIAS=timeblocker
  TIMEBLOCKER_UPLOAD_STORE_PASSWORD=...
  TIMEBLOCKER_UPLOAD_KEY_PASSWORD=...
  ```

  When all four are set, `assembleRelease` signs with this key. Get its SHA-1
  with `keytool -list -v -keystore ~/.android/timeblocker.keystore -alias timeblocker`
  and register it with Google: edit the Android client's SHA-1, or create a
  second Android client for it and paste that client id into `src/config.ts`.
- An APK signed with a different key can't install over the old one. Run
  `adb uninstall com.timeblocker.app` first (this deletes the app's local data).

`./gradlew assembleDebug` also works (`app/build/outputs/apk/debug/app-debug.apk`),
but a debug APK still expects Metro.

## 5. First-run permissions

1. **Sign in** with the Google account you added in step 2 and allow Calendar
   access. If you untick the Calendar permission, the app says
   "TimeBlocker needs Calendar access to work." and doesn't sign in.
2. **Notifications** (Android 13+): the app asks once. Allow it. If you denied
   it, use **Settings → Notifications → Open settings** in the app.
3. **Exact alarms:** on Android 13+ `USE_EXACT_ALARM` is granted at install. On
   Android 12/12L it can be revoked. If Settings shows
   **"Reminder timing may vary"**, tap **Open alarm settings** and allow
   *Alarms & reminders*.
4. **Usage access:** Android grants this from a system screen, not a dialog. In
   the app, **Settings → Usage access → Open settings**, pick TimeBlocker, and
   turn on *Permit usage access*. Return to the app and the row updates.
5. **Battery:** to keep background sync and reminders reliable, set Android
   Settings → Apps → TimeBlocker → **Battery** to **Unrestricted** (wording
   varies by phone maker). Some brands (Samsung, Xiaomi, OnePlus) also need
   TimeBlocker removed from "sleeping apps" or allowed to auto-start.

### Samsung Health sleep (Health Connect)

TimeBlocker reads sleep sessions from Android Health Connect, where Samsung
Health writes them. Optional; without it the sleep score uses phone usage only.

- **Phone prerequisites:** Samsung Health 6.22.5 or newer, and Health Connect
  (built into Android 14+; a Play Store app on Android 13 and below). In
  **Samsung Health → Settings → Health Connect**, allow Samsung Health to
  *write* sleep.
- **Permission:** the app asks for *read* access to sleep only, through the
  Health Connect permission screen (opened from the Sleep data row in Settings).
  You can revoke it in Health Connect → App permissions → TimeBlocker.
- **Debug builds only:** an extra `WRITE_SLEEP` permission lets the demo-data
  tools write fake sleep sessions into Health Connect (and delete them again).
  Release builds neither declare it nor contain that code.
- **Privacy:** sleep sessions are read on the phone, used for the score, and
  never uploaded (R25.6). Only start, end, and minutes asleep are used.

## 6. Tests that run without Android

No JDK, SDK, emulator, or phone is needed for these.

| Package | Tests | Type-check |
| --- | --- | --- |
| `scheduling-engine`, `usage-metrics`, `reminders`, `calendar-integration`, `flows`, `app-core` | `npm test` (Vitest) | `npm run typecheck` |
| `mobile` | `npm test` or `npx jest` (Jest, mocked native modules) | `npm run typecheck` |
| `infra` (backend mode only) | `npm test` (Vitest) | `npm run typecheck` |

Run `npm run prebundle` in `mobile` first so the Jest suite resolves the
packages' fresh `dist/` builds. The Kotlin modules, real alarm timing, Doze,
AppAuth Custom Tabs, Keystore encryption, and Hermes `Intl` time zones can't be
tested under Node. The checklist below covers them.

## 7. Manual on-device checklist

Run this on the phone after the first successful install.

1. Debug APK installs and launches to SignIn with no AWS or paid account (R11.1, R11.2).
2. Cancel the Google sheet → error shown and retry works (R11.3). Untick the Calendar permission on consent → "TimeBlocker needs Calendar access to work.", no session (R12.1, R12.11).
3. Sign in → the home dashboard (greeting and four widgets). Tap Week calendar for the current Toronto week. Set the phone to another time zone and confirm the week and times don't shift (Hermes `Intl`).
4. Open Add this week's tasks. The first line reads "Provide a list of your tasks this week, one on each line." Paste a JSON array and plain lines; try empty, `[oops`, and 101 lines (R11.4-R11.6). Submit → blocks appear in Google Calendar with 🧱, category colors, and no Google pop-ups (R4, R14.9).
5. Block 16+ minutes out → reminder at T−15 with three actions. Tap each action with the app swiped away; the state updates within 5 s and the app doesn't open (R13.1, R13.3, R13.4).
6. Create a block 5 minutes out → immediate reminder (R13.11). Add a meeting with a guest overlapping a block in Google Calendar, pull to refresh → one prompt; refresh again → no repeat (R13.5, R14.5). Yes → moved plus Undo; No → unchanged (R13.6, R13.12).
7. Move and delete a 🧱 event in Google Calendar → the app follows after refresh (R14.6, R14.7). Airplane mode → move a block → banner; back online → refresh, the event updates and the banner clears (R14.10, R14.11).
8. Deny notifications → bell indicators in the week view (R13.9). Revoke exact alarms (Android 12) or check settings → "Reminder timing may vary"; re-grant → note clears on return (R13.10).
9. Reboot the phone → pending reminders still fire. Leave the phone idle about 1 hour → background sync ran (Last synced time) (R14.3).
10. Settings changes survive force-close (R11.11); permission rows reflect changes after returning from system settings (R11.12).
11. Revoke TimeBlocker access at myaccount.google.com → next sync shows the sign-in prompt and local blocks remain (R12.5, R14.12).
12. Saturday review shows the sections and the paste/type prompt (R11.10).
13. With another app open, a block reminder appears as a heads-up banner at the top of the screen, shows the start time and the forecast line, and has exactly two buttons ("I'll be there", "Move to later this week") (R17.1). If Android notification settings for TimeBlocker list both an old and a new "Block & meeting reminders" channel, set the one that remains to "Pop on screen"/Urgent.
14. The dashboard shows "Hi <your first name>!" (or "Hi there!"), a short message, and four cards: tasks completed, sleep score, fitness score, moved tasks. Pull down to refresh (R18).
15. With usage access granted, leave the phone alone overnight: the next morning the sleep card shows a score (a dash with "Allow usage access to see this" while access is denied) (R19).
16. Submit "Gym 3x" (plus a couple of other lines) → three Gym blocks on three different days, titled "Gym (1 of 3)" and so on (R20).

17. After Submit the plan summary opens: "Added N tasks to this week" with each task's title, Toronto day and time, and category color, sorted by start. Back goes to the dashboard; "View my week" opens the week (R21.1).
18. Submit more than fits (for example "Deep work 40 h") → "Didn't fit this week" lists the leftovers with minutes. "Move these to next week" opens a next-week summary ("Added N tasks to next week") and the events appear in Google Calendar. If they still don't fit, only "Leave them out" is offered with "These still don't fit next week". "Leave them out" returns to the week with a short confirmation (R21.2, R21.3).
19. Submit a line such as "Sleep 8h" → it is not planned and the summary shows "Skipped: sleep is already protected" (R20.7).
20. On Add this week's tasks tap "Clear this week's tasks" → a confirmation. Cancel changes nothing. Clear removes tasks that haven't happened yet (blocks, Google Calendar events, reminders) and shows "Removed N tasks. Kept M as history."; done, missed, and skipped tasks stay in the Saturday review. With nothing to clear it says "Nothing to clear." (R21.4, R21.5, R22.3).
21. Settings > Sleep data shows "Samsung Health sleep". Tap "Connect Samsung Health sleep" and allow it in Health Connect → the row reads "Connected". If Health Connect is missing or old it says "Health Connect needs an update" (R25.1).
22. After a night with Samsung Health sleep recorded, open the dashboard: the sleep card caption says "Samsung Health + phone use" (R25.4).
23. Demo walkthrough (debug build only; the release APK has no Demo data section): Settings > Demo data > "Load demo data" ("Loaded N blocks and 14 nights."). Turn on "Use demo screen usage", then open the Dashboard → sleep score and caption appear. Plan a task and see it placed using the learned history. Optionally "Write demo sleep to Health Connect". Finish with "Remove demo data" and confirm; the dashboard returns to your real data (R24).
24. AI assistant (after you deploy the AI service and paste `ApiUrl` into `src/config.ts`): Settings > AI assistant shows the service host, and "Your Google ID" > Show reveals your ID. Add that ID to the service allow-list, switch "AI assistant" on, and write a few lines under "About me for applications" (R35.1).
25. Open a block titled "Apply to <company>" → "Help me start" appears. Paste a job posting, ask a question, tap "Get talking points". Each point shows a muted quote from your background, missing items show under "Add your own example", and the banner reads "Draft: check every claim before you use it." (R34.2-R34.4).
26. Try an Email block ("Draft the email") and a Study block ("Plan my study steps"). Tap Copy and paste elsewhere, then "Save to this task" → the block detail shows a Notes card (R34.5, R34.6).
27. Airplane mode → "Get talking points" shows "You're offline. Try again when you're connected." Switch the assistant off in Settings and confirm "Help me start" disappears and the rest of the app works unchanged (R35.4).

## 8. Troubleshooting

**"Google OAuth client id is not configured"** on SignIn. `src/config.ts` still
has the placeholder. Do step 3, then reload (press `r` in Metro) or rebuild the
release APK.

**`Error 400: invalid_request`, "Custom URI scheme is not enabled", or a
redirect/`redirect_uri` mismatch.** Turn on **Enable custom URI scheme** in the
Android client's Advanced settings (step 2.7). Also check that the package name
is exactly `com.timeblocker.app` and the SHA-1 matches the key that signed the
installed APK (`./gradlew signingReport`). Console changes can take a few
minutes to apply.

**"Access blocked: TimeBlocker has not completed the Google verification
process."** The consent screen is still in Testing and the account you're using
isn't a test user. Add it under **Audience → Test users**, or publish the app
(step 2.4). "Google hasn't verified this app" (with an Advanced link) is the
normal warning after publishing.

**Signed out roughly every 7 days (`invalid_grant`).** The consent screen is in
Testing, where refresh tokens expire after 7 days. Publish it **In production**
(step 2.4) and sign in again.

**Kotlin compile errors on the first Gradle build.** The native modules in
`packages/reminders/android` and `packages/usage-metrics/android` were written
without a JDK/Android SDK. See the "VERIFY ON FIRST GRADLE BUILD" block at the
top of `packages/reminders/android/AlarmStore.kt`. Common fixes:
- Unresolved `NotificationCompat` / `NotificationManagerCompat` / `ContextCompat`:
  add a pinned `implementation "androidx.core:core-ktx:<version>"` to the
  `dependencies` block of `android/app/build.gradle`.
- A lint warning that the directory doesn't match the package
  `com.timeblocker.reminders` is harmless.
- At runtime, `NativeModules.TimeBlockerAlarms` must resolve both in the UI and in
  the `TimeBlockerNotificationAction` headless task. It's a legacy module running
  through the New Architecture interop layer.
- If the notification icon (`android.R.drawable.ic_popup_reminder` placeholder)
  renders poorly, swap it for a monochrome app drawable.

**`npm warn EBADENGINE ... required: { node: '^22.13.0 ...' }`.** Node is older
than React Native 0.88.1 needs. `nvm install 22 && nvm use 22`, then delete
`node_modules` and run `npm ci` again.

**Stale JavaScript, "Unable to resolve module", or changes not showing up.** Run
`npm run prebundle`, then restart Metro with a clean cache:
`npx react-native start --reset-cache`. For native build weirdness,
`cd android && ./gradlew clean`.

**`adb devices` shows nothing or `unauthorized`.** Use a data-capable USB cable,
accept the USB-debugging prompt on the phone, and try `adb kill-server && adb devices`.

**`INSTALL_FAILED_UPDATE_INCOMPATIBLE`.** The installed app was signed with a
different key. Run `adb uninstall com.timeblocker.app` and install again.

**Gradle "Unsupported class file major version" or a JDK error.** `JAVA_HOME`
points at the wrong JDK. Use the Android Studio JBR or JDK 17 (section 1) and
open a new terminal.

## 9. Privacy

- On-device mode keeps everything on the phone: to-do items, blocks, settings,
  and usage summaries live in local storage. Google OAuth tokens are stored in
  Android Keystore-backed storage (`react-native-keychain`).
- The app's only network peers are Google's OAuth endpoints and the Google
  Calendar API, using the single scope `https://www.googleapis.com/auth/calendar`.
  There is no TimeBlocker server, no AWS, and no analytics.
- Phone-usage data is read and aggregated on the device and never uploaded.
- The app handles no financial data of any kind.
