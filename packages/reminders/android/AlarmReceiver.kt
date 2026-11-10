package com.timeblocker.reminders

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/**
 * Fires when a scheduled alarm goes off and posts the notification natively
 * from the stored payload (title, body, channel, actions, deep link). No JS
 * runs here, so delivery does not depend on React Native starting (D7).
 *
 * Manifest (23.2): `<receiver android:name="com.timeblocker.reminders.AlarmReceiver"
 * android:exported="false" />`. Only our own explicit PendingIntent reaches it.
 */
class AlarmReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != AlarmScheduler.ACTION_FIRE) return
        val id = intent.getStringExtra(AlarmScheduler.EXTRA_NOTIFICATION_ID) ?: return
        val stored = AlarmStore(context).get(id)
        // Always clear the armed state so listPending() stops reporting this id.
        AlarmScheduler.markFired(context, id)
        // Missing payload means it was cancelled while the alarm was in flight.
        stored ?: return
        AlarmScheduler.post(context, stored.payload)
    }
}
