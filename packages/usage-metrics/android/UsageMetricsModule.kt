package com.timeblocker.usagemetrics

import android.app.AppOpsManager
import android.app.usage.UsageEvents
import android.app.usage.UsageStatsManager
import android.content.Context
import android.content.Intent
import android.os.Process
import android.provider.Settings
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.ReadableMap
import com.facebook.react.bridge.WritableArray

/**
 * Android native module for TimeBlocker usage metrics (R7).
 *
 * Reads screen time and per-app usage via [UsageStatsManager] after the user
 * grants the "Usage Access" special permission (R7.1). This module only reads
 * raw usage and hands it to JS for on-device aggregation; it performs no
 * network I/O, which keeps raw app history on the device (R7.3). Deciding
 * which apps are "distraction" is the editable JS list's job (R7.2), so this
 * module stays policy-free.
 */
class UsageMetricsModule(reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

    override fun getName(): String = "UsageMetrics"

    /**
     * Report whether the app holds the Usage Access special permission (R7.1).
     * Resolves "granted" or "denied".
     */
    @ReactMethod
    fun getPermissionStatus(promise: Promise) {
        try {
            promise.resolve(if (hasUsageAccess()) "granted" else "denied")
        } catch (e: Exception) {
            promise.reject("PERMISSION_CHECK_FAILED", e)
        }
    }

    /**
     * Open the system Usage Access settings screen (R7.1). There is no runtime
     * grant dialog for this special permission, so this is the only grant path.
     * The JS layer re-checks status when the app resumes.
     */
    @ReactMethod
    fun openUsageAccessSettings(promise: Promise) {
        try {
            val intent = Intent(Settings.ACTION_USAGE_ACCESS_SETTINGS).apply {
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            }
            reactApplicationContext.startActivity(intent)
            promise.resolve(null)
        } catch (e: Exception) {
            promise.reject("OPEN_SETTINGS_FAILED", e)
        }
    }

    /**
     * Query raw per-app foreground usage for the window [startMs, endMs) using
     * event reconstruction, which is more accurate than aggregate buckets.
     * Returns an array of { packageName, foregroundTimeMs, launchCount }.
     *
     * This raw data crosses the bridge to JS only so it can be aggregated
     * on-device; it is never uploaded (R7.3).
     */
    @ReactMethod
    fun queryUsage(window: ReadableMap, promise: Promise) {
        try {
            if (!hasUsageAccess()) {
                promise.reject("PERMISSION_DENIED", "Usage Access not granted")
                return
            }
            val startMs = window.getDouble("startMs").toLong()
            val endMs = window.getDouble("endMs").toLong()
            promise.resolve(readForegroundUsage(startMs, endMs))
        } catch (e: Exception) {
            promise.reject("QUERY_USAGE_FAILED", e)
        }
    }

    private fun usageStatsManager(): UsageStatsManager =
        reactApplicationContext.getSystemService(
            Context.USAGE_STATS_SERVICE
        ) as UsageStatsManager

    /** Check the Usage Access app-op for this package. */
    private fun hasUsageAccess(): Boolean {
        val appOps = reactApplicationContext.getSystemService(
            Context.APP_OPS_SERVICE
        ) as AppOpsManager
        val mode = if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.Q) {
            appOps.unsafeCheckOpNoThrow(
                AppOpsManager.OPSTR_GET_USAGE_STATS,
                Process.myUid(),
                reactApplicationContext.packageName,
            )
        } else {
            @Suppress("DEPRECATION")
            appOps.checkOpNoThrow(
                AppOpsManager.OPSTR_GET_USAGE_STATS,
                Process.myUid(),
                reactApplicationContext.packageName,
            )
        }
        return mode == AppOpsManager.MODE_ALLOWED
    }

    /**
     * Reconstruct per-app foreground time from move-to-foreground /
     * move-to-background events in the window. Pairing transitions gives a far
     * more accurate screen-time figure than the coarse daily aggregates.
     */
    private fun readForegroundUsage(startMs: Long, endMs: Long): WritableArray {
        val usm = usageStatsManager()
        val events = usm.queryEvents(startMs, endMs)

        val foregroundMs = HashMap<String, Long>()
        val launches = HashMap<String, Int>()
        val lastForegroundAt = HashMap<String, Long>()

        val event = UsageEvents.Event()
        while (events.hasNextEvent()) {
            events.getNextEvent(event)
            val pkg = event.packageName ?: continue
            when (event.eventType) {
                UsageEvents.Event.MOVE_TO_FOREGROUND -> {
                    lastForegroundAt[pkg] = event.timeStamp
                    launches[pkg] = (launches[pkg] ?: 0) + 1
                }
                UsageEvents.Event.MOVE_TO_BACKGROUND -> {
                    val startedAt = lastForegroundAt.remove(pkg) ?: continue
                    val delta = event.timeStamp - startedAt
                    if (delta > 0) {
                        foregroundMs[pkg] = (foregroundMs[pkg] ?: 0L) + delta
                    }
                }
            }
        }
        // Close out any app still in the foreground at the window end.
        for ((pkg, startedAt) in lastForegroundAt) {
            val delta = endMs - startedAt
            if (delta > 0) {
                foregroundMs[pkg] = (foregroundMs[pkg] ?: 0L) + delta
            }
        }

        val result = Arguments.createArray()
        for ((pkg, ms) in foregroundMs) {
            val map = Arguments.createMap()
            map.putString("packageName", pkg)
            map.putDouble("foregroundTimeMs", ms.toDouble())
            map.putInt("launchCount", launches[pkg] ?: 0)
            result.pushMap(map)
        }
        return result
    }
}
