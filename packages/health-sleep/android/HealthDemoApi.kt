package com.timeblocker.healthsleep

/** One demo night handed over from JS. */
data class DemoSleepSession(val startMs: Long, val endMs: Long, val awakeMin: Int)

/** Thrown by the release stub of `HealthDemo`. */
class DemoUnavailableException : RuntimeException("Demo sleep data is only available in debug builds")

/** Client record id prefix of every record the demo writer creates. */
const val DEMO_CLIENT_ID_PREFIX = "timeblocker-demo-"

/** Write permission needed by the debug-only demo helpers. */
const val WRITE_SLEEP_PERMISSION = "android.permission.health.WRITE_SLEEP"
