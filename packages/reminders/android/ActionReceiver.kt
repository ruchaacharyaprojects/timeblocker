package com.timeblocker.reminders

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log
import com.facebook.react.HeadlessJsTaskService

/**
 * Receives notification action taps ("I'm in", "Skip", "Move it", "Yes",
 * "No", "Undo") and hands them to [NotificationActionTaskService], which runs
 * the JS task without opening the app's UI (R13.4, R13.6, R13.12, R13.13).
 *
 * Non-exported: the manifest entry (23.2) is
 * `<receiver android:name="com.timeblocker.reminders.ActionReceiver" android:exported="false" />`.
 * Taps arrive only through our explicit, immutable PendingIntents.
 */
class ActionReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != AlarmScheduler.ACTION_NOTIFICATION_ACTION) return
        val notificationId = intent.getStringExtra(AlarmScheduler.EXTRA_NOTIFICATION_ID) ?: return
        val actionId = intent.getStringExtra(AlarmScheduler.EXTRA_ACTION_ID) ?: return

        val service = Intent(context, NotificationActionTaskService::class.java).apply {
            putExtra(AlarmScheduler.EXTRA_NOTIFICATION_ID, notificationId)
            putExtra(AlarmScheduler.EXTRA_KIND, intent.getStringExtra(AlarmScheduler.EXTRA_KIND) ?: "")
            putExtra(AlarmScheduler.EXTRA_SOURCE_ID, intent.getStringExtra(AlarmScheduler.EXTRA_SOURCE_ID) ?: "")
            intent.getStringExtra(AlarmScheduler.EXTRA_WEEK_ID)?.let {
                putExtra(AlarmScheduler.EXTRA_WEEK_ID, it)
            }
            putExtra(AlarmScheduler.EXTRA_ACTION_ID, actionId)
        }

        try {
            // A broadcast from a notification PendingIntent temporarily
            // allowlists the app, so a background startService() is permitted
            // (Android 8+ background execution limits).
            context.startService(service)
            HeadlessJsTaskService.acquireWakeLockNow(context)
        } catch (e: IllegalStateException) {
            // VERIFY ON DEVICE: should not happen for notification taps. If it
            // does, the notification stays posted so the user can tap again.
            Log.w("TimeBlockerAlarms", "Could not start headless task for $notificationId", e)
        }
    }
}
