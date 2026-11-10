/**
 * @jest-environment node
 *
 * Static verification of the Android project files (task 23.4; R11.1, R13.8,
 * R13.10). There is no Gradle build in CI, so these tests read the manifest,
 * `app/build.gradle`, `MainApplication.kt` and the TimeBlockerAlarms Kotlin
 * sources (`packages/reminders/android`) as text and assert the entries the
 * app relies on are present and consistent with the TypeScript contract in
 * `packages/reminders/src/nativeModule.ts`.
 */
import fs from 'node:fs';
import path from 'node:path';

const MOBILE_DIR = path.resolve(__dirname, '..');
const PACKAGES_DIR = path.resolve(MOBILE_DIR, '..');
const ANDROID_APP = path.join(MOBILE_DIR, 'android', 'app');
const MANIFEST = path.join(ANDROID_APP, 'src', 'main', 'AndroidManifest.xml');
const BUILD_GRADLE = path.join(ANDROID_APP, 'build.gradle');
const MAIN_APPLICATION = path.join(
  ANDROID_APP,
  'src/main/java/com/timeblocker/app/MainApplication.kt',
);
const REMINDERS_ANDROID = path.join(PACKAGES_DIR, 'reminders', 'android');
const REMINDERS_NATIVE_TS = path.join(
  PACKAGES_DIR,
  'reminders',
  'src',
  'nativeModule.ts',
);
const KOTLIN_PACKAGE = 'com.timeblocker.reminders';

const read = (file: string): string => fs.readFileSync(file, 'utf8');

// --- Minimal XML tree (comments/prolog skipped, attributes parsed) -----------

interface XmlElement {
  name: string;
  attrs: Record<string, string>;
  children: XmlElement[];
}

const TOKEN =
  /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<(\/?)([\w:.-]+)((?:\s+[\w:.-]+\s*=\s*"[^"]*")*)\s*(\/?)>/g;
const ATTR = /([\w:.-]+)\s*=\s*"([^"]*)"/g;

function parseXml(xml: string): XmlElement {
  const root: XmlElement = { name: '#root', attrs: {}, children: [] };
  const stack: XmlElement[] = [root];
  for (const m of xml.matchAll(TOKEN)) {
    const [, closing, name, rawAttrs, selfClosing] = m;
    if (!name) continue; // comment or prolog
    const top = stack[stack.length - 1]!;
    if (closing) {
      if (top.name !== name) {
        throw new Error(`Mismatched </${name}>, expected </${top.name}>`);
      }
      stack.pop();
      continue;
    }
    const attrs: Record<string, string> = {};
    for (const a of (rawAttrs ?? '').matchAll(ATTR)) attrs[a[1]!] = a[2]!;
    const el: XmlElement = { name, attrs, children: [] };
    top.children.push(el);
    if (!selfClosing) stack.push(el);
  }
  if (stack.length !== 1) throw new Error('Unclosed XML element');
  return root;
}

const childrenNamed = (el: XmlElement, name: string): XmlElement[] =>
  el.children.filter(c => c.name === name);

function only(els: XmlElement[], what: string): XmlElement {
  if (els.length !== 1) {
    throw new Error(`Expected exactly one ${what}, found ${els.length}`);
  }
  return els[0]!;
}

// --- Kotlin helpers ---------------------------------------------------------

/** Kotlin source with block and line comments removed (keeps `"x://y"`). */
function stripKotlinComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:"])\/\/.*$/gm, '$1');
}

const kotlin = (file: string): string =>
  stripKotlinComments(read(path.join(REMINDERS_ANDROID, file)));

function reactMethodNames(src: string): string[] {
  return [...src.matchAll(/@ReactMethod(?:\([^)]*\))?\s+fun\s+(\w+)\s*\(/g)].map(
    m => m[1]!,
  );
}

/** Method names declared in a TS interface body (comments removed). */
function tsInterfaceMethods(src: string, name: string): string[] {
  const start = src.indexOf(`export interface ${name} {`);
  if (start < 0) throw new Error(`interface ${name} not found`);
  const end = src.indexOf('\n}', start);
  const body = src
    .slice(start + `export interface ${name} {`.length, end)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '');
  return [...body.matchAll(/^\s*(\w+)\s*\(/gm)].map(m => m[1]!);
}

// --- AndroidManifest.xml ----------------------------------------------------

describe('AndroidManifest.xml', () => {
  const manifest = only(
    childrenNamed(parseXml(read(MANIFEST)), 'manifest'),
    '<manifest>',
  );
  const application = only(
    childrenNamed(manifest, 'application'),
    '<application>',
  );
  const permissions = childrenNamed(manifest, 'uses-permission');
  const permission = (name: string): XmlElement =>
    only(
      permissions.filter(p => p.attrs['android:name'] === name),
      `<uses-permission ${name}>`,
    );

  it.each([
    'android.permission.INTERNET',
    'android.permission.POST_NOTIFICATIONS',
    'android.permission.USE_EXACT_ALARM',
    'android.permission.SCHEDULE_EXACT_ALARM',
    'android.permission.RECEIVE_BOOT_COMPLETED',
    'android.permission.PACKAGE_USAGE_STATS',
  ])('declares %s', name => {
    expect(permission(name)).toBeDefined();
  });

  it('limits SCHEDULE_EXACT_ALARM to Android 12/12L (maxSdkVersion 32)', () => {
    expect(
      permission('android.permission.SCHEDULE_EXACT_ALARM').attrs[
        'android:maxSdkVersion'
      ],
    ).toBe('32');
    // Override the value react-native-background-fetch merges in (maxSdkVersion 33).
    expect(
      permission('android.permission.SCHEDULE_EXACT_ALARM').attrs[
        'tools:replace'
      ],
    ).toBe('android:maxSdkVersion');
    // USE_EXACT_ALARM covers API 33+ and must not be capped.
    expect(
      permission('android.permission.USE_EXACT_ALARM').attrs[
        'android:maxSdkVersion'
      ],
    ).toBeUndefined();
  });

  it('declares PACKAGE_USAGE_STATS with tools:ignore="ProtectedPermissions"', () => {
    expect(manifest.attrs['xmlns:tools']).toBe(
      'http://schemas.android.com/tools',
    );
    expect(
      permission('android.permission.PACKAGE_USAGE_STATS').attrs['tools:ignore'],
    ).toBe('ProtectedPermissions');
  });

  const receiver = (cls: string): XmlElement =>
    only(
      childrenNamed(application, 'receiver').filter(
        r => r.attrs['android:name'] === `${KOTLIN_PACKAGE}.${cls}`,
      ),
      `<receiver ${cls}>`,
    );

  it.each([
    ['AlarmReceiver', 'false'],
    ['ActionReceiver', 'false'],
    ['BootReceiver', 'true'],
  ])('declares receiver %s with android:exported="%s"', (cls, exported) => {
    expect(receiver(cls).attrs['android:exported']).toBe(exported);
  });

  it('BootReceiver listens for BOOT_COMPLETED and MY_PACKAGE_REPLACED', () => {
    const filter = only(
      childrenNamed(receiver('BootReceiver'), 'intent-filter'),
      'BootReceiver <intent-filter>',
    );
    const actions = childrenNamed(filter, 'action').map(
      a => a.attrs['android:name'],
    );
    expect(actions).toEqual(
      expect.arrayContaining([
        'android.intent.action.BOOT_COMPLETED',
        'android.intent.action.MY_PACKAGE_REPLACED',
      ]),
    );
  });

  it('non-exported receivers have no intent filters', () => {
    for (const cls of ['AlarmReceiver', 'ActionReceiver']) {
      expect(childrenNamed(receiver(cls), 'intent-filter')).toHaveLength(0);
    }
  });

  it('declares the non-exported headless NotificationActionTaskService', () => {
    const service = only(
      childrenNamed(application, 'service').filter(
        s =>
          s.attrs['android:name'] ===
          `${KOTLIN_PACKAGE}.NotificationActionTaskService`,
      ),
      '<service NotificationActionTaskService>',
    );
    expect(service.attrs['android:exported']).toBe('false');
  });

  it('MainActivity has a timeblocker:// VIEW/BROWSABLE deep-link filter', () => {
    const activity = only(
      childrenNamed(application, 'activity').filter(
        a => a.attrs['android:name'] === '.MainActivity',
      ),
      '<activity .MainActivity>',
    );
    const deepLinks = childrenNamed(activity, 'intent-filter').filter(f =>
      childrenNamed(f, 'data').some(
        d => d.attrs['android:scheme'] === 'timeblocker',
      ),
    );
    const filter = only(deepLinks, 'timeblocker:// <intent-filter>');
    expect(
      childrenNamed(filter, 'action').map(a => a.attrs['android:name']),
    ).toContain('android.intent.action.VIEW');
    expect(
      childrenNamed(filter, 'category').map(c => c.attrs['android:name']),
    ).toEqual(
      expect.arrayContaining([
        'android.intent.category.DEFAULT',
        'android.intent.category.BROWSABLE',
      ]),
    );
    // The OAuth redirect scheme is handled by react-native-app-auth's merged
    // activity, not by this filter.
    expect(
      childrenNamed(filter, 'data').map(d => d.attrs['android:scheme']),
    ).not.toContain('com.timeblocker.app');
  });

  it('every declared reminders component has a Kotlin class', () => {
    const components = [
      ...childrenNamed(application, 'receiver'),
      ...childrenNamed(application, 'service'),
    ]
      .map(c => c.attrs['android:name'] ?? '')
      .filter(n => n.startsWith(`${KOTLIN_PACKAGE}.`));
    expect(components).toHaveLength(4);
    for (const fqcn of components) {
      const cls = fqcn.slice(KOTLIN_PACKAGE.length + 1);
      const src = kotlin(`${cls}.kt`);
      expect(src).toMatch(new RegExp(`^package ${KOTLIN_PACKAGE.replace(/\./g, '\\.')}$`, 'm'));
      expect(src).toMatch(new RegExp(`\\bclass ${cls}\\b`));
    }
  });
});

// --- app/build.gradle -------------------------------------------------------

describe('android/app/build.gradle', () => {
  const gradle = read(BUILD_GRADLE).replace(/^\s*\/\/.*$/gm, '');

  it('adds the reminders and usage-metrics Kotlin dirs to java.srcDirs', () => {
    const block = gradle.match(/java\.srcDirs\s*\+?=\s*\[([\s\S]*?)\]/);
    expect(block).not.toBeNull();
    const dirs = [...block![1]!.matchAll(/["']([^"']+)["']/g)].map(m => m[1]);
    expect(dirs).toEqual(
      expect.arrayContaining([
        '$rootDir/../../reminders/android',
        '$rootDir/../../usage-metrics/android',
      ]),
    );
    // $rootDir is packages/mobile/android, so these resolve to real dirs.
    const rootDir = path.join(MOBILE_DIR, 'android');
    for (const d of dirs) {
      const resolved = path.resolve(rootDir, d!.replace('$rootDir/', ''));
      expect(fs.existsSync(resolved)).toBe(true);
    }
  });

  it('sets the appAuthRedirectScheme manifest placeholder', () => {
    expect(gradle).toMatch(
      /manifestPlaceholders\s*=\s*\[[^\]]*appAuthRedirectScheme\s*:\s*["']com\.timeblocker\.app["']/,
    );
  });
});

// --- MainApplication.kt -----------------------------------------------------

describe('MainApplication.kt', () => {
  const src = stripKotlinComments(read(MAIN_APPLICATION));

  it.each([
    ['TimeBlockerAlarmsPackage', 'com.timeblocker.reminders'],
    ['RemindersPackage', 'com.timeblocker.reminders'],
    ['UsageMetricsPackage', 'com.timeblocker.usagemetrics'],
  ])('imports and registers %s', (cls, pkg) => {
    expect(src).toContain(`import ${pkg}.${cls}`);
    expect(src).toMatch(new RegExp(`\\badd\\(\\s*${cls}\\(\\)\\s*\\)`));
  });
});

// --- Kotlin TimeBlockerAlarms sources ---------------------------------------

describe('TimeBlockerAlarms Kotlin sources', () => {
  const tsContract = read(REMINDERS_NATIVE_TS);

  it.each([
    'AlarmStore.kt',
    'AlarmScheduler.kt',
    'AlarmReceiver.kt',
    'ActionReceiver.kt',
    'BootReceiver.kt',
    'NotificationActionTaskService.kt',
    'TimeBlockerAlarmsModule.kt',
    'TimeBlockerAlarmsPackage.kt',
  ])('%s is in package com.timeblocker.reminders', file => {
    expect(kotlin(file)).toMatch(/^package com\.timeblocker\.reminders$/m);
  });

  it('module is named TimeBlockerAlarms, matching the TS lookup', () => {
    const mod = kotlin('TimeBlockerAlarmsModule.kt');
    expect(mod).toMatch(/const val NAME = "TimeBlockerAlarms"/);
    expect(mod).toMatch(/override fun getName\(\): String = NAME/);
    expect(tsContract).toContain('nativeModuleProxy?.["TimeBlockerAlarms"]');
  });

  it('exposes every TimeBlockerAlarmsNativeModule method as a @ReactMethod', () => {
    const tsMethods = tsInterfaceMethods(
      tsContract,
      'TimeBlockerAlarmsNativeModule',
    );
    expect(tsMethods.sort()).toEqual(
      [
        'cancel',
        'canScheduleExactAlarms',
        'listPending',
        'notificationPermission',
        'schedule',
        'showNow',
      ].sort(),
    );
    const kotlinMethods = reactMethodNames(kotlin('TimeBlockerAlarmsModule.kt'));
    expect(kotlinMethods).toEqual(expect.arrayContaining(tsMethods));
  });

  it('@ReactMethod arities match the TS contract (plus a trailing Promise)', () => {
    const mod = kotlin('TimeBlockerAlarmsModule.kt');
    const expected: Record<string, string> = {
      schedule: 'payload: ReadableMap, fireAtMs: Double, exact: Boolean, promise: Promise',
      showNow: 'payload: ReadableMap, promise: Promise',
      cancel: 'id: String, promise: Promise',
      listPending: 'promise: Promise',
      canScheduleExactAlarms: 'promise: Promise',
      notificationPermission: 'promise: Promise',
    };
    for (const [name, params] of Object.entries(expected)) {
      const m = mod.match(
        new RegExp(`@ReactMethod\\s+fun\\s+${name}\\s*\\(([^)]*)\\)`),
      );
      expect(m?.[1]?.replace(/\s+/g, ' ').trim()).toBe(params);
    }
  });

  it('headless task key matches between Kotlin and TS', () => {
    const service = kotlin('NotificationActionTaskService.kt');
    const kt = service.match(/const val HEADLESS_TASK_KEY = "([^"]+)"/)?.[1];
    const ts = tsContract.match(
      /export const TIMEBLOCKER_ALARMS_HEADLESS_TASK_KEY = "([^"]+)"/,
    )?.[1];
    expect(kt).toBeDefined();
    expect(kt).toBe(ts);
    // The service hands that key to HeadlessJsTaskConfig.
    expect(service).toMatch(/HeadlessJsTaskConfig\(\s*HEADLESS_TASK_KEY,/);
  });

  it('headless service has a 4.5 s timeout and runs in the foreground', () => {
    const service = kotlin('NotificationActionTaskService.kt');
    expect(service).toMatch(
      /class NotificationActionTaskService\s*:\s*HeadlessJsTaskService\(\)/,
    );
    expect(service).toMatch(/const val TASK_TIMEOUT_MS = 4500L/);
    expect(service).toMatch(
      /HeadlessJsTaskConfig\(\s*HEADLESS_TASK_KEY,\s*[^,]+,\s*TASK_TIMEOUT_MS,\s*true\s*,?\s*\)/,
    );
  });

  it('arms exact and inexact AlarmManager alarms with immutable PendingIntents', () => {
    const scheduler = kotlin('AlarmScheduler.kt');
    expect(scheduler).toMatch(
      /\.setExactAndAllowWhileIdle\(\s*AlarmManager\.RTC_WAKEUP/,
    );
    expect(scheduler).toMatch(/\.setAndAllowWhileIdle\(\s*AlarmManager\.RTC_WAKEUP/);
    expect(scheduler).toContain('PendingIntent.FLAG_IMMUTABLE');
    expect(scheduler).toContain('PendingIntent.FLAG_UPDATE_CURRENT');
    // No mutable PendingIntents anywhere.
    for (const file of fs.readdirSync(REMINDERS_ANDROID)) {
      if (file.endsWith('.kt')) {
        expect(kotlin(file)).not.toContain('FLAG_MUTABLE');
      }
    }
  });

  it('creates the four notification channels', () => {
    const scheduler = kotlin('AlarmScheduler.kt');
    for (const [k, v] of [
      ['REMINDERS', 'reminders'],
      ['PROMPTS', 'prompts'],
      ['STATUS', 'status'],
      ['NUDGES', 'nudges'],
    ]) {
      expect(scheduler).toContain(`const val ${k} = "${v}"`);
    }
    const ts = tsContract.match(/export type AlarmChannel = ([^;]+);/)?.[1];
    expect(ts?.match(/"(\w+)"/g)?.map(s => s.slice(1, -1)).sort()).toEqual(
      ['nudges', 'prompts', 'reminders', 'status'],
    );
  });

  it('uses fresh HIGH v2 channels for reminders and prompts and deletes the old ones', () => {
    const scheduler = kotlin('AlarmScheduler.kt');
    expect(scheduler).toContain('const val REMINDERS_CHANNEL_ID = "reminders_v2"');
    expect(scheduler).toContain('const val PROMPTS_CHANNEL_ID = "prompts_v2"');
    expect(scheduler).toMatch(
      /NotificationChannel\(REMINDERS_CHANNEL_ID,[^)]*IMPORTANCE_HIGH\)/,
    );
    expect(scheduler).toMatch(
      /NotificationChannel\(PROMPTS_CHANNEL_ID,[^)]*IMPORTANCE_HIGH\)/,
    );
    expect(scheduler).toContain('deleteNotificationChannel(legacy)');
    expect(scheduler).toContain('listOf("reminders", "prompts")');
    expect(scheduler).toContain('NotificationCompat.Builder(context, AlarmChannels.channelId(channel))');
  });

  it('posts heads-up capable notifications with public visibility', () => {
    const scheduler = kotlin('AlarmScheduler.kt');
    expect(scheduler).toContain('NotificationCompat.PRIORITY_HIGH');
    expect(scheduler).toContain('NotificationCompat.CATEGORY_REMINDER');
    expect(scheduler).toContain('.setVisibility(NotificationCompat.VISIBILITY_PUBLIC)');
    expect(scheduler).toContain('.setOnlyAlertOnce(false)');
    expect(scheduler).toContain('NotificationCompat.BigTextStyle().bigText(payload.body)');
    expect(scheduler).not.toContain('setFullScreenIntent');
  });

  it('BootReceiver re-arms on BOOT_COMPLETED and MY_PACKAGE_REPLACED', () => {
    const boot = kotlin('BootReceiver.kt');
    expect(boot).toMatch(/class BootReceiver\s*:\s*BroadcastReceiver\(\)/);
    expect(boot).toContain('Intent.ACTION_BOOT_COMPLETED');
    expect(boot).toContain('Intent.ACTION_MY_PACKAGE_REPLACED');
    expect(boot).toContain('AlarmScheduler.rearmAll(');
  });

  it('receivers and package are BroadcastReceiver / BaseReactPackage subclasses', () => {
    expect(kotlin('AlarmReceiver.kt')).toMatch(
      /class AlarmReceiver\s*:\s*BroadcastReceiver\(\)/,
    );
    expect(kotlin('ActionReceiver.kt')).toMatch(
      /class ActionReceiver\s*:\s*BroadcastReceiver\(\)/,
    );
    const pkg = kotlin('TimeBlockerAlarmsPackage.kt');
    expect(pkg).toMatch(/class TimeBlockerAlarmsPackage\s*:\s*BaseReactPackage\(\)/);
    expect(pkg).toMatch(/TimeBlockerAlarmsModule\(reactContext\)/);
  });

  it('stores payloads in private SharedPreferences', () => {
    expect(kotlin('AlarmStore.kt')).toMatch(
      /getSharedPreferences\(\s*PREFS_NAME,\s*Context\.MODE_PRIVATE\s*\)/,
    );
  });
});

// --- Health Connect sleep (task 40.2; R25.1, R25.5, R25.6) ---------------------
describe('Health Connect sleep wiring', () => {
  const HEALTH_ANDROID = path.join(PACKAGES_DIR, 'health-sleep', 'android');
  const DEBUG_MANIFEST = path.join(ANDROID_APP, 'src', 'debug', 'AndroidManifest.xml');
  const ROOT_GRADLE = path.join(MOBILE_DIR, 'android', 'build.gradle');
  const manifest = only(childrenNamed(parseXml(read(MANIFEST)), 'manifest'), '<manifest>');
  const application = only(childrenNamed(manifest, 'application'), '<application>');
  const READ = 'android.permission.health.READ_SLEEP';
  const WRITE = 'android.permission.health.WRITE_SLEEP';
  const names = (el: XmlElement, tag: string): (string | undefined)[] =>
    childrenNamed(el, tag).map(c => c.attrs['android:name']);

  it('declares READ_SLEEP in the release manifest and never WRITE_SLEEP', () => {
    expect(names(manifest, 'uses-permission')).toContain(READ);
    expect(read(MANIFEST)).not.toContain(WRITE);
  });
  it('declares WRITE_SLEEP only in the debug manifest overlay', () => {
    const debug = only(childrenNamed(parseXml(read(DEBUG_MANIFEST)), 'manifest'), 'debug <manifest>');
    expect(names(debug, 'uses-permission')).toEqual([WRITE]);
    expect(read(DEBUG_MANIFEST)).not.toContain(READ);
  });
  it('queries the Health Connect provider package', () => {
    const queries = only(childrenNamed(manifest, 'queries'), '<queries>');
    expect(names(queries, 'package')).toContain('com.google.android.apps.healthdata');
  });
  it('has the rationale and permission-usage activity aliases pointing at MainActivity', () => {
    const aliases = childrenNamed(application, 'activity-alias');
    const filterOf = (alias: XmlElement): XmlElement =>
      only(childrenNamed(alias, 'intent-filter'), `${alias.attrs['android:name']} <intent-filter>`);
    const rationale = only(
      aliases.filter(a => a.attrs['android:name'] === 'HealthPermissionsRationaleActivity'),
      'rationale alias',
    );
    expect(rationale.attrs['android:targetActivity']).toBe('.MainActivity');
    expect(rationale.attrs['android:exported']).toBe('true');
    expect(names(filterOf(rationale), 'action')).toEqual([
      'androidx.health.ACTION_SHOW_PERMISSIONS_RATIONALE',
    ]);
    const usage = only(
      aliases.filter(a => a.attrs['android:name'] === 'ViewPermissionUsageActivity'),
      'usage alias',
    );
    expect(usage.attrs['android:targetActivity']).toBe('.MainActivity');
    expect(usage.attrs['android:exported']).toBe('true');
    expect(usage.attrs['android:permission']).toBe('android.permission.START_VIEW_PERMISSION_USAGE');
    expect(names(filterOf(usage), 'action')).toEqual(['android.intent.action.VIEW_PERMISSION_USAGE']);
    expect(names(filterOf(usage), 'category')).toEqual(['android.intent.category.HEALTH_PERMISSIONS']);
  });
  it('registers HealthSleepPackage in MainApplication', () => {
    const src = read(MAIN_APPLICATION);
    expect(src).toContain('import com.timeblocker.healthsleep.HealthSleepPackage');
    expect(src).toContain('add(HealthSleepPackage())');
  });
  it('wires the source sets and pins connect-client exactly', () => {
    const gradle = read(BUILD_GRADLE);
    expect(gradle).toContain('"$rootDir/../../health-sleep/android"');
    expect(gradle).toMatch(/debug\s*\{\s*java\.srcDirs \+= \["\$rootDir\/\.\.\/\.\.\/health-sleep\/android-debug"\]/);
    expect(gradle).toMatch(/release\s*\{\s*java\.srcDirs \+= \["\$rootDir\/\.\.\/\.\.\/health-sleep\/android-release"\]/);
    expect(gradle).toMatch(/implementation\("androidx\.health\.connect:connect-client:\d+\.\d+\.\d+"\)/);
  });
  it('raises minSdk to 26 (Health Connect client)', () => {
    expect(read(ROOT_GRADLE)).toMatch(/minSdkVersion = 26\b/);
  });
  it('module exposes the HealthSleep API; demo write exists only in the debug source set', () => {
    const mod = stripKotlinComments(read(path.join(HEALTH_ANDROID, 'HealthSleepModule.kt')));
    expect(mod).toContain('override fun getName(): String = "HealthSleep"');
    expect(reactMethodNames(mod).sort()).toEqual([
      'availability',
      'deleteDemoSessions',
      'permission',
      'readSessions',
      'requestDemoWritePermission',
      'requestPermission',
      'writeDemoSessions',
    ]);
    const release = read(path.join(PACKAGES_DIR, 'health-sleep', 'android-release', 'HealthDemo.kt'));
    const debug = read(path.join(PACKAGES_DIR, 'health-sleep', 'android-debug', 'HealthDemo.kt'));
    expect(release).toContain('AVAILABLE = false');
    expect(release).not.toContain('insertRecords');
    expect(debug).toContain('AVAILABLE = true');
    expect(debug).toContain('insertRecords');
    expect(read(path.join(HEALTH_ANDROID, 'HealthDemoApi.kt'))).toContain(WRITE);
  });
});
