import * as Y from "yjs";
import type { SyncPart } from "@proto/protocol";

export type { SyncPart };

export const DEFAULT_MAX_CHUNK_BYTES = 48 * 1024;
export const DEFAULT_MAX_BYTES = 16 * 1024 * 1024;
export const DEFAULT_MAX_TOTAL_BYTES = 32 * 1024 * 1024;
export const DEFAULT_MAX_TRANSFERS = 8;
export const DEFAULT_MAX_PARTS = 4096;
export const DEFAULT_TTL_MS = 30_000;

const BASE64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const BASE64_VALUES = (() => {
  const table = new Int16Array(128);
  table.fill(-2);
  for (let i = 0; i < BASE64_ALPHABET.length; i++) {
    table[BASE64_ALPHABET.charCodeAt(i)] = i;
  }
  table["=".charCodeAt(0)] = -1;
  return table;
})();

export function toBase64(bytes: Uint8Array): string {
  let output = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i]!;
    const b1 = bytes[i + 1];
    const b2 = bytes[i + 2];
    output += BASE64_ALPHABET[b0 >> 2];
    output += BASE64_ALPHABET[((b0 & 0x03) << 4) | ((b1 ?? 0) >> 4)];
    output += b1 === undefined ? "=" : BASE64_ALPHABET[((b1 & 0x0f) << 2) | ((b2 ?? 0) >> 6)];
    output += b2 === undefined ? "=" : BASE64_ALPHABET[b2 & 0x3f];
  }
  return output;
}

export function fromBase64(value: string): Uint8Array | null {
  if (typeof value !== "string") return null;
  if (value.length === 0) return new Uint8Array(0);
  if (value.length % 4 !== 0) return null;

  let padding = 0;
  if (value.endsWith("==")) padding = 2;
  else if (value.endsWith("=")) padding = 1;

  const output = new Uint8Array((value.length / 4) * 3 - padding);
  let offset = 0;

  for (let i = 0; i < value.length; i += 4) {
    const last = i + 4 === value.length;
    const c0 = decodeChar(value, i, 0);
    const c1 = decodeChar(value, i, 1);
    const c2 = decodeChar(value, i, 2);
    const c3 = decodeChar(value, i, 3);
    if (c0 < 0 || c1 < 0) return null;

    if (c2 < 0) {
      if (c2 !== -1 || c3 !== -1 || !last || padding !== 2) return null;
      if ((c1 & 0x0f) !== 0) return null;
      output[offset++] = (c0 << 2) | (c1 >> 4);
    } else if (c3 < 0) {
      if (c3 !== -1 || !last || padding !== 1) return null;
      if ((c2 & 0x03) !== 0) return null;
      output[offset++] = (c0 << 2) | (c1 >> 4);
      output[offset++] = ((c1 & 0x0f) << 4) | (c2 >> 2);
    } else {
      output[offset++] = (c0 << 2) | (c1 >> 4);
      output[offset++] = ((c1 & 0x0f) << 4) | (c2 >> 2);
      output[offset++] = ((c2 & 0x03) << 6) | c3;
    }
  }

  return output;
}

function decodeChar(value: string, index: number, offset: number): number {
  const code = value.charCodeAt(index + offset);
  if (code >= BASE64_VALUES.length) return -2;
  return BASE64_VALUES[code]!;
}

export function encodeTransfer(
  update: Uint8Array,
  transferId: string,
  maxChunkBytes = DEFAULT_MAX_CHUNK_BYTES,
): SyncPart[] {
  if (typeof transferId !== "string" || transferId.length === 0) {
    throw new TypeError("transferId must be a non-empty string");
  }
  if (!Number.isInteger(maxChunkBytes) || maxChunkBytes <= 0) {
    throw new RangeError("maxChunkBytes must be a positive integer");
  }

  if (update.length === 0) {
    return [{ transferId, index: 0, count: 1, data: "" }];
  }

  const count = Math.ceil(update.length / maxChunkBytes);
  const parts: SyncPart[] = [];
  for (let index = 0; index < count; index++) {
    const start = index * maxChunkBytes;
    const end = Math.min(start + maxChunkBytes, update.length);
    parts.push({
      transferId,
      index,
      count,
      data: toBase64(update.subarray(start, end)),
    });
  }
  return parts;
}

export interface TransferAssemblerOptions {
  /** 1 つの転送で受け付ける最大バイト数。 */
  maxBytes?: number;
  /** 同時に保持するすべての転送の合計最大バイト数。 */
  maxTotalBytes?: number;
  maxTransfers?: number;
  /** 1 つの転送で受け付ける最大パート数。 */
  maxParts?: number;
  ttlMs?: number;
}

interface Assembly {
  count: number;
  parts: Map<number, Uint8Array>;
  bytes: number;
  createdAt: number;
}

export class TransferAssembler {
  private readonly maxBytes: number;
  private readonly maxTotalBytes: number;
  private readonly maxTransfers: number;
  private readonly maxParts: number;
  private readonly ttlMs: number;
  private readonly transfers = new Map<string, Assembly>();
  private totalBytes = 0;
  /** 巻き戻された now で TTL が延びないよう、時刻は単調増加に丸める。 */
  private lastNow = Number.NEGATIVE_INFINITY;

  constructor(options: TransferAssemblerOptions = {}) {
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    this.maxTotalBytes = options.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES;
    this.maxTransfers = options.maxTransfers ?? DEFAULT_MAX_TRANSFERS;
    this.maxParts = options.maxParts ?? DEFAULT_MAX_PARTS;
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    if (!Number.isInteger(this.maxBytes) || this.maxBytes <= 0) {
      throw new RangeError("maxBytes must be a positive integer");
    }
    if (!Number.isInteger(this.maxTotalBytes) || this.maxTotalBytes <= 0) {
      throw new RangeError("maxTotalBytes must be a positive integer");
    }
    if (!Number.isInteger(this.maxTransfers) || this.maxTransfers <= 0) {
      throw new RangeError("maxTransfers must be a positive integer");
    }
    if (!Number.isInteger(this.maxParts) || this.maxParts <= 0) {
      throw new RangeError("maxParts must be a positive integer");
    }
    if (!Number.isFinite(this.ttlMs) || this.ttlMs <= 0) {
      throw new RangeError("ttlMs must be a positive finite number");
    }
  }

  accept(part: SyncPart, now: number = Date.now()): Uint8Array | null {
    if (!isValidPart(part, this.maxParts)) return null;
    const timestamp = this.clock(now);
    this.expire(timestamp);

    let assembly = this.transfers.get(part.transferId);
    if (assembly === undefined) {
      if (this.transfers.size >= this.maxTransfers) this.evictOldest();
      assembly = { count: part.count, parts: new Map(), bytes: 0, createdAt: timestamp };
      this.transfers.set(part.transferId, assembly);
    } else if (assembly.count !== part.count) {
      this.remove(part.transferId);
      return null;
    }

    if (assembly.parts.has(part.index)) return null;

    const maxEncodedLength = Math.ceil(this.maxBytes / 3) * 4;
    if (part.data.length > maxEncodedLength) {
      this.remove(part.transferId);
      return null;
    }
    const bytes = fromBase64(part.data);
    if (bytes === null) {
      this.remove(part.transferId);
      return null;
    }
    if (
      bytes.length > this.maxBytes ||
      assembly.bytes + bytes.length > this.maxBytes ||
      this.totalBytes + bytes.length > this.maxTotalBytes
    ) {
      this.remove(part.transferId);
      return null;
    }

    assembly.parts.set(part.index, bytes);
    assembly.bytes += bytes.length;
    this.totalBytes += bytes.length;
    if (assembly.parts.size !== assembly.count) return null;

    const output = new Uint8Array(assembly.bytes);
    let offset = 0;
    for (let index = 0; index < assembly.count; index++) {
      const chunk = assembly.parts.get(index);
      if (chunk === undefined) return null;
      output.set(chunk, offset);
      offset += chunk.length;
    }
    this.remove(part.transferId);
    return output;
  }

  private clock(now: number): number {
    const timestamp = Number.isFinite(now) ? now : Date.now();
    if (timestamp > this.lastNow) this.lastNow = timestamp;
    return this.lastNow;
  }

  private expire(now: number): void {
    for (const [transferId, assembly] of this.transfers) {
      if (now - assembly.createdAt > this.ttlMs) this.remove(transferId);
    }
  }

  private evictOldest(): void {
    let oldestId: string | undefined;
    let oldestAt = Number.POSITIVE_INFINITY;
    for (const [transferId, assembly] of this.transfers) {
      if (assembly.createdAt < oldestAt) {
        oldestAt = assembly.createdAt;
        oldestId = transferId;
      }
    }
    if (oldestId !== undefined) this.remove(oldestId);
  }

  private remove(transferId: string): void {
    const assembly = this.transfers.get(transferId);
    if (assembly === undefined) return;
    this.totalBytes -= assembly.bytes;
    this.transfers.delete(transferId);
  }
}

function isValidPart(part: SyncPart, maxParts: number): boolean {
  if (typeof part !== "object" || part === null) return false;
  if (typeof part.transferId !== "string" || part.transferId.length === 0) return false;
  if (part.transferId.length > 256) return false;
  if (!Number.isInteger(part.index) || part.index < 0) return false;
  if (!Number.isInteger(part.count) || part.count < 1) return false;
  if (part.count > maxParts) return false;
  if (part.index >= part.count) return false;
  if (typeof part.data !== "string") return false;
  return true;
}

export function stateVectorEquals(a: Uint8Array, b: Uint8Array): boolean {
  try {
    const left = Y.decodeStateVector(a);
    const right = Y.decodeStateVector(b);
    if (left.size !== right.size) return false;
    for (const [clientId, clock] of left) {
      if (right.get(clientId) !== clock) return false;
    }
    return true;
  } catch {
    return false;
  }
}
