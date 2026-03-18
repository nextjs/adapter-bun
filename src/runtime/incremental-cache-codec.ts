import type { IncrementalCacheValue } from 'next/dist/server/response-cache';
import {
  bytesFromUtf8,
  decodeBase64ToBytes,
  encodeBase64FromBytes,
  toBufferLike,
  utf8FromBytes,
} from './binary.js';

const MAP_MARKER = '__adapter_bun_type';
const BINARY_MARKER = '__adapter_bun_binary';
export const NULL_CACHE_ENTRY_MARKER = '__adapter_bun_null_cache_entry';

const KNOWN_CACHE_KINDS = new Set([
  'APP_PAGE',
  'APP_ROUTE',
  'PAGES',
  'FETCH',
  'REDIRECT',
  'IMAGE',
]);

function isBinaryView(value: unknown): value is ArrayBufferView {
  return ArrayBuffer.isView(value);
}

function toBinaryBytes(value: ArrayBuffer | ArrayBufferView): Uint8Array {
  if (value instanceof ArrayBuffer) {
    return new Uint8Array(value);
  }

  return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
}

export function encodeCacheValue(value: IncrementalCacheValue): string {
  return JSON.stringify(value, (_key, input) => {
    if (input instanceof Map) {
      return {
        [MAP_MARKER]: 'Map',
        entries: [...input.entries()],
      };
    }

    if (input instanceof ArrayBuffer || isBinaryView(input)) {
      return {
        [BINARY_MARKER]: true,
        data: encodeBase64FromBytes(toBinaryBytes(input)),
      };
    }

    return input;
  });
}

export function decodeCacheValue(payload: string): unknown {
  return JSON.parse(payload, (_key, input) => {
    if (
      input &&
      typeof input === 'object' &&
      'type' in input &&
      input.type === 'Buffer' &&
      'data' in input &&
      Array.isArray(input.data)
    ) {
      return toBufferLike(new Uint8Array(input.data));
    }

    if (
      input &&
      typeof input === 'object' &&
      BINARY_MARKER in input &&
      input[BINARY_MARKER] === true &&
      'data' in input &&
      typeof input.data === 'string'
    ) {
      return toBufferLike(decodeBase64ToBytes(input.data));
    }

    if (
      input &&
      typeof input === 'object' &&
      MAP_MARKER in input &&
      input[MAP_MARKER] === 'Map' &&
      'entries' in input &&
      Array.isArray(input.entries)
    ) {
      return new Map(input.entries);
    }

    return input;
  });
}

export function isCacheValue(value: unknown): value is IncrementalCacheValue {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return typeof record.kind === 'string' && KNOWN_CACHE_KINDS.has(record.kind);
}

export function isNullCacheValue(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return record[NULL_CACHE_ENTRY_MARKER] === true;
}

export function decodeStoredBodyBytes(row: {
  body: Uint8Array | string;
  bodyEncoding: 'binary' | 'base64';
}): Uint8Array {
  if (row.bodyEncoding === 'binary') {
    return typeof row.body === 'string' ? bytesFromUtf8(row.body) : row.body;
  }

  const encodedBody = typeof row.body === 'string' ? row.body : utf8FromBytes(row.body);
  return decodeBase64ToBytes(encodedBody);
}

export function decodeStoredBodyBuffer(row: {
  body: Uint8Array | string;
  bodyEncoding: 'binary' | 'base64';
}): Buffer {
  return toBufferLike(decodeStoredBodyBytes(row));
}

export function decodeStoredBodyText(row: {
  body: Uint8Array | string;
  bodyEncoding: 'binary' | 'base64';
}): string {
  return utf8FromBytes(decodeStoredBodyBytes(row));
}
