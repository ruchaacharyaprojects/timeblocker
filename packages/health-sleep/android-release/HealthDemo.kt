package com.timeblocker.healthsleep

import android.content.Context

/**
 * Release stub: the demo helpers do not exist in release builds. The real
 * implementation lives in `packages/health-sleep/android-debug/HealthDemo.kt`
 * (wired through `sourceSets.debug`). Both files declare the same `HealthDemo`
 * object, so exactly one is compiled per build type.
 */
object HealthDemo {
    const val AVAILABLE = false

    @Suppress("UNUSED_PARAMETER")
    suspend fun write(context: Context, sessions: List<DemoSleepSession>): Unit =
        throw DemoUnavailableException()

    @Suppress("UNUSED_PARAMETER")
    suspend fun delete(context: Context): Int = throw DemoUnavailableException()
}
