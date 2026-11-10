package com.timeblocker.reminders

import com.facebook.react.BaseReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.module.model.ReactModuleInfo
import com.facebook.react.module.model.ReactModuleInfoProvider

/**
 * Registers [TimeBlockerAlarmsModule]. Add `TimeBlockerAlarmsPackage()` to
 * `PackageList(this).packages` in MainApplication (task 23.2).
 *
 * RN 0.88.1 is bridgeless (newArchEnabled=true), where
 * `ReactPackage.createNativeModules` is deprecated, so this uses
 * `BaseReactPackage` + `getModule`. The module is a legacy (non-Turbo)
 * module served through the interop layer: `isTurboModule = false`.
 */
class TimeBlockerAlarmsPackage : BaseReactPackage() {
    override fun getModule(name: String, reactContext: ReactApplicationContext): NativeModule? =
        if (name == TimeBlockerAlarmsModule.NAME) TimeBlockerAlarmsModule(reactContext) else null

    override fun getReactModuleInfoProvider(): ReactModuleInfoProvider = ReactModuleInfoProvider {
        mapOf(
            TimeBlockerAlarmsModule.NAME to ReactModuleInfo(
                TimeBlockerAlarmsModule.NAME,
                TimeBlockerAlarmsModule::class.java.name,
                false, // canOverrideExistingModule
                false, // needsEagerInit (channels are also ensured before every post)
                false, // isCxxModule
                false, // isTurboModule
            ),
        )
    }
}
