import type { RegistryState, RegistryStorage } from './code-registry';

/**
 * Test stand-in for a Durable Object's state: the KV-style storage API and the alarm, in memory.
 * Values are cloned in and out, as the real storage serializes them.
 */
export class MemoryStorage implements RegistryStorage {
  readonly data = new Map<string, unknown>();
  alarm: number | null = null;

  async get<T>(key: string): Promise<T | undefined> {
    return this.data.has(key) ? (structuredClone(this.data.get(key)) as T) : undefined;
  }

  async put<T>(key: string, value: T): Promise<void> {
    this.data.set(key, structuredClone(value));
  }

  async delete(key: string): Promise<boolean> {
    return this.data.delete(key);
  }

  async list<T>(options: { prefix: string }): Promise<Map<string, T>> {
    const keys = [...this.data.keys()].filter((k) => k.startsWith(options.prefix)).sort();
    return new Map(keys.map((k) => [k, structuredClone(this.data.get(k)) as T]));
  }

  async getAlarm(): Promise<number | null> {
    return this.alarm;
  }

  async setAlarm(time: number): Promise<void> {
    this.alarm = time;
  }
}

export function memoryState(): RegistryState & { storage: MemoryStorage } {
  return { storage: new MemoryStorage() };
}
