import BackgroundFetch from 'react-native-background-fetch';
import { BackgroundFetchJobs, createHeadlessSyncTask } from './backgroundJobs';

jest.mock('react-native-background-fetch', () => ({
  __esModule: true,
  default: {
    STATUS_AVAILABLE: 2,
    configure: jest.fn(async () => 2),
    stop: jest.fn(async () => true),
    finish: jest.fn(),
  },
}));

const mocked = BackgroundFetch as jest.Mocked<typeof BackgroundFetch>;
const flush = () => new Promise(r => setTimeout(r, 0));

beforeEach(() => jest.clearAllMocks());

describe('BackgroundFetchJobs', () => {
  it('configures a 30-minute job that survives termination and reboot and runs headless', async () => {
    await new BackgroundFetchJobs(async () => {}).startPeriodicSync(30);
    expect(mocked.configure).toHaveBeenCalledWith(
      { minimumFetchInterval: 30, stopOnTerminate: false, startOnBoot: true, enableHeadless: true },
      expect.any(Function),
      expect.any(Function),
    );
  });

  it('runs the sync on each event and always finishes the task, even when sync fails', async () => {
    const onSync = jest.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('offline'));
    await new BackgroundFetchJobs(onSync).startPeriodicSync(30);
    const onEvent = mocked.configure.mock.calls[0]![1];
    onEvent('t1');
    onEvent('t2');
    await flush();
    expect(onSync).toHaveBeenCalledTimes(2);
    expect(mocked.finish).toHaveBeenCalledWith('t1');
    expect(mocked.finish).toHaveBeenCalledWith('t2');
  });

  it('finishes immediately on timeout', async () => {
    const onSync = jest.fn();
    await new BackgroundFetchJobs(onSync).startPeriodicSync(30);
    mocked.configure.mock.calls[0]![2]!('t3');
    expect(mocked.finish).toHaveBeenCalledWith('t3');
    expect(onSync).not.toHaveBeenCalled();
  });

  it('stopPeriodicSync stops all background-fetch tasks', async () => {
    await new BackgroundFetchJobs(async () => {}).stopPeriodicSync();
    expect(mocked.stop).toHaveBeenCalledWith();
  });
});

describe('createHeadlessSyncTask', () => {
  it('syncs then finishes, or just finishes on timeout', async () => {
    const onSync = jest.fn(async () => {});
    const task = createHeadlessSyncTask(onSync);
    await task({ taskId: 'h1', timeout: false });
    expect(onSync).toHaveBeenCalledTimes(1);
    expect(mocked.finish).toHaveBeenCalledWith('h1');
    await task({ taskId: 'h2', timeout: true });
    expect(onSync).toHaveBeenCalledTimes(1);
    expect(mocked.finish).toHaveBeenCalledWith('h2');
  });
});
