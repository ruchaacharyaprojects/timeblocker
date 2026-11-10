/**
 * App entry (task 25.2; R13.4, R14.3): `index.js` registers the root
 * component and both headless tasks, and each registered handler reaches the
 * shared runtime lazily (BlockActionService / background sync + finish).
 */
import fs from 'node:fs';
import path from 'node:path';
import { AppRegistry } from 'react-native';
import BackgroundFetch from 'react-native-background-fetch';

jest.mock('react-native-background-fetch', () => ({
  __esModule: true,
  default: { registerHeadlessTask: jest.fn(), finish: jest.fn() },
}));
jest.mock('../src/App', () => ({ __esModule: true, default: () => null }));
jest.mock('../src/bootstrap', () => ({ __esModule: true, getAppRuntime: jest.fn() }));

const ENTRY = path.resolve(__dirname, '..', 'index.js');
const bgFetch = BackgroundFetch as unknown as { registerHeadlessTask: jest.Mock; finish: jest.Mock };

describe('index.js (static)', () => {
  const source = fs.readFileSync(ENTRY, 'utf8');

  it('registers the app component and both headless tasks', () => {
    expect(source).toMatch(/AppRegistry\.registerComponent\(\s*appName\s*,\s*\(\)\s*=>\s*App\s*\)/);
    expect(source).toMatch(/AppRegistry\.registerHeadlessTask\(\s*NOTIFICATION_ACTION_TASK_KEY\s*,/);
    expect(source).toMatch(/BackgroundFetch\.registerHeadlessTask\(/);
  });
});

describe('index.js (registered handlers)', () => {
  const registerComponent = jest.spyOn(AppRegistry, 'registerComponent').mockImplementation(() => 'TimeBlocker');
  const registerHeadlessTask = jest.spyOn(AppRegistry, 'registerHeadlessTask').mockImplementation(() => {});
  const { getAppRuntime } = jest.requireMock('../src/bootstrap') as { getAppRuntime: jest.Mock };

  beforeAll(() => {
    require('../index.js');
  });

  it('registers the root component under the app.json name without building the runtime', () => {
    expect(registerComponent).toHaveBeenCalledWith('TimeBlocker', expect.any(Function));
    expect(getAppRuntime).not.toHaveBeenCalled();
  });

  it('routes the notification-action task to BlockActionService', async () => {
    expect(registerHeadlessTask).toHaveBeenCalledWith('TimeBlockerNotificationAction', expect.any(Function));
    const imIn = jest.fn(async () => ({ kind: 'not-found' }));
    getAppRuntime.mockReturnValue({ blockActions: { imIn } });
    const task = registerHeadlessTask.mock.calls[0]![1]() as (data: unknown) => Promise<void>;
    await expect(
      task({ notificationId: 'reminder:b1', kind: 'block-reminder', sourceId: 'b1', weekId: '2025-01-05', actionId: 'im-in' }),
    ).resolves.toBeUndefined();
    expect(imIn).toHaveBeenCalledWith({ blockId: 'b1', weekId: '2025-01-05' }, { notificationId: 'reminder:b1' });
  });

  it('runs a background sync from the background-fetch headless task, then finishes', async () => {
    expect(bgFetch.registerHeadlessTask).toHaveBeenCalledTimes(1);
    const backgroundSync = jest.fn(async () => {});
    getAppRuntime.mockReturnValue({ backgroundSync });
    const task = bgFetch.registerHeadlessTask.mock.calls[0]![0] as (e: { taskId: string; timeout: boolean }) => Promise<void>;
    await task({ taskId: 'bg1', timeout: false });
    expect(backgroundSync).toHaveBeenCalledTimes(1);
    expect(bgFetch.finish).toHaveBeenCalledWith('bg1');
  });
});
