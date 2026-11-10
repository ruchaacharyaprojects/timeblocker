package com.timeblocker.reminders

import android.content.Context
import android.content.SharedPreferences
import com.facebook.react.bridge.ReadableMap
import org.json.JSONArray
import org.json.JSONObject

/*
 * ---------------------------------------------------------------------------
 * VERIFY ON FIRST GRADLE BUILD (written without a JDK/Android SDK; R13, D7)
 * ---------------------------------------------------------------------------
 * Applies to every TimeBlockerAlarms file in this directory:
 *  - All files compile under the app's Kotlin/AGP versions once
 *    `packages/reminders/android` is in `sourceSets.main.java.srcDirs` (23.2).
 *    The Kotlin package is `com.timeblocker.reminders` (directory does not
 *    match the package; Kotlin allows this, but lint may warn).
 *  - `androidx.core` (NotificationCompat / NotificationManagerCompat /
 *    ContextCompat) resolves transitively through `react-android`. If not, add
 *    `implementation "androidx.core:core-ktx:<pinned>"` to app/build.gradle.
 *  - RN 0.88.1 runs bridgeless (newArchEnabled=true). TimeBlockerAlarmsModule
 *    is a legacy `ReactContextBaseJavaModule` exposed through
 *    `BaseReactPackage` with `isTurboModule = false`, which relies on the
 *    TurboModule interop layer. Confirm `NativeModules.TimeBlockerAlarms`
 *    resolves in JS (both in the UI and inside the headless task).
 *  - Manifest entries (23.2) must use the fully qualified names
 *    `com.timeblocker.reminders.AlarmReceiver` (exported=false),
 *    `com.timeblocker.reminders.ActionReceiver` (exported=false),
 *    `com.timeblocker.reminders.BootReceiver` (exported=true, intent filter
 *    BOOT_COMPLETED + MY_PACKAGE_REPLACED; protected broadcasts) and
 *    `com.timeblocker.reminders.NotificationActionTaskService`
 *    (exported=false).
 *  - The JS side must call
 *    `AppRegistry.registerHeadlessTask("TimeBlockerNotificationAction", ...)`
 *    (constant HEADLESS_TASK_KEY, also exposed via getConstants()).
 *  - Small icon: `android.R.drawable.ic_popup_reminder` is a placeholder;
 *    swap for a monochrome app drawable if it renders poorly.
 *  - On device: alarms fire while the app is killed; action taps run the
 *    headless task without opening the UI (R13.4, < 5 s); reboot re-arms.
 * ---------------------------------------------------------------------------
 */

/** One action button; mirrors `NotificationAction` in app-core ports.ts. */
data class AlarmAction(val id: String, val label: String)

/**
 * Everything needed to post a notification natively, with no JS at fire
 * time. Mirrors `NotificationPayload` in `packages/app-core/src/ports.ts`.
 */
data class AlarmPayload(
    val id: String,
    val kind: String,
    val channel: String,
    val title: String,
    val body: String,
    val actions: List<AlarmAction>,
    val sourceId: String,
    val weekId: String?,
    val deepLink: String?,
    val timeoutMs: Long?,
) {
    fun toJson(): JSONObject = JSONObject().apply {
        put("id", id)
        put("kind", kind)
        put("channel", channel)
        put("title", title)
        put("body", body)
        put("sourceId", sourceId)
        weekId?.let { put("weekId", it) }
        deepLink?.let { put("deepLink", it) }
        timeoutMs?.let { put("timeoutMs", it) }
        val arr = JSONArray()
        for (a in actions) {
            arr.put(JSONObject().put("id", a.id).put("label", a.label))
        }
        put("actions", arr)
    }

    companion object {
        fun fromJson(json: JSONObject): AlarmPayload {
            val arr = json.optJSONArray("actions") ?: JSONArray()
            val actions = (0 until arr.length()).mapNotNull { i ->
                val a = arr.optJSONObject(i) ?: return@mapNotNull null
                val actionId = a.optStringOrNull("id") ?: return@mapNotNull null
                AlarmAction(actionId, a.optStringOrNull("label") ?: actionId)
            }
            return AlarmPayload(
                id = json.getString("id"),
                kind = json.optStringOrNull("kind") ?: "",
                channel = json.optStringOrNull("channel") ?: AlarmChannels.REMINDERS,
                title = json.optStringOrNull("title") ?: "",
                body = json.optStringOrNull("body") ?: "",
                actions = actions,
                sourceId = json.optStringOrNull("sourceId") ?: "",
                weekId = json.optStringOrNull("weekId"),
                deepLink = json.optStringOrNull("deepLink"),
                timeoutMs = if (json.has("timeoutMs") && !json.isNull("timeoutMs")) {
                    json.getLong("timeoutMs")
                } else {
                    null
                },
            )
        }

        /** Parses the JS `NotificationPayload` object. Throws on a missing id. */
        fun fromReadableMap(map: ReadableMap): AlarmPayload {
            val id = map.stringOrNull("id")
                ?: throw IllegalArgumentException("payload.id is required")
            val actions = mutableListOf<AlarmAction>()
            if (map.hasKey("actions") && !map.isNull("actions")) {
                val arr = map.getArray("actions")
                if (arr != null) {
                    for (i in 0 until arr.size()) {
                        val a = arr.getMap(i) ?: continue
                        val actionId = a.stringOrNull("id") ?: continue
                        actions.add(AlarmAction(actionId, a.stringOrNull("label") ?: actionId))
                    }
                }
            }
            val timeout = if (map.hasKey("timeoutMs") && !map.isNull("timeoutMs")) {
                map.getDouble("timeoutMs").toLong()
            } else {
                null
            }
            return AlarmPayload(
                id = id,
                kind = map.stringOrNull("kind") ?: "",
                channel = map.stringOrNull("channel") ?: AlarmChannels.REMINDERS,
                title = map.stringOrNull("title") ?: "",
                body = map.stringOrNull("body") ?: "",
                actions = actions,
                sourceId = map.stringOrNull("sourceId") ?: "",
                weekId = map.stringOrNull("weekId"),
                deepLink = map.stringOrNull("deepLink"),
                timeoutMs = timeout,
            )
        }

        private fun ReadableMap.stringOrNull(key: String): String? =
            if (hasKey(key) && !isNull(key)) getString(key) else null

        private fun JSONObject.optStringOrNull(key: String): String? =
            if (has(key) && !isNull(key)) getString(key) else null
    }
}

/** A stored alarm: the payload plus when and how it was armed. */
data class StoredAlarm(val payload: AlarmPayload, val fireAtMs: Long, val exact: Boolean)

/**
 * Private `SharedPreferences` holding every armed alarm's payload, so that
 * [AlarmReceiver] can post without JS and [BootReceiver] can re-arm after a
 * reboot or app update. One key per notification id; value is JSON.
 */
class AlarmStore(context: Context) {
    private val prefs: SharedPreferences =
        context.applicationContext.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)

    fun put(alarm: StoredAlarm) {
        val json = JSONObject()
            .put("payload", alarm.payload.toJson())
            .put("fireAtMs", alarm.fireAtMs)
            .put("exact", alarm.exact)
        prefs.edit().putString(KEY_PREFIX + alarm.payload.id, json.toString()).apply()
    }

    fun get(id: String): StoredAlarm? = prefs.getString(KEY_PREFIX + id, null)?.let(this::decode)

    fun remove(id: String) {
        prefs.edit().remove(KEY_PREFIX + id).apply()
    }

    fun all(): List<StoredAlarm> = prefs.all.entries
        .filter { it.key.startsWith(KEY_PREFIX) }
        .mapNotNull { (it.value as? String)?.let(this::decode) }

    private fun decode(raw: String): StoredAlarm? = runCatching {
        val json = JSONObject(raw)
        StoredAlarm(
            payload = AlarmPayload.fromJson(json.getJSONObject("payload")),
            fireAtMs = json.getLong("fireAtMs"),
            exact = json.optBoolean("exact", false),
        )
    }.getOrNull()

    private companion object {
        const val PREFS_NAME = "timeblocker_alarms"
        const val KEY_PREFIX = "alarm:"
    }
}
