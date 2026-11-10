package com.timeblocker.reminders

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.provider.Settings
import androidx.core.content.ContextCompat
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.ReadableMap

/**
 * `NativeModules.TimeBlockerAlarms`: local notifications for the on-device
 * app (R13, design D7), backing the app-core `Notifier` and
 * `SystemSettings` ports. Lives alongside the older [RemindersModule]
 * (`presentReminder` / `cancelReminder` / `TimeBlockerReminderAction`),
 * which stays for compatibility.
 *
 * Policy-free like [RemindersModule]: which notifications exist and what
 * each action does is decided in TS (`NotificationService`,
 * `BlockActionService`). This module only arms, posts, cancels and reports.
 *
 * See the "VERIFY ON FIRST GRADLE BUILD" block in AlarmStore.kt.
 */
class TimeBlockerAlarmsModule(reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

    init {
        AlarmChannels.ensure(reactContext)
    }

    override fun getName(): String = NAME

    override fun getConstants(): Map<String, Any> = mapOf(
        "HEADLESS_TASK_KEY" to NotificationActionTaskService.HEADLESS_TASK_KEY,
    )

    /**
     * `schedule(payload, fireAtMs, exact)`: persists the payload and arms an
     * exact (`setExactAndAllowWhileIdle`) or inexact (`setAndAllowWhileIdle`)
     * alarm. Exact silently downgrades to inexact when exact alarms are not
     * available (R13.10). Same id replaces the previous alarm.
     */
    @ReactMethod
    fun schedule(payload: ReadableMap, fireAtMs: Double, exact: Boolean, promise: Promise) {
        try {
            val parsed = AlarmPayload.fromReadableMap(payload)
            AlarmScheduler.arm(reactApplicationContext, parsed, fireAtMs.toLong(), exact)
            promise.resolve(null)
        } catch (e: Exception) {
            promise.reject("SCHEDULE_FAILED", e)
        }
    }

    /** Posts the notification immediately (R13.5, R13.11, R13.13). */
    @ReactMethod
    fun showNow(payload: ReadableMap, promise: Promise) {
        try {
            AlarmScheduler.post(reactApplicationContext, AlarmPayload.fromReadableMap(payload))
            promise.resolve(null)
        } catch (e: Exception) {
            promise.reject("SHOW_NOW_FAILED", e)
        }
    }

    /** Cancels both the alarm and any posted notification for `id` (R13.7). */
    @ReactMethod
    fun cancel(id: String, promise: Promise) {
        try {
            AlarmScheduler.cancel(reactApplicationContext, id)
            promise.resolve(null)
        } catch (e: Exception) {
            promise.reject("CANCEL_FAILED", e)
        }
    }

    /** Ids of alarms that are armed and have not fired yet. */
    @ReactMethod
    fun listPending(promise: Promise) {
        try {
            val ids = Arguments.createArray()
            AlarmScheduler.listPending(reactApplicationContext).forEach { ids.pushString(it) }
            promise.resolve(ids)
        } catch (e: Exception) {
            promise.reject("LIST_PENDING_FAILED", e)
        }
    }

    /** False on Android 12+ when exact-alarm access is unavailable (R13.10). */
    @ReactMethod
    fun canScheduleExactAlarms(promise: Promise) {
        try {
            promise.resolve(AlarmScheduler.canScheduleExact(reactApplicationContext))
        } catch (e: Exception) {
            promise.reject("EXACT_ALARM_CHECK_FAILED", e)
        }
    }

    /**
     * "granted" | "denied" | "undetermined" (R13.8, R13.9).
     *
     * Android cannot tell "never asked" from "permanently denied" without an
     * Activity, so on API 33+ an ungranted permission is "denied" only when
     * the system would show a rationale (denied once), and "undetermined"
     * otherwise. The JS adapter (23.3) treats "undetermined" as "denied" once
     * `permissionState.notificationsRequested` is true, so it never asks twice.
     */
    @ReactMethod
    fun notificationPermission(promise: Promise) {
        try {
            val ctx = reactApplicationContext
            val result = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                val granted = ContextCompat.checkSelfPermission(
                    ctx,
                    Manifest.permission.POST_NOTIFICATIONS,
                ) == PackageManager.PERMISSION_GRANTED
                when {
                    granted && AlarmScheduler.hasPostPermission(ctx) -> "granted"
                    granted -> "denied" // granted, but notifications turned off in settings
                    ctx.currentActivity?.shouldShowRequestPermissionRationale(
                        Manifest.permission.POST_NOTIFICATIONS,
                    ) == true -> "denied"
                    else -> "undetermined"
                }
            } else {
                if (AlarmScheduler.hasPostPermission(ctx)) "granted" else "denied"
            }
            promise.resolve(result)
        } catch (e: Exception) {
            promise.reject("NOTIFICATION_PERMISSION_FAILED", e)
        }
    }

    /** `Settings.ACTION_APP_NOTIFICATION_SETTINGS` for this app. */
    @ReactMethod
    fun openNotificationSettings(promise: Promise) {
        val intent = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS)
                .putExtra(Settings.EXTRA_APP_PACKAGE, reactApplicationContext.packageName)
        } else {
            appDetailsIntent()
        }
        startSettings(intent, promise)
    }

    /**
     * `Settings.ACTION_REQUEST_SCHEDULE_EXACT_ALARM` (Android 12+). Below 12
     * exact alarms are always available, so this opens app details instead.
     */
    @ReactMethod
    fun openExactAlarmSettings(promise: Promise) {
        val intent = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            Intent(
                Settings.ACTION_REQUEST_SCHEDULE_EXACT_ALARM,
                Uri.parse("package:" + reactApplicationContext.packageName),
            )
        } else {
            appDetailsIntent()
        }
        startSettings(intent, promise)
    }

    /** `Settings.ACTION_USAGE_ACCESS_SETTINGS` (usage metrics, R11). */
    @ReactMethod
    fun openUsageAccessSettings(promise: Promise) {
        startSettings(Intent(Settings.ACTION_USAGE_ACCESS_SETTINGS), promise)
    }

    private fun appDetailsIntent(): Intent = Intent(
        Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
        Uri.parse("package:" + reactApplicationContext.packageName),
    )

    private fun startSettings(intent: Intent, promise: Promise) {
        try {
            val activity = reactApplicationContext.currentActivity
            if (activity != null) {
                activity.startActivity(intent)
            } else {
                intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                reactApplicationContext.startActivity(intent)
            }
            promise.resolve(null)
        } catch (e: Exception) {
            promise.reject("OPEN_SETTINGS_FAILED", e)
        }
    }

    companion object {
        const val NAME = "TimeBlockerAlarms"
    }
}
