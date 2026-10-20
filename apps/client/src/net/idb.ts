/** Yjs の更新を保存する、小さな IndexedDB adapter。 */

export interface UpdateStore {
  load(): Promise<Uint8Array[]>;
  append(update: Uint8Array): Promise<void>;
  /**
   * ログをスナップショットに置き換える。merge を渡すと、同じ readwrite トランザクションで
   * 既存の行を読み、同期でまとめてから clear + add する (他のタブの行を消さない)。
   */
  compact(
    snapshot: Uint8Array,
    merge?: (snapshot: Uint8Array, existing: Uint8Array[]) => Uint8Array,
  ): Promise<void>;
  close(): void;
}

const STORE_NAME = "updates";

/** 保存された値を Uint8Array にそろえる (ArrayBuffer / 型付き配列の両方を受ける)。 */
function toBytes(value: unknown): Uint8Array | null {
  if (value instanceof Uint8Array) return new Uint8Array(value);
  if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0));
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
  }
  return null;
}

/** 開いてある DB を adapter にする (テストでは、同じ形の偽 DB を渡せる)。 */
export function createUpdateStore(db: IDBDatabase): UpdateStore {
  return {
    load(): Promise<Uint8Array[]> {
      return new Promise((resolve, reject) => {
        let values: unknown[] = [];
        let settled = false;
        const fail = (error: DOMException | null) => {
          if (settled) return;
          settled = true;
          reject(error ?? new Error("IndexedDB の読み込みに失敗しました"));
        };
        try {
          const tx = db.transaction(STORE_NAME, "readonly");
          tx.oncomplete = () => {
            if (settled) return;
            settled = true;
            const updates: Uint8Array[] = [];
            for (const value of values) {
              const bytes = toBytes(value);
              if (bytes) updates.push(bytes);
            }
            resolve(updates);
          };
          tx.onerror = () => fail(tx.error);
          tx.onabort = () => fail(tx.error);
          const request = tx.objectStore(STORE_NAME).getAll();
          request.onsuccess = () => {
            values = Array.isArray(request.result) ? request.result : [];
          };
        } catch (error) {
          if (settled) return;
          settled = true;
          reject(error);
        }
      });
    },

    append(update: Uint8Array): Promise<void> {
      return new Promise((resolve, reject) => {
        let settled = false;
        const fail = (error: DOMException | null) => {
          if (settled) return;
          settled = true;
          reject(error ?? new Error("IndexedDB への保存に失敗しました"));
        };
        try {
          const tx = db.transaction(STORE_NAME, "readwrite");
          // トランザクションが完了して初めて「保存済み」とする (request の成功では確定しない)
          tx.oncomplete = () => {
            if (settled) return;
            settled = true;
            resolve();
          };
          tx.onerror = () => fail(tx.error);
          tx.onabort = () => fail(tx.error);
          tx.objectStore(STORE_NAME).add(update);
        } catch (error) {
          if (settled) return;
          settled = true;
          reject(error);
        }
      });
    },

    compact(
      snapshot: Uint8Array,
      merge?: (snapshot: Uint8Array, existing: Uint8Array[]) => Uint8Array,
    ): Promise<void> {
      return new Promise((resolve, reject) => {
        let settled = false;
        const fail = (error: unknown) => {
          if (settled) return;
          settled = true;
          reject(error ?? new Error("IndexedDB の圧縮に失敗しました"));
        };
        try {
          // clear と add を同じ readwrite トランザクションで行う (途中で終われば元のまま)
          const tx = db.transaction(STORE_NAME, "readwrite");
          tx.oncomplete = () => {
            if (settled) return;
            settled = true;
            resolve();
          };
          tx.onerror = () => fail(tx.error);
          tx.onabort = () => fail(tx.error);
          const store = tx.objectStore(STORE_NAME);

          const replace = (value: Uint8Array): void => {
            store.clear();
            store.add(value);
          };

          if (merge === undefined) {
            replace(snapshot);
            return;
          }

          // 既存の行 (他のタブが書いたものを含む) を同じトランザクションで読み、
          // 同期でマージする。on success の中で次の request を積むので、トランザクションは生きたまま。
          const request = store.getAll();
          request.onsuccess = () => {
            let value: Uint8Array;
            try {
              const existing: Uint8Array[] = [];
              const values = Array.isArray(request.result) ? request.result : [];
              for (const row of values) {
                const bytes = toBytes(row);
                if (bytes) existing.push(bytes);
              }
              value = merge(snapshot, existing);
            } catch (error) {
              fail(error);
              try {
                tx.abort();
              } catch {
                // 既に終わっている
              }
              return;
            }
            replace(value);
          };
        } catch (error) {
          fail(error);
        }
      });
    },

    close(): void {
      db.close();
    },
  };
}

/** IndexedDB が使えない環境では null を返す (呼び出し側はメモリ保存へ切り替える)。 */
export async function openUpdateStore(dbName: string): Promise<UpdateStore | null> {
  const factory = globalThis.indexedDB;
  if (!factory) return null;
  try {
    const db = await new Promise<IDBDatabase | null>((resolve) => {
      let settled = false;
      const done = (value: IDBDatabase | null) => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      const request = factory.open(dbName, 1);
      request.onupgradeneeded = () => {
        const database = request.result;
        if (!database.objectStoreNames.contains(STORE_NAME)) {
          database.createObjectStore(STORE_NAME, { autoIncrement: true });
        }
      };
      request.onsuccess = () => done(request.result);
      request.onerror = () => done(null);
      request.onblocked = () => done(null);
    });
    return db ? createUpdateStore(db) : null;
  } catch {
    return null;
  }
}
