import { afterEach, describe, expect, it, vi } from "vitest";
import { createUpdateStore, openUpdateStore, type UpdateStore } from "./idb";

/** 本物の IndexedDB を使わない、最小限の偽 DB。 */
class FakeTable {
  readonly values = new Map<number, unknown>();
  nextKey = 1;
}

class FakeRequest<T> {
  result: T;
  onsuccess: (() => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(result: T) {
    this.result = result;
  }
}

class FakeObjectStore {
  constructor(
    private readonly table: FakeTable,
    private readonly tx: FakeTransaction,
  ) {}

  add(value: unknown): FakeRequest<number> {
    const key = this.table.nextKey++;
    const request = new FakeRequest(key);
    this.tx.beginRequest();
    queueMicrotask(() => {
      this.table.values.set(key, value);
      request.onsuccess?.();
      this.tx.endRequest();
    });
    return request;
  }

  getAll(): FakeRequest<unknown[]> {
    const request = new FakeRequest<unknown[]>([]);
    this.tx.beginRequest();
    queueMicrotask(() => {
      request.result = [...this.table.values.values()];
      request.onsuccess?.();
      this.tx.endRequest();
    });
    return request;
  }

  clear(): FakeRequest<undefined> {
    const request = new FakeRequest(undefined);
    this.tx.beginRequest();
    queueMicrotask(() => {
      this.table.values.clear();
      request.onsuccess?.();
      this.tx.endRequest();
    });
    return request;
  }
}

class FakeTransaction {
  oncomplete: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  error: DOMException | null = null;

  private pending = 0;
  private completed = false;
  store: FakeObjectStore | null = null;

  objectStore(): FakeObjectStore {
    if (!this.store) throw new Error("no store");
    return this.store;
  }

  beginRequest(): void {
    this.pending++;
  }

  endRequest(): void {
    this.pending--;
    if (this.pending === 0) queueMicrotask(() => this.finish());
  }

  private finish(): void {
    if (this.completed || this.pending > 0) return;
    this.completed = true;
    this.oncomplete?.();
  }
}

class FakeDatabase {
  readonly tables = new Map<string, FakeTable>();
  readonly objectStoreNames = {
    contains: (name: string) => this.tables.has(name),
  };

  createObjectStore(name: string): void {
    this.tables.set(name, new FakeTable());
  }

  transaction(name: string): FakeTransaction {
    const table = this.tables.get(name);
    if (!table) throw new Error(`missing store ${name}`);
    const tx = new FakeTransaction();
    tx.store = new FakeObjectStore(table, tx);
    return tx;
  }

  close(): void {
    // 何もしない
  }
}

function bytes(value: number): Uint8Array {
  return new Uint8Array([value]);
}

function fakeStore(): { store: UpdateStore; db: FakeDatabase } {
  const db = new FakeDatabase();
  db.createObjectStore("updates");
  return { store: createUpdateStore(db as unknown as IDBDatabase), db };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("UpdateStore", () => {
  it("loads appended updates in key order", async () => {
    const { store } = fakeStore();
    await store.append(bytes(1));
    await store.append(bytes(2));
    await store.append(bytes(3));

    const loaded = await store.load();
    expect(loaded.map((update) => update[0])).toEqual([1, 2, 3]);
  });

  it("replaces all records atomically when compacting", async () => {
    const { store } = fakeStore();
    await store.append(bytes(1));
    await store.append(bytes(2));

    await store.compact(bytes(9));
    expect((await store.load()).map((update) => update[0])).toEqual([9]);

    await store.append(bytes(10));
    expect((await store.load()).map((update) => update[0])).toEqual([9, 10]);
  });

  it("returns null when IndexedDB is unavailable", async () => {
    vi.stubGlobal("indexedDB", undefined);
    await expect(openUpdateStore("proto-crdt:test")).resolves.toBeNull();
  });
});
