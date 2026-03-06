import { getSharedPrerenderCacheStore } from './cache-store.js';
import type {
  CacheEntry,
  CacheHandler as NextUseCacheHandler,
  Timestamp,
} from 'next/dist/server/lib/cache-handlers/types';

const CACHE_TAGS_HEADER = 'x-next-cache-tags';
const CACHE_STALE_HEADER = 'x-next-cache-stale';

function getStore() {
  return getSharedPrerenderCacheStore();
}

const pendingSets = new Map<string, Promise<void>>();

function readStoredTags(headers: Record<string, string>): string[] {
  const raw = headers[CACHE_TAGS_HEADER];
  if (typeof raw !== 'string' || raw.length === 0) return [];
  return raw
    .split(',')
    .map((tag) => tag.trim())
    .filter((tag) => tag.length > 0);
}

function readStoredStale(
  headers: Record<string, string>,
  fallbackStale: number
): number {
  const raw = headers[CACHE_STALE_HEADER];
  if (typeof raw !== 'string' || raw.length === 0) {
    return fallbackStale;
  }

  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallbackStale;
}

class CacheHandler implements NextUseCacheHandler {
  async get(
    cacheKey: string,
    _softTags: string[]
  ): Promise<undefined | CacheEntry> {
    const pendingPromise = pendingSets.get(cacheKey);
    if (pendingPromise) {
      await pendingPromise;
    }

    const store = getStore();
    const row = store.get(cacheKey);
    if (!row) return undefined;

    // Compute durations from absolute timestamps
    let revalidateSec =
      row.revalidateAt !== null
        ? Math.max(0, Math.floor((row.revalidateAt - row.createdAt) / 1000))
        : 31536000; // 1 year default
    const expireSec =
      row.expiresAt !== null
        ? Math.max(0, Math.floor((row.expiresAt - row.createdAt) / 1000))
        : revalidateSec * 2;
    const tags = readStoredTags(row.headers);

    if (tags.length > 0) {
      const tagEntries = store.getTagManifestEntries?.(tags);
      if (tagEntries) {
        const now = Date.now();
        for (const tag of tags) {
          const tagEntry = tagEntries[tag];
          if (!tagEntry) continue;

          const expiredAt = tagEntry.expiredAt;
          if (
            typeof expiredAt === 'number' &&
            expiredAt <= now &&
            expiredAt > row.createdAt
          ) {
            return undefined;
          }

          const staleAt = tagEntry.staleAt;
          if (typeof staleAt === 'number' && staleAt > row.createdAt) {
            revalidateSec = -1;
          }
        }
      }
    }

    const staleSec = readStoredStale(row.headers, revalidateSec);

    // Convert stored base64 body to ReadableStream
    const bodyBuffer = Buffer.from(row.body, 'base64');
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(bodyBuffer));
        controller.close();
      },
    });

    return {
      value: stream,
      tags,
      stale: staleSec,
      timestamp: row.createdAt,
      expire: expireSec,
      revalidate: revalidateSec,
    };
  }

  async set(
    cacheKey: string,
    pendingEntry: Promise<CacheEntry>
  ): Promise<void> {
    let resolvePending: () => void = () => {};
    const pendingPromise = new Promise<void>((resolve) => {
      resolvePending = resolve;
    });
    pendingSets.set(cacheKey, pendingPromise);

    try {
      const entry = await pendingEntry;

      // Collect all chunks from the ReadableStream
      const reader = entry.value.getReader();
      const chunks: Uint8Array[] = [];
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value) chunks.push(value);
        }
      } catch {
        // Partial data — discard
        return;
      }

      const totalLength = chunks.reduce((sum, c) => sum + c.byteLength, 0);
      const combined = new Uint8Array(totalLength);
      let offset = 0;
      for (const chunk of chunks) {
        combined.set(chunk, offset);
        offset += chunk.byteLength;
      }

      const body = Buffer.from(combined).toString('base64');
      const now = Date.now();
      const store = getStore();

      const createdAt = entry.timestamp ?? now;

      store.set(cacheKey, {
        cacheKey,
        pathname: cacheKey,
        groupId: 0,
        status: 200,
        headers: {
          ...(entry.tags.length > 0 ? { [CACHE_TAGS_HEADER]: entry.tags.join(',') } : {}),
          [CACHE_STALE_HEADER]: String(entry.stale),
        },
        body,
        bodyEncoding: 'base64',
        createdAt,
        revalidateAt:
          entry.revalidate > 0 ? createdAt + entry.revalidate * 1000 : null,
        expiresAt:
          entry.expire > 0 ? createdAt + entry.expire * 1000 : null,
      });
    } finally {
      resolvePending();
      pendingSets.delete(cacheKey);
    }
  }

  async refreshTags(): Promise<void> {
    // No-op: SQLite store is always up-to-date (single process)
  }

  async getExpiration(tags: string[]): Promise<Timestamp> {
    if (tags.length === 0) return 0;

    const store = getStore();
    const entries = store.getTagManifestEntries?.(tags);
    if (!entries) return 0;

    let maxTimestamp = 0;
    for (const tag of tags) {
      const entry = entries[tag];
      if (!entry) continue;
      if (entry.expiredAt !== undefined && entry.expiredAt > maxTimestamp) {
        maxTimestamp = entry.expiredAt;
      }
    }

    return maxTimestamp;
  }

  async updateTags(
    tags: string[],
    durations?: { expire?: number }
  ): Promise<void> {
    if (tags.length === 0) return;

    const store = getStore();
    const now = Date.now();
    if (durations?.expire !== undefined) {
      store.updateTagManifest?.(tags, {
        mode: 'stale',
        now,
        expireSeconds: durations.expire,
      });
    } else {
      store.updateTagManifest?.(tags, {
        mode: 'expire',
        now,
      });
    }
  }
}

const cacheHandler: NextUseCacheHandler = new CacheHandler();
export default cacheHandler;
