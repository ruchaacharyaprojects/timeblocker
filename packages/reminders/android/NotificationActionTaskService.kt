package com.timeblocker.reminders

import android.content.Intent
import com.facebook.react.HeadlessJsTaskService
import com.facebook.react.bridge.Arguments
import com.facebook.react.jstasks.HeadlessJsTaskConfig
import java.util.concurrent.CopyOnWriteArraySet

/**
 * Runs the JS notification-action task headlessly (R13.4): the task calls
 * `BlockActionService` and resolves; when every task has finished (or hit the
 * 4.5 s timeout) the base class stops the service and [onDestroy] dismisses
 * the notifications it handled. The app's UI never opens.
 *
 * JS registers the task with
 * `AppRegistry.registerHeadlessTask("TimeBlockerNotificationAction", ...)`;
 * the data is `{ notificationId, kind, sourceId, weekId?, actionId }`.
 *
 * Manifest (23.2): `<service android:name="com.timeblocker.reminders.NotificationActionTaskService"
 * android:exported="false" />`.
 */
class NotificationActionTaskService : HeadlessJsTaskService() {
    private val handledIds = CopyOnWriteArraySet<String>()

    override fun getTaskConfig(intent: Intent?): HeadlessJsTaskConfig? {
        val extras = intent?.extras ?: return null
        val notificationId = extras.getString(AlarmScheduler.EXTRA_NOTIFICATION_ID) ?: return null
        handledIds.add(notificationId)
        return HeadlessJsTaskConfig(
            HEADLESS_TASK_KEY,
            Arguments.fromBundle(extras),
            TASK_TIMEOUT_MS,
            true, // allowed in foreground: a tap while the app is open still works
        )
    }

    override fun onDestroy() {
        // R13.4 / R13.12: dismiss the notification once the action was applied.
        for (id in handledIds) {
            AlarmScheduler.dismiss(this, id)
        }
        handledIds.clear()
        super.onDestroy()
    }

    companion object {
        const val HEADLESS_TASK_KEY = "TimeBlockerNotificationAction"

        /** Leaves headroom inside the 5 s budget of R13.4. */
        const val TASK_TIMEOUT_MS = 4500L
    }
}
