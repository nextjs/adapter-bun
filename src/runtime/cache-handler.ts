import { getSharedPrerenderCacheStore } from './cache-store.js';
import type {
  CacheEntry,
  CacheHandler as NextUseCacheHandler,
  Timestamp,
} from 'next/dist/server/lib/cache-handlers/types';

function getStore() {
  return getSharedPrerenderCacheStore();
}

class CacheHandler implements NextUseCacheHandler {
  async get(
    cacheKey: string,
    softTags: string[]
  ): Promise<undefined | CacheEntry> {
    const store = getStore();
    const row = store.get(cacheKey);
    if (!row) return undefined;

    // Check soft tags for expiration
    if (softTags.length > 0) {
      const tagEntries = store.getTagManifestEntries?.(softTags);
      if (tagEntries) {
        for (const tag of softTags) {
          const tagEntry = tagEntries[tag];
          if (!tagEntry) continue;
          // If tag was expired/staled after entry creation, entry is stale
          if (
            tagEntry.expiredAt !== undefined &&
            tagEntry.expiredAt > row.createdAt
          ) {
            return undefined;
          }
          if (
            tagEntry.staleAt !== undefined &&
            tagEntry.staleAt > row.createdAt
          ) {
            return undefined;
          }
        }
      }
    }

    // Convert stored base64 body to ReadableStream
    const bodyBuffer = Buffer.from(row.body, 'base64');
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(bodyBuffer));
        controller.close();
      },
    });

    // Extract tags from headers
    const cacheTags = row.headers['x-next-cache-tags'];
    const tags = cacheTags
      ? cacheTags.split(',').map((t) => t.trim()).filter(Boolean)
      : [];

    // Compute durations from absolute timestamps
    const revalidateSec =
      row.revalidateAt !== null
        ? Math.max(0, Math.floor((row.revalidateAt - row.createdAt) / 1000))
        : 31536000; // 1 year default
    const expireSec =
      row.expiresAt !== null
        ? Math.max(0, Math.floor((row.expiresAt - row.createdAt) / 1000))
        : revalidateSec * 2;
    const staleSec = revalidateSec;

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

    store.set(cacheKey, {
      cacheKey,
      pathname: cacheKey,
      groupId: 0,
      status: 200,
      headers: {
        'x-next-cache-tags': entry.tags.join(','),
      },
      body,
      bodyEncoding: 'base64',
      createdAt: entry.timestamp || now,
      revalidateAt:
        entry.revalidate > 0 ? (entry.timestamp || now) + entry.revalidate * 1000 : null,
      expiresAt:
        entry.expire > 0 ? (entry.timestamp || now) + entry.expire * 1000 : null,
    });
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
      if (entry.staleAt !== undefined && entry.staleAt > maxTimestamp) {
        maxTimestamp = entry.staleAt;
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
