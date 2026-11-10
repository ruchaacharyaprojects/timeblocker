package com.timeblocker.reminders

import android.Manifest
import android.annotation.SuppressLint
import android.app.AlarmManager
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat

/**
 * The four channels from design D7. The constants are the JS-side names
 * (`AlarmChannel` in ports.ts); [channelId] maps them to the Android channel
 * ids. Reminders and prompts use `_v2` ids because a channel's importance
 * cannot be raised after first creation: existing installs get fresh HIGH
 * (heads-up) channels and the old ones are deleted.
 */
object AlarmChannels {
    const val REMINDERS = "reminders"
    const val PROMPTS = "prompts"
    const val STATUS = "status"
    const val NUDGES = "nudges"

    const val REMINDERS_CHANNEL_ID = "reminders_v2"
    const val PROMPTS_CHANNEL_ID = "prompts_v2"

    /** Legacy ids whose importance can no longer be changed. */
    private val LEGACY_CHANNEL_IDS = listOf("reminders", "prompts")

    /** Android channel id for a JS-side channel name. */
    fun channelId(channel: String): String = when (known(channel)) {
        REMINDERS -> REMINDERS_CHANNEL_ID
        PROMPTS -> PROMPTS_CHANNEL_ID
        else -> known(channel)
    }

    /** Idempotent; safe to call from the module and from every receiver. */
    fun ensure(context: Context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        for (legacy in LEGACY_CHANNEL_IDS) {
            manager.deleteNotificationChannel(legacy)
        }
        val channels = listOf(
            NotificationChannel(REMINDERS_CHANNEL_ID, "Block & meeting reminders", NotificationManager.IMPORTANCE_HIGH)
                .apply {
                    description = "15-minute reminders before blocks and meetings."
                    enableVibration(true)
                    lockscreenVisibility = NotificationCompat.VISIBILITY_PUBLIC
                },
            NotificationChannel(PROMPTS_CHANNEL_ID, "Will you miss this block?", NotificationManager.IMPORTANCE_HIGH)
                .apply {
                    description = "Asks when a new meeting overlaps a block."
                    enableVibration(true)
                    lockscreenVisibility = NotificationCompat.VISIBILITY_PUBLIC
                },
            NotificationChannel(STATUS, "Status", NotificationManager.IMPORTANCE_DEFAULT)
                .apply { description = "Moved blocks with Undo, and \"nothing fits\"." },
            NotificationChannel(NUDGES, "Weekly nudges", NotificationManager.IMPORTANCE_DEFAULT)
                .apply { description = "Saturday review and Sunday planning." },
        )
        manager.createNotificationChannels(channels)
    }

    fun known(channel: String): String =
        if (channel == REMINDERS || channel == PROMPTS || channel == STATUS || channel == NUDGES) {
            channel
        } else {
            REMINDERS
        }
}

/**
 * Shared alarm + notification logic used by [TimeBlockerAlarmsModule],
 * [AlarmReceiver], [BootReceiver] and [NotificationActionTaskService].
 *
 * Deterministic ids: the `PendingIntent` request code and the notification
 * int id are both `id.hashCode()` (Java's String hash is specified and stable
 * across processes and releases). The notification is also tagged with the
 * string id, and the alarm intent carries a per-id data URI, so two ids that
 * collide on hash still never replace each other.
 */
object AlarmScheduler {
    private const val TAG = "TimeBlockerAlarms"

    const val ACTION_FIRE = "com.timeblocker.reminders.ALARM_FIRE"
    const val ACTION_NOTIFICATION_ACTION = "com.timeblocker.reminders.NOTIFICATION_ACTION"

    const val EXTRA_NOTIFICATION_ID = "notificationId"
    const val EXTRA_KIND = "kind"
    const val EXTRA_SOURCE_ID = "sourceId"
    const val EXTRA_WEEK_ID = "weekId"
    const val EXTRA_ACTION_ID = "actionId"

    fun requestCode(id: String): Int = id.hashCode()

    // --- Alarms ---------------------------------------------------------------

    fun canScheduleExact(context: Context): Boolean {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) return true
        return alarmManager(context).canScheduleExactAlarms()
    }

    /**
     * Persists the payload and arms the alarm (R13.1, R13.10). Re-arming the
     * same id replaces the previous alarm (FLAG_UPDATE_CURRENT + same
     * request code and intent). Returns whether the alarm was armed exact.
     */
    fun arm(context: Context, payload: AlarmPayload, fireAtMs: Long, exactRequested: Boolean): Boolean {
        val pending = alarmIntent(context, payload.id, PendingIntent.FLAG_UPDATE_CURRENT)!!
        val manager = alarmManager(context)
        var exact = exactRequested && canScheduleExact(context)
        if (exact) {
            try {
                manager.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, fireAtMs, pending)
            } catch (e: SecurityException) {
                // Exact-alarm access revoked between the check and the call (Android 12/12L).
                Log.w(TAG, "Exact alarm denied, falling back to inexact for ${payload.id}", e)
                exact = false
            }
        }
        if (!exact) {
            manager.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, fireAtMs, pending)
        }
        AlarmStore(context).put(StoredAlarm(payload, fireAtMs, exact))
        return exact
    }

    /** Cancels the alarm, its stored payload, and any posted notification. */
    fun cancel(context: Context, id: String) {
        alarmIntent(context, id, PendingIntent.FLAG_NO_CREATE)?.let { pending ->
            alarmManager(context).cancel(pending)
            pending.cancel()
        }
        AlarmStore(context).remove(id)
        NotificationManagerCompat.from(context).cancel(id, requestCode(id))
    }

    /** True while the alarm's PendingIntent still exists (armed and not fired). */
    fun isArmed(context: Context, id: String): Boolean =
        alarmIntent(context, id, PendingIntent.FLAG_NO_CREATE) != null

    /** Called by [AlarmReceiver] after firing: drops the PendingIntent so [isArmed] is false. */
    fun markFired(context: Context, id: String) {
        alarmIntent(context, id, PendingIntent.FLAG_NO_CREATE)?.cancel()
        AlarmStore(context).remove(id)
    }

    /**
     * Ids that are armed and have not fired. Stored entries whose alarm is
     * gone (force-stop, reboot before [BootReceiver] ran) are pruned so JS
     * `reconcile()` sees them as missing and re-arms them.
     */
    fun listPending(context: Context): List<String> {
        val store = AlarmStore(context)
        val result = mutableListOf<String>()
        for (alarm in store.all()) {
            if (isArmed(context, alarm.payload.id)) {
                result.add(alarm.payload.id)
            } else {
                store.remove(alarm.payload.id)
            }
        }
        return result
    }

    /**
     * Re-arms every stored future alarm (BootReceiver). Entries whose fire
     * time has passed are dropped rather than posted late, so a reminder is
     * never shown after its start (R13.11); JS reconcile() on the next launch
     * covers anything still relevant.
     */
    fun rearmAll(context: Context, nowMs: Long = System.currentTimeMillis()) {
        val store = AlarmStore(context)
        for (alarm in store.all()) {
            if (alarm.fireAtMs > nowMs) {
                // Same exactness as before; arm() downgrades if exact is no longer allowed.
                // Upgrading inexact -> exact is left to JS reconcile() (R13.10).
                arm(context, alarm.payload, alarm.fireAtMs, alarm.exact)
            } else {
                store.remove(alarm.payload.id)
            }
        }
    }

    private fun alarmIntent(context: Context, id: String, flag: Int): PendingIntent? {
        val intent = Intent(context, AlarmReceiver::class.java).apply {
            action = ACTION_FIRE
            data = Uri.parse("timeblocker-alarm://fire/" + Uri.encode(id))
            putExtra(EXTRA_NOTIFICATION_ID, id)
        }
        return PendingIntent.getBroadcast(
            context,
            requestCode(id),
            intent,
            flag or PendingIntent.FLAG_IMMUTABLE,
        )
    }

    private fun alarmManager(context: Context): AlarmManager =
        context.getSystemService(Context.ALARM_SERVICE) as AlarmManager

    // --- Notifications ----------------------------------------------------------

    fun hasPostPermission(context: Context): Boolean {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
            ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) !=
            PackageManager.PERMISSION_GRANTED
        ) {
            return false
        }
        return NotificationManagerCompat.from(context).areNotificationsEnabled()
    }

    /** Posts the notification natively (AlarmReceiver, showNow). */
    @SuppressLint("MissingPermission") // checked by hasPostPermission()
    fun post(context: Context, payload: AlarmPayload) {
        AlarmChannels.ensure(context)
        if (!hasPostPermission(context)) {
            Log.w(TAG, "Notifications not permitted; dropping ${payload.id}")
            return
        }
        val channel = AlarmChannels.known(payload.channel)
        val highPriority = channel == AlarmChannels.REMINDERS || channel == AlarmChannels.PROMPTS
        val builder = NotificationCompat.Builder(context, AlarmChannels.channelId(channel))
            .setSmallIcon(android.R.drawable.ic_popup_reminder)
            .setContentTitle(payload.title)
            .setContentText(payload.body)
            .setStyle(NotificationCompat.BigTextStyle().bigText(payload.body))
            .setPriority(
                if (highPriority) NotificationCompat.PRIORITY_HIGH else NotificationCompat.PRIORITY_DEFAULT,
            )
            .setCategory(
                if (channel == AlarmChannels.STATUS) NotificationCompat.CATEGORY_STATUS
                else NotificationCompat.CATEGORY_REMINDER,
            )
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .setOnlyAlertOnce(false)
            .setAutoCancel(true)
            .setContentIntent(bodyIntent(context, payload))

        payload.timeoutMs?.takeIf { it > 0 }?.let { builder.setTimeoutAfter(it) }

        for (action in payload.actions) {
            builder.addAction(0, action.label, actionIntent(context, payload, action.id))
        }

        try {
            NotificationManagerCompat.from(context)
                .notify(payload.id, requestCode(payload.id), builder.build())
        } catch (e: SecurityException) {
            Log.w(TAG, "notify() rejected for ${payload.id}", e)
        }
    }

    fun dismiss(context: Context, id: String) {
        NotificationManagerCompat.from(context).cancel(id, requestCode(id))
    }

    /** Body tap: open the app at the deep link, or just launch it (R13.13). */
    private fun bodyIntent(context: Context, payload: AlarmPayload): PendingIntent? {
        val intent = payload.deepLink?.let { link ->
            Intent(Intent.ACTION_VIEW, Uri.parse(link)).setPackage(context.packageName)
        } ?: context.packageManager.getLaunchIntentForPackage(context.packageName)
            ?: return null
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
        return PendingIntent.getActivity(
            context,
            requestCode(payload.id + "#body"),
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
    }

    /** Action tap: explicit broadcast to the non-exported [ActionReceiver] (R13.4). */
    private fun actionIntent(context: Context, payload: AlarmPayload, actionId: String): PendingIntent {
        val intent = Intent(context, ActionReceiver::class.java).apply {
            action = ACTION_NOTIFICATION_ACTION
            data = Uri.parse(
                "timeblocker-alarm://action/" + Uri.encode(payload.id) + "/" + Uri.encode(actionId),
            )
            putExtra(EXTRA_NOTIFICATION_ID, payload.id)
            putExtra(EXTRA_KIND, payload.kind)
            putExtra(EXTRA_SOURCE_ID, payload.sourceId)
            payload.weekId?.let { putExtra(EXTRA_WEEK_ID, it) }
            putExtra(EXTRA_ACTION_ID, actionId)
        }
        return PendingIntent.getBroadcast(
            context,
            requestCode(payload.id + "#" + actionId),
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
    }
}
