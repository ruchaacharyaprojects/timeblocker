/**
 * App entry (task 25.2; R13.4, R14.3). Registers the root component and the
 * two headless tasks. Each task builds the shared runtime lazily, so a
 * headless start with no UI still composes the services.
 *
 * @format
 */
import { AppRegistry } from 'react-native';
import BackgroundFetch from 'react-native-background-fetch';
import App from './src/App';
import { name as appName } from './app.json';
import { getAppRuntime } from './src/bootstrap';
import { NOTIFICATION_ACTION_TASK_KEY } from './src/adapters/notificationAction';
import { createBackgroundSyncTask, createNotificationActionTask } from './src/headless';

AppRegistry.registerComponent(appName, () => App);

// Notification action buttons (NotificationActionTaskService.kt) → BlockActionService.
AppRegistry.registerHeadlessTask(NOTIFICATION_ACTION_TASK_KEY, () =>
  createNotificationActionTask(getAppRuntime),
);

// Periodic background sync after the app was terminated → sync("background"), then finish.
BackgroundFetch.registerHeadlessTask(createBackgroundSyncTask(getAppRuntime));
