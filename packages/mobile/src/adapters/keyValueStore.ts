/**
 * `KeyValueStore` over AsyncStorage v3 (D6, R12.7).
 *
 * One named instance, `createAsyncStorage("timeblocker")`, holds JSON
 * documents. Every operation holds a per-key mutex for the keys it touches so
 * concurrent writers (UI and headless tasks) are applied in call order.
 * Nothing secret is stored here; tokens live only in the TokenVault (R12.2).
 */
import { createAsyncStorage, type AsyncStorage } from '@react-native-async-storage/async-storage';
import type { KeyValueStore } from '@timeblocker/app-core';
import { KeyedMutex } from './keyedMutex';

/** The AsyncStorage database name used by the app. */
export const STORAGE_NAME = 'timeblocker';

export class AsyncStorageKeyValueStore implements KeyValueStore {
  private readonly mutex = new KeyedMutex();

  constructor(private readonly storage: AsyncStorage = createAsyncStorage(STORAGE_NAME)) {}

  get(key: string): Promise<string | null> {
    return this.mutex.run([key], () => this.storage.getItem(key));
  }

  set(key: string, value: string): Promise<void> {
    return this.mutex.run([key], () => this.storage.setItem(key, value));
  }

  async getMany(
    keys: readonly string[],
  ): Promise<ReadonlyArray<readonly [key: string, value: string | null]>> {
    if (keys.length === 0) return [];
    const found = await this.mutex.run(keys, () => this.storage.getMany([...new Set(keys)]));
    return keys.map(k => [k, found[k] ?? null] as const);
  }

  async setMany(entries: ReadonlyArray<readonly [key: string, value: string]>): Promise<void> {
    if (entries.length === 0) return;
    const record: Record<string, string> = {};
    for (const [k, v] of entries) record[k] = v; // later entries win
    await this.mutex.run(
      entries.map(([k]) => k),
      () => this.storage.setMany(record),
    );
  }

  async remove(keys: readonly string[]): Promise<void> {
    if (keys.length === 0) return;
    await this.mutex.run(keys, () => this.storage.removeMany([...new Set(keys)]));
  }
}
