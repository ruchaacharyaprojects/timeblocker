package com.timeblocker.app

import android.app.Application
import com.facebook.react.PackageList
import com.facebook.react.ReactApplication
import com.facebook.react.ReactHost
import com.facebook.react.ReactNativeApplicationEntryPoint.loadReactNative
import com.facebook.react.defaults.DefaultReactHost.getDefaultReactHost
import com.timeblocker.healthsleep.HealthSleepPackage
import com.timeblocker.reminders.RemindersPackage
import com.timeblocker.reminders.TimeBlockerAlarmsPackage
import com.timeblocker.usagemetrics.UsageMetricsPackage

class MainApplication : Application(), ReactApplication {

  override val reactHost: ReactHost by lazy {
    getDefaultReactHost(
      context = applicationContext,
      packageList =
        PackageList(this).packages.apply {
          // In-repo Kotlin modules compiled via sourceSets in app/build.gradle
          // (not autolinked: the pure packages have no Gradle module).
          add(TimeBlockerAlarmsPackage()) // NativeModules.TimeBlockerAlarms
          add(RemindersPackage()) // NativeModules.Reminders (kept for compatibility)
          add(UsageMetricsPackage()) // NativeModules.UsageMetrics
          add(HealthSleepPackage()) // NativeModules.HealthSleep (Health Connect sleep)
        },
    )
  }

  override fun onCreate() {
    super.onCreate()
    loadReactNative(this)
  }
}
