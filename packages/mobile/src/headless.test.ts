/**
 * Headless task handlers (task 25.2; R13.4, R14.3): notification actions are
 * routed to BlockActionService, invalid payloads are ignored, and the task
 * always resolves; the background-fetch handler syncs then finishes.
 */
import BackgroundFetch from 'react-native-background-fetch';
import {
  createBackgroundSyncTask,
  createNotificationActionTask,
  type HeadlessBlockActions,
} from './headless';

jest.mock('react-native-background-fetch', () => ({
  __esModule: true,
  default: { finish: jest.fn() },
}));

const finish = BackgroundFetch.finish as jest.Mock;

function fakeActions(): jest.Mocked<HeadlessBlockActions> {
  const notFound = async () => ({ kind: 'not-found' as const });
  return {
    imIn: jest.fn(notFound),
    skip: jest.fn(notFound),
    moveIt: jest.fn(notFound),
    answerPrompt: jest.fn(notFound),
    undo: jest.fn(async () => ({ kind: 'rejected' as const, reason: 'no-token' as const })),
  } as unknown as jest.Mocked<HeadlessBlockActions>;
}

const payload = (kind: string, actionId: string, extra: Record<string, unknown> = {}) => ({
  notificationId: `${kind}:n1`,
  kind,
  sourceId: 'b1',
  weekId: '2025-01-05',
  actionId,
  ...extra,
});

beforeEach(() => jest.clearAllMocks());

describe('createNotificationActionTask', () => {
  it.each([
    ['im-in', 'imIn'],
    ['skip', 'skip'],
    ['move-it', 'moveIt'],
  ] as const)('routes block-reminder %s to %s with the block ref and notification id', async (actionId, method) => {
    const actions = fakeActions();
    await createNotificationActionTask(() => ({ blockActions: actions }), { log: jest.fn() })(
      payload('block-reminder', actionId),
    );
    expect(actions[method]).toHaveBeenCalledWith(
      { blockId: 'b1', weekId: '2025-01-05' },
      { notificationId: 'block-reminder:n1' },
    );
  });

  it('routes miss-prompt answers to answerPrompt with the prompt id', async () => {
    const actions = fakeActions();
    const task = createNotificationActionTask(() => ({ blockActions: actions }), { log: jest.fn() });
    await task(payload('miss-prompt', 'yes'));
    await task(payload('miss-prompt', 'no', { weekId: undefined }));
    expect(actions.answerPrompt).toHaveBeenNthCalledWith(1, {
      promptId: 'miss-prompt:n1',
      answer: 'yes',
      weekId: '2025-01-05',
    });
    expect(actions.answerPrompt).toHaveBeenNthCalledWith(2, { promptId: 'miss-prompt:n1', answer: 'no' });
  });

  it('routes the status Undo action to undo for that block', async () => {
    const actions = fakeActions();
    await createNotificationActionTask(() => ({ blockActions: actions }), { log: jest.fn() })(
      payload('status', 'undo'),
    );
    expect(actions.undo).toHaveBeenCalledWith({ blockId: 'b1', notificationId: 'status:n1' });
  });

  it('ignores invalid payloads without building the runtime', async () => {
    const getRuntime = jest.fn(() => ({ blockActions: fakeActions() }));
    const log = jest.fn();
    const task = createNotificationActionTask(getRuntime, { log });
    for (const data of [null, 'x', {}, payload('block-reminder', 'yes'), payload('weekly-nudge', 'im-in')]) {
      await expect(task(data)).resolves.toBeUndefined();
    }
    expect(getRuntime).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledTimes(5);
  });

  it('resolves when the action or the runtime throws, logging only the error class', async () => {
    const actions = fakeActions();
    actions.skip.mockRejectedValueOnce(new TypeError('secret-token-abc'));
    const log = jest.fn();
    await expect(
      createNotificationActionTask(() => ({ blockActions: actions }), { log })(payload('block-reminder', 'skip')),
    ).resolves.toBeUndefined();
    await expect(
      createNotificationActionTask(
        () => {
          throw new Error('boom');
        },
        { log },
      )(payload('block-reminder', 'skip')),
    ).resolves.toBeUndefined();
    expect(log.mock.calls.map(c => c[0])).toEqual([
      'notification action block-reminder failed (TypeError)',
      'notification action block-reminder failed (Error)',
    ]);
    expect(JSON.stringify(log.mock.calls)).not.toContain('secret-token-abc');
  });

  it('resolves at the timeout when the action hangs', async () => {
    jest.useFakeTimers();
    try {
      const actions = fakeActions();
      actions.moveIt.mockReturnValue(new Promise(() => {}));
      const log = jest.fn();
      const done = jest.fn();
      void createNotificationActionTask(() => ({ blockActions: actions }), { log, timeoutMs: 4_000 })(
        payload('block-reminder', 'move-it'),
      ).then(done);
      await jest.advanceTimersByTimeAsync(3_999);
      expect(done).not.toHaveBeenCalled();
      await jest.advanceTimersByTimeAsync(1);
      expect(done).toHaveBeenCalled();
      expect(log).toHaveBeenCalledWith('notification action block-reminder did not finish within 4000 ms');
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('createBackgroundSyncTask', () => {
  it('runs the background sync, then finishes the task', async () => {
    const order: string[] = [];
    const backgroundSync = jest.fn(async () => {
      order.push('sync');
    });
    finish.mockImplementation(() => order.push('finish'));
    await createBackgroundSyncTask(() => ({ backgroundSync }))({ taskId: 't1', timeout: false });
    expect(order).toEqual(['sync', 'finish']);
    expect(finish).toHaveBeenCalledWith('t1');
  });

  it('finishes even when building the runtime or syncing fails', async () => {
    await createBackgroundSyncTask(() => {
      throw new Error('no runtime');
    })({ taskId: 't2', timeout: false });
    await createBackgroundSyncTask(() => ({ backgroundSync: jest.fn().mockRejectedValue(new Error('offline')) }))({
      taskId: 't3',
      timeout: false,
    });
    expect(finish).toHaveBeenCalledWith('t2');
    expect(finish).toHaveBeenCalledWith('t3');
  });

  it('finishes without syncing on timeout', async () => {
    const backgroundSync = jest.fn();
    await createBackgroundSyncTask(() => ({ backgroundSync }))({ taskId: 't4', timeout: true });
    expect(backgroundSync).not.toHaveBeenCalled();
    expect(finish).toHaveBeenCalledWith('t4');
  });
});
