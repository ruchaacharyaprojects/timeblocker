import type { AsyncStorage } from '@react-native-async-storage/async-storage';
import { createAsyncStorage, clearAllMockStorages } from '@react-native-async-storage/async-storage/jest';
import { AsyncStorageKeyValueStore, STORAGE_NAME } from './keyValueStore';
import { KeyedMutex } from './keyedMutex';

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest'),
);

afterEach(() => clearAllMockStorages());

describe('AsyncStorageKeyValueStore', () => {
  it('opens the "timeblocker" AsyncStorage instance by default', async () => {
    const store = new AsyncStorageKeyValueStore();
    await store.set('settings', '{"schemaVersion":1}');
    // The library mock keeps one storage per database name.
    expect(await createAsyncStorage(STORAGE_NAME).getItem('settings')).toBe('{"schemaVersion":1}');
    expect(await createAsyncStorage('other').getItem('settings')).toBeNull();
  });

  it('round-trips get/set/getMany/setMany/remove', async () => {
    const store = new AsyncStorageKeyValueStore(createAsyncStorage('t1'));
    expect(await store.get('a')).toBeNull();
    await store.set('a', '1');
    await store.setMany([
      ['b', '2'],
      ['c', '3'],
    ]);
    expect(await store.get('a')).toBe('1');
    expect(await store.getMany(['c', 'missing', 'a'])).toEqual([
      ['c', '3'],
      ['missing', null],
      ['a', '1'],
    ]);
    await store.remove(['a', 'c']);
    expect(await store.getMany(['a', 'b', 'c'])).toEqual([
      ['a', null],
      ['b', '2'],
      ['c', null],
    ]);
  });

  it('handles empty batches without touching storage', async () => {
    const store = new AsyncStorageKeyValueStore(createAsyncStorage('t2'));
    await expect(store.getMany([])).resolves.toEqual([]);
    await expect(store.setMany([])).resolves.toBeUndefined();
    await expect(store.remove([])).resolves.toBeUndefined();
  });

  it('serializes operations on the same key in call order, even when storage completes out of order', async () => {
    const log: string[] = [];
    const data = new Map<string, string>();
    // First write is slow, second fast: without the mutex the slow one would land last.
    const delays = [30, 0];
    const slowStorage = {
      getItem: async (k: string) => data.get(k) ?? null,
      setItem: async (k: string, v: string) => {
        log.push(`start ${v}`);
        await new Promise(r => setTimeout(r, delays.shift() ?? 0));
        data.set(k, v);
        log.push(`end ${v}`);
      },
    } as unknown as AsyncStorage;
    const store = new AsyncStorageKeyValueStore(slowStorage);
    await Promise.all([store.set('blocks:w', 'first'), store.set('blocks:w', 'second')]);
    expect(log).toEqual(['start first', 'end first', 'start second', 'end second']);
    expect(await store.get('blocks:w')).toBe('second');
  });
});

describe('KeyedMutex', () => {
  it('lets different keys run concurrently but serializes overlapping multi-key holders', async () => {
    const mutex = new KeyedMutex();
    const events: string[] = [];
    const task = (name: string, ms: number) => async () => {
      events.push(`+${name}`);
      await new Promise(r => setTimeout(r, ms));
      events.push(`-${name}`);
    };
    await Promise.all([
      mutex.run(['a'], task('A', 20)),
      mutex.run(['b'], task('B', 5)),
      mutex.run(['a', 'b'], task('AB', 0)),
    ]);
    // A and B overlap; AB waits for both.
    expect(events.slice(0, 2).sort()).toEqual(['+A', '+B']);
    expect(events.slice(-2)).toEqual(['+AB', '-AB']);
    expect(mutex.size).toBe(0);
  });

  it('releases the lock when the holder throws', async () => {
    const mutex = new KeyedMutex();
    await expect(mutex.run(['k'], async () => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    await expect(mutex.run(['k'], async () => 'ok')).resolves.toBe('ok');
    expect(mutex.size).toBe(0);
  });
});
