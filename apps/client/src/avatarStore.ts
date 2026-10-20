import { MAX_AVATAR_BYTES } from "@proto/protocol";

/**
 * 入室画面で入力した表示名と、選んだ VRM を、ブラウザに保存しておく。
 * 表示名は小さな文字列なので localStorage、VRM は数 MB〜64MB になるので IndexedDB に置く。
 * 保存できなくても (プライベートモード・容量不足など)、入室はできる。
 */

const NAME_KEY = "vr-sns:name";
const DB_NAME = "vr-sns";
const DB_VERSION = 1;
const STORE = "settings";
const AVATAR_KEY = "avatar";

interface StoredAvatar {
  name: string;
  type: string;
  lastModified: number;
  data: Blob;
}

function hasIndexedDb(): boolean {
  return typeof indexedDB !== "undefined";
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB を開けませんでした"));
  });
}

export function loadSavedName(): string {
  try {
    return localStorage.getItem(NAME_KEY) ?? "";
  } catch {
    return "";
  }
}

export function saveName(name: string): void {
  try {
    localStorage.setItem(NAME_KEY, name);
  } catch {
    // 保存できなくても、入室はできる
  }
}

/** 前回選んだ VRM を返す (無ければ null)。 */
export async function loadSavedAvatar(): Promise<File | null> {
  if (!hasIndexedDb()) return null;
  try {
    const db = await openDb();
    const record = await new Promise<StoredAvatar | undefined>((resolve, reject) => {
      const request = db.transaction(STORE, "readonly").objectStore(STORE).get(AVATAR_KEY);
      request.onsuccess = () => resolve(request.result as StoredAvatar | undefined);
      request.onerror = () => reject(request.error);
    });
    db.close();
    if (!record) return null;
    return new File([record.data], record.name, { type: record.type, lastModified: record.lastModified });
  } catch (err) {
    console.warn("[avatar-store] 保存したアバターを読み込めませんでした:", err);
    return null;
  }
}

/** 選んだ VRM を保存する (上限を超えるものは保存しない)。 */
export async function saveAvatar(file: File): Promise<void> {
  if (file.size > MAX_AVATAR_BYTES || !hasIndexedDb()) return;
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const record: StoredAvatar = {
        name: file.name,
        type: file.type,
        lastModified: file.lastModified,
        data: file,
      };
      const request = db.transaction(STORE, "readwrite").objectStore(STORE).put(record, AVATAR_KEY);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
    db.close();
  } catch (err) {
    console.warn("[avatar-store] アバターを保存できませんでした:", err);
  }
}

/** 保存した VRM を消す。 */
export async function clearSavedAvatar(): Promise<void> {
  if (!hasIndexedDb()) return;
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const request = db.transaction(STORE, "readwrite").objectStore(STORE).delete(AVATAR_KEY);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
    db.close();
  } catch (err) {
    console.warn("[avatar-store] 保存したアバターを消せませんでした:", err);
  }
}
