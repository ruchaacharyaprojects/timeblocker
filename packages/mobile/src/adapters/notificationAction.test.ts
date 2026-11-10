import { NOTIFICATION_ACTION_TASK_KEY, parseNotificationActionTask } from './notificationAction';

const base = { notificationId: 'n1', sourceId: 'b1', weekId: '2026-W10' };

describe('parseNotificationActionTask', () => {
  it('uses the Kotlin headless task key', () => {
    expect(NOTIFICATION_ACTION_TASK_KEY).toBe('TimeBlockerNotificationAction');
  });

  it.each(['im-in', 'skip', 'move-it'] as const)('parses block-reminder %s (skip is legacy: only already-armed notifications carry it)', action => {
    expect(parseNotificationActionTask({ ...base, kind: 'block-reminder', actionId: action })).toEqual({
      ok: true,
      event: { ...base, type: 'block-reminder', action },
    });
  });

  it.each(['yes', 'no'] as const)('parses miss-prompt %s', answer => {
    expect(parseNotificationActionTask({ ...base, kind: 'miss-prompt', actionId: answer })).toEqual({
      ok: true,
      event: { ...base, type: 'miss-prompt', answer },
    });
  });

  it('parses undo on a status notification', () => {
    expect(parseNotificationActionTask({ ...base, kind: 'status', actionId: 'undo' })).toEqual({
      ok: true,
      event: { ...base, type: 'undo' },
    });
  });

  it('omits an absent or empty weekId', () => {
    const r = parseNotificationActionTask({ notificationId: 'n', sourceId: 'b', kind: 'status', actionId: 'undo', weekId: '' });
    expect(r).toEqual({ ok: true, event: { notificationId: 'n', sourceId: 'b', type: 'undo' } });
  });

  it('rejects malformed data, unknown actions, and action/kind mismatches', () => {
    expect(parseNotificationActionTask(null).ok).toBe(false);
    expect(parseNotificationActionTask('x').ok).toBe(false);
    expect(parseNotificationActionTask({ ...base, kind: 'status' }).ok).toBe(false);
    expect(parseNotificationActionTask({ ...base, kind: 'block-reminder', actionId: 'snooze' }).ok).toBe(false);
    expect(parseNotificationActionTask({ ...base, kind: 'block-reminder', actionId: 'undo' }).ok).toBe(false);
    expect(parseNotificationActionTask({ ...base, kind: 'meeting-reminder', actionId: 'im-in' }).ok).toBe(false);
    expect(parseNotificationActionTask({ ...base, sourceId: '', kind: 'status', actionId: 'undo' })).toEqual({
      ok: false,
      reason: 'missing sourceId',
    });
  });
});
