package com.timeblocker.reminders

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.ReadableArray
import com.facebook.react.bridge.ReadableMap
import com.facebook.react.bridge.WritableMap
import com.facebook.react.modules.core.DeviceEventManagerModule

/**
 * Android native module for TimeBlocker custom reminders (R5).
 *
 * Renders the custom notifications selected on the backend (R5.1) as Android
 * notifications carrying the "I'm in" / "Skip" / "Move it" action buttons
 * (R5.2), and forwards action-button taps back to JS as a
 * `TimeBlockerReminderAction` device event. This mirrors the usage-metrics
 * native module: a small, policy-free bridge surface. Which blocks/meetings
 * get a reminder, and what each button does, is decided in the shared TS/
 * backend layer, not here.
 */
class RemindersModule(reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

    private val actionReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) {
            val event: WritableMap = Arguments.createMap().apply {
                putString("notificationId", intent.getStringExtra(EXTRA_NOTIFICATION_ID))
                putString("kind", intent.getStringExtra(EXTRA_KIND))
                putString("sourceId", intent.getStringExtra(EXTRA_SOURCE_ID))
                putString("actionId", intent.getStringExtra(EXTRA_ACTION_ID))
            }
            emitActionEvent(event)
            // Dismiss the notification once the user has acted on it.
            intent.getStringExtra(EXTRA_NOTIFICATION_ID)?.let { id ->
                NotificationManagerCompat.from(reactApplicationContext)
                    .cancel(id.hashCode())
            }
        }
    }

    init {
        ensureChannel()
        val filter = IntentFilter(ACTION_REMINDER_BUTTON)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            reactContext.registerReceiver(
                actionReceiver,
                filter,
                Context.RECEIVER_NOT_EXPORTED,
            )
        } else {
            @Suppress("UnspecifiedRegisterReceiverFlag")
            reactContext.registerReceiver(actionReceiver, filter)
        }
    }

    override fun getName(): String = "Reminders"

    override fun invalidate() {
        runCatching { reactApplicationContext.unregisterReceiver(actionReceiver) }
        super.invalidate()
    }

    /**
     * Render an actionable notification with the three buttons (R5.2). The
     * `notification` map carries { id, kind, sourceId, title, body, actions }
     * where `actions` is [{ id, label }]. Resolves once posted.
     */
    @ReactMethod
    fun presentReminder(notification: ReadableMap, promise: Promise) {
        try {
            val id = notification.getString("id")
                ?: throw IllegalArgumentException("notification.id is required")
            val kind = notification.getString("kind") ?: ""
            val sourceId = notification.getString("sourceId") ?: ""
            val title = notification.getString("title") ?: ""
            val body = notification.getString("body") ?: ""
            val actions = notification.getArray("actions")

            val builder = NotificationCompat.Builder(reactApplicationContext, CHANNEL_ID)
                .setContentTitle(title)
                .setContentText(body)
                .setSmallIcon(android.R.drawable.ic_popup_reminder)
                .setPriority(NotificationCompat.PRIORITY_HIGH)
                .setAutoCancel(true)

            addActionButtons(builder, id, kind, sourceId, actions)

            NotificationManagerCompat.from(reactApplicationContext)
                .notify(id.hashCode(), builder.build())
            promise.resolve(null)
        } catch (e: Exception) {
            promise.reject("PRESENT_REMINDER_FAILED", e)
        }
    }

    /** Cancel a previously-presented notification by id. */
    @ReactMethod
    fun cancelReminder(notificationId: String, promise: Promise) {
        try {
            NotificationManagerCompat.from(reactApplicationContext)
                .cancel(notificationId.hashCode())
            promise.resolve(null)
        } catch (e: Exception) {
            promise.reject("CANCEL_REMINDER_FAILED", e)
        }
    }

    /**
     * Required by RCTEventEmitter contract; the JS side subscribes via
     * NativeEventEmitter for "TimeBlockerReminderAction".
     */
    @ReactMethod
    fun addListener(eventName: String) {
        // No-op: registration is handled by NativeEventEmitter on the JS side.
    }

    @ReactMethod
    fun removeListeners(count: Int) {
        // No-op: see addListener.
    }

    private fun addActionButtons(
        builder: NotificationCompat.Builder,
        notificationId: String,
        kind: String,
        sourceId: String,
        actions: ReadableArray?,
    ) {
        if (actions == null) return
        for (i in 0 until actions.size()) {
            val action = actions.getMap(i) ?: continue
            val actionId = action.getString("id") ?: continue
            val label = action.getString("label") ?: actionId

            val intent = Intent(ACTION_REMINDER_BUTTON).apply {
                setPackage(reactApplicationContext.packageName)
                putExtra(EXTRA_NOTIFICATION_ID, notificationId)
                putExtra(EXTRA_KIND, kind)
                putExtra(EXTRA_SOURCE_ID, sourceId)
                putExtra(EXTRA_ACTION_ID, actionId)
            }
            // Distinct requestCode per (notification, action) so PendingIntents
            // do not collapse into one another.
            val requestCode = (notificationId + actionId).hashCode()
            val flags =
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
            val pending = PendingIntent.getBroadcast(
                reactApplicationContext,
                requestCode,
                intent,
                flags,
            )
            builder.addAction(0, label, pending)
        }
    }

    private fun emitActionEvent(event: WritableMap) {
        reactApplicationContext
            .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
            .emit(EVENT_REMINDER_ACTION, event)
    }

    private fun ensureChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val manager = reactApplicationContext
                .getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            val channel = NotificationChannel(
                CHANNEL_ID,
                "Block & meeting reminders",
                NotificationManager.IMPORTANCE_HIGH,
            ).apply {
                description = "15-minute reminders before blocks and meetings (R5)."
            }
            manager.createNotificationChannel(channel)
        }
    }

    private companion object {
        const val CHANNEL_ID = "timeblocker-reminders"
        const val EVENT_REMINDER_ACTION = "TimeBlockerReminderAction"
        const val ACTION_REMINDER_BUTTON = "com.timeblocker.reminders.ACTION_BUTTON"
        const val EXTRA_NOTIFICATION_ID = "notificationId"
        const val EXTRA_KIND = "kind"
        const val EXTRA_SOURCE_ID = "sourceId"
        const val EXTRA_ACTION_ID = "actionId"
    }
}
