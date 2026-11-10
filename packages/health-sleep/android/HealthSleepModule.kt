package com.timeblocker.healthsleep

import android.app.Activity
import android.content.Intent
import androidx.health.connect.client.HealthConnectClient
import androidx.health.connect.client.PermissionController
import androidx.health.connect.client.permission.HealthPermission
import androidx.health.connect.client.records.SleepSessionRecord
import androidx.health.connect.client.request.ReadRecordsRequest
import androidx.health.connect.client.time.TimeRangeFilter
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.BaseActivityEventListener
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.ReadableArray
import com.facebook.react.bridge.ReadableMap
import java.time.Instant
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch

/**
 * Android native module `HealthSleep` (R25): reads sleep sessions that
 * Samsung Health (or any app) wrote into Health Connect. Read-only in release
 * builds; the demo write/delete helpers are backed by `HealthDemo`, which only
 * exists in debug builds (release stub rejects with DEMO_UNAVAILABLE).
 * Nothing leaves the device (R25.6).
 */
class HealthSleepModule(reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    /** Single in-flight permission request (resolved from onActivityResult). */
    private var pendingPromise: Promise? = null
    private var pendingPermissions: Set<String> = emptySet()

    private val activityListener = object : BaseActivityEventListener() {
        override fun onActivityResult(
            activity: Activity,
            requestCode: Int,
            resultCode: Int,
            data: Intent?,
        ) {
            if (requestCode != REQUEST_CODE) return
            val promise = pendingPromise ?: return
            val wanted = pendingPermissions
            pendingPromise = null
            pendingPermissions = emptySet()
            // Re-check what is actually granted instead of trusting the result.
            scope.launch {
                try {
                    promise.resolve(grantedStatus(wanted))
                } catch (e: Exception) {
                    promise.resolve("denied")
                }
            }
        }
    }

    init {
        reactContext.addActivityEventListener(activityListener)
    }

    override fun getName(): String = "HealthSleep"

    override fun invalidate() {
        reactApplicationContext.removeActivityEventListener(activityListener)
        pendingPromise?.resolve("denied")
        pendingPromise = null
        scope.cancel()
        super.invalidate()
    }

    /** "available" | "needs-install" | "unsupported". */
    @ReactMethod
    fun availability(promise: Promise) {
        try {
            promise.resolve(availabilityString())
        } catch (e: Exception) {
            promise.resolve("unsupported")
        }
    }

    /** "granted" | "denied" for READ_SLEEP. */
    @ReactMethod
    fun permission(promise: Promise) {
        scope.launch {
            try {
                promise.resolve(grantedStatus(setOf(READ_PERMISSION)))
            } catch (e: Exception) {
                promise.resolve("denied")
            }
        }
    }

    /** Opens the Health Connect permission screen for READ_SLEEP. */
    @ReactMethod
    fun requestPermission(promise: Promise) {
        request(setOf(READ_PERMISSION), promise)
    }

    /**
     * Reads sleep sessions overlapping [startMs, endMs]. Resolves
     * `[{ startMs, endMs, asleepMin }]` sorted by start. Missing permission or
     * no data resolves `[]`; it never rejects for "no data".
     */
    @ReactMethod
    fun readSessions(window: ReadableMap, promise: Promise) {
        val windowStart: Long
        val windowEnd: Long
        try {
            windowStart = window.getDouble("startMs").toLong()
            windowEnd = window.getDouble("endMs").toLong()
        } catch (e: Exception) {
            promise.reject("INVALID_WINDOW", e)
            return
        }
        scope.launch {
            try {
                if (availabilityString() != "available" || windowEnd <= windowStart) {
                    promise.resolve(Arguments.createArray())
                    return@launch
                }
                promise.resolve(read(windowStart, windowEnd))
            } catch (e: SecurityException) {
                promise.resolve(Arguments.createArray())
            } catch (e: Exception) {
                promise.reject("READ_SLEEP_FAILED", e)
            }
        }
    }

    // --- Debug-only demo helpers (release: reject DEMO_UNAVAILABLE) ----------

    /** Opens the permission screen for READ + WRITE sleep (debug builds only). */
    @ReactMethod
    fun requestDemoWritePermission(promise: Promise) {
        if (!HealthDemo.AVAILABLE) {
            promise.reject("DEMO_UNAVAILABLE", "Demo sleep data is only available in debug builds")
            return
        }
        request(setOf(READ_PERMISSION, WRITE_SLEEP_PERMISSION), promise)
    }

    /**
     * Writes `[{ startMs, endMs, awakeMin }]` as manual-entry sleep sessions.
     * Call [requestDemoWritePermission] first; rejects PERMISSION_DENIED
     * when write is not granted. Resolves the number of sessions written.
     */
    @ReactMethod
    fun writeDemoSessions(sessions: ReadableArray, promise: Promise) {
        if (!HealthDemo.AVAILABLE) {
            promise.reject("DEMO_UNAVAILABLE", "Demo sleep data is only available in debug builds")
            return
        }
        val parsed = try {
            parseDemoSessions(sessions)
        } catch (e: Exception) {
            promise.reject("INVALID_SESSIONS", e)
            return
        }
        scope.launch {
            try {
                if (grantedStatus(setOf(WRITE_SLEEP_PERMISSION)) != "granted") {
                    promise.reject("PERMISSION_DENIED", "Health Connect write permission not granted")
                    return@launch
                }
                HealthDemo.write(reactApplicationContext, parsed)
                promise.resolve(parsed.size)
            } catch (e: DemoUnavailableException) {
                promise.reject("DEMO_UNAVAILABLE", e)
            } catch (e: SecurityException) {
                promise.reject("PERMISSION_DENIED", e)
            } catch (e: Exception) {
                promise.reject("WRITE_DEMO_FAILED", e)
            }
        }
    }

    /** Deletes the demo sessions this app wrote. Resolves the number removed. */
    @ReactMethod
    fun deleteDemoSessions(promise: Promise) {
        if (!HealthDemo.AVAILABLE) {
            promise.reject("DEMO_UNAVAILABLE", "Demo sleep data is only available in debug builds")
            return
        }
        scope.launch {
            try {
                promise.resolve(HealthDemo.delete(reactApplicationContext))
            } catch (e: DemoUnavailableException) {
                promise.reject("DEMO_UNAVAILABLE", e)
            } catch (e: SecurityException) {
                promise.reject("PERMISSION_DENIED", e)
            } catch (e: Exception) {
                promise.reject("DELETE_DEMO_FAILED", e)
            }
        }
    }

    // --- Internals -----------------------------------------------------------

    private fun availabilityString(): String =
        when (HealthConnectClient.getSdkStatus(reactApplicationContext)) {
            HealthConnectClient.SDK_AVAILABLE -> "available"
            HealthConnectClient.SDK_UNAVAILABLE_PROVIDER_UPDATE_REQUIRED -> "needs-install"
            else -> "unsupported"
        }

    private suspend fun grantedStatus(wanted: Set<String>): String {
        if (availabilityString() != "available") return "denied"
        val granted = HealthConnectClient.getOrCreate(reactApplicationContext)
            .permissionController.getGrantedPermissions()
        return if (granted.containsAll(wanted)) "granted" else "denied"
    }

    private fun request(permissions: Set<String>, promise: Promise) {
        if (pendingPromise != null) {
            promise.reject("REQUEST_IN_PROGRESS", "A Health Connect permission request is already open")
            return
        }
        val activity = reactApplicationContext.currentActivity
        if (activity == null || availabilityString() != "available") {
            promise.resolve("denied")
            return
        }
        try {
            val contract = PermissionController.createRequestPermissionResultContract()
            val intent = contract.createIntent(activity, permissions)
            pendingPromise = promise
            pendingPermissions = permissions
            activity.startActivityForResult(intent, REQUEST_CODE)
        } catch (e: Exception) {
            pendingPromise = null
            pendingPermissions = emptySet()
            promise.resolve("denied")
        }
    }

    private suspend fun read(windowStart: Long, windowEnd: Long): com.facebook.react.bridge.WritableArray {
        val client = HealthConnectClient.getOrCreate(reactApplicationContext)
        val found = ArrayList<SleepSessionRecord>()
        var pageToken: String? = null
        do {
            val response = client.readRecords(
                ReadRecordsRequest(
                    recordType = SleepSessionRecord::class,
                    timeRangeFilter = TimeRangeFilter.between(
                        Instant.ofEpochMilli(windowStart),
                        Instant.ofEpochMilli(windowEnd),
                    ),
                    pageToken = pageToken,
                ),
            )
            found.addAll(response.records)
            pageToken = response.pageToken
        } while (pageToken != null)

        val result = Arguments.createArray()
        found
            .filter {
                it.endTime.toEpochMilli() > windowStart && it.startTime.toEpochMilli() < windowEnd
            }
            .sortedBy { it.startTime }
            .forEach { record ->
                val start = record.startTime.toEpochMilli()
                val end = record.endTime.toEpochMilli()
                val map = Arguments.createMap()
                map.putDouble("startMs", start.toDouble())
                map.putDouble("endMs", end.toDouble())
                map.putDouble("asleepMin", asleepMinutes(record).toDouble())
                result.pushMap(map)
            }
        return result
    }

    /** Duration minus awake / awake-in-bed / out-of-bed stages, clamped >= 0. */
    private fun asleepMinutes(record: SleepSessionRecord): Long {
        val start = record.startTime.toEpochMilli()
        val end = record.endTime.toEpochMilli()
        var awakeMs = 0L
        for (stage in record.stages) {
            if (stage.stage in AWAKE_STAGES) {
                val s = maxOf(stage.startTime.toEpochMilli(), start)
                val e = minOf(stage.endTime.toEpochMilli(), end)
                if (e > s) awakeMs += e - s
            }
        }
        return maxOf(0L, Math.round((end - start - awakeMs) / 60_000.0))
    }

    private fun parseDemoSessions(array: ReadableArray): List<DemoSleepSession> =
        (0 until array.size()).map { i ->
            val m = array.getMap(i) ?: throw IllegalArgumentException("session $i is null")
            DemoSleepSession(
                startMs = m.getDouble("startMs").toLong(),
                endMs = m.getDouble("endMs").toLong(),
                awakeMin = if (m.hasKey("awakeMin")) m.getDouble("awakeMin").toInt() else 0,
            )
        }

    companion object {
        private const val REQUEST_CODE = 41017
        private val READ_PERMISSION = HealthPermission.getReadPermission(SleepSessionRecord::class)
        private val AWAKE_STAGES = setOf(
            SleepSessionRecord.STAGE_TYPE_AWAKE,
            SleepSessionRecord.STAGE_TYPE_AWAKE_IN_BED,
            SleepSessionRecord.STAGE_TYPE_OUT_OF_BED,
        )
    }
}
