import type {
  PrerenderCacheEntry,
  PrerenderTagManifestEntry,
  PrerenderTagManifestUpdate,
} from './isr.js';
import { bytesFromUtf8, decodeBase64ToBytes, encodeBase64FromBytes, utf8FromBytes } from './binary.js';

export const DEFAULT_CACHE_HTTP_ENDPOINT_PATH = '/_adapter/cache';
export const CACHE_HTTP_AUTH_HEADER = 'x-adapter-cache-auth';

export interface SerializedPrerenderCacheEntry
  extends Omit<PrerenderCacheEntry, 'body'> {
  bodyBase64: string;
}

export type CacheHttpRequest =
  | {
      op: 'getEntry';
      cacheKey: string;
    }
  | {
      op: 'setEntry';
      cacheKey: string;
      entry: SerializedPrerenderCacheEntry;
    }
  | {
      op: 'findByPrefix';
      cacheKeyPrefix: string;
    }
  | {
      op: 'getTagManifestEntries';
      tags: string[];
    }
  | {
      op: 'updateTagManifest';
      tags: string[];
      update: PrerenderTagManifestUpdate;
    };

export type CacheHttpResponse =
  | {
      ok: true;
      entry: SerializedPrerenderCacheEntry | null;
    }
  | {
      ok: true;
      entries: SerializedPrerenderCacheEntry[];
    }
  | {
      ok: true;
      manifest: Record<string, PrerenderTagManifestEntry>;
    }
  | {
      ok: true;
    }
  | {
      ok: false;
      error: string;
    };

function normalizeEntryBody(entry: PrerenderCacheEntry): Uint8Array {
  if (typeof entry.body === 'string') {
    return bytesFromUtf8(entry.body);
  }
  return entry.body;
}

export function serializePrerenderCacheEntry(
  entry: PrerenderCacheEntry
): SerializedPrerenderCacheEntry {
  const { body, ...rest } = entry;

  return {
    ...rest,
    bodyBase64: encodeBase64FromBytes(normalizeEntryBody(entry)),
  };
}

export function deserializePrerenderCacheEntry(
  entry: SerializedPrerenderCacheEntry
): PrerenderCacheEntry {
  const { bodyBase64, ...rest } = entry;
  const decodedBody = decodeBase64ToBytes(bodyBase64);

  return {
    ...rest,
    body:
      entry.bodyEncoding === 'base64' ? utf8FromBytes(decodedBody) : decodedBody,
  };
}
