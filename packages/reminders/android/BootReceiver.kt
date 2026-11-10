package com.timeblocker.reminders

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/**
 * Re-arms every stored future alarm after a reboot or an app update (D7).
 * Force-stop also clears alarms but sends no broadcast; JS `reconcile()`
 * covers that on the next launch via `listPending()`.
 *
 * Manifest (23.2): `<receiver android:name="com.timeblocker.reminders.BootReceiver"
 * android:exported="true">` with an intent filter for
 * `android.intent.action.BOOT_COMPLETED` and
 * `android.intent.action.MY_PACKAGE_REPLACED` (both protected system
 * broadcasts), plus `RECEIVE_BOOT_COMPLETED`.
 */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        when (intent.action) {
            Intent.ACTION_BOOT_COMPLETED, Intent.ACTION_MY_PACKAGE_REPLACED -> {
                AlarmChannels.ensure(context)
                AlarmScheduler.rearmAll(context)
            }
        }
    }
}
