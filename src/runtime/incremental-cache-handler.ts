import type { PrerenderTagManifestUpdate } from './isr.js';
import { getSharedPrerenderCacheStore } from './cache-store.js';
import type {
  CacheHandler as NextIncrementalCacheHandler,
  CacheHandlerContext,
  CacheHandlerValue,
} from 'next/dist/server/lib/incremental-cache';
import type {
  GetIncrementalFetchCacheContext,
  GetIncrementalResponseCacheContext,
  IncrementalCacheValue,
  SetIncrementalFetchCacheContext,
  SetIncrementalResponseCacheContext,
} from 'next/dist/server/response-cache';

const STORE_KEY_PREFIX = 'incremental:';
const MAP_MARKER = '__adapter_bun_type';
const KNOWN_INCREMENTAL_KINDS = [
  'FETCH',
  'APP_PAGE',
  'APP_ROUTE',
  'PAGES',
  'IMAGE',
  'REDIRECT',
  'UNKNOWN',
] as const;

function normalizeKind(kind: unknown): string {
  return typeof kind === 'string' && kind.length > 0 ? kind : 'UNKNOWN';
}

function toStoreKey(cacheKey: string, kind: unknown): string {
  return `${STORE_KEY_PREFIX}${normalizeKind(kind)}:${cacheKey}`;
}

function normalizeTags(tags: string[]): string[] {
  const unique = new Set<string>();
  for (const tag of tags) {
    if (typeof tag !== 'string') continue;
    const trimmed = tag.trim();
    if (trimmed.length > 0) unique.add(trimmed);
  }
  return [...unique];
}

function isResponseSetContext(
  ctx: SetIncrementalFetchCacheContext | SetIncrementalResponseCacheContext
): ctx is SetIncrementalResponseCacheContext {
  return ctx.fetchCache !== true;
}

function getFetchContextTags(
  ctx: GetIncrementalFetchCacheContext | GetIncrementalResponseCacheContext
): string[] {
  if (ctx.kind !== 'FETCH') return [];
  return normalizeTags([...(ctx.tags ?? []), ...(ctx.softTags ?? [])]);
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const tags: string[] = [];
  for (const entry of value) {
    if (typeof entry === 'string' && entry.trim().length > 0) {
      tags.push(entry.trim());
    }
  }
  return tags;
}

function addHeaderTags(
  target: Set<string>,
  headersInput: unknown
): void {
  if (!headersInput || typeof headersInput !== 'object') return;
  const headers = headersInput as Record<string, unknown>;

  const value = headers['x-next-cache-tags'];
  const raw =
    Array.isArray(value)
      ? value.filter((item): item is string => typeof item === 'string').join(',')
      : typeof value === 'string'
        ? value
        : null;
  if (!raw) return;

  for (const tag of raw.split(',')) {
    const trimmed = tag.trim();
    if (trimmed.length > 0) target.add(trimmed);
  }
}

function collectTags(
  data: IncrementalCacheValue,
  ctx: SetIncrementalFetchCacheContext | SetIncrementalResponseCacheContext
): string[] {
  const tags = new Set<string>();

  for (const tag of readStringArray((ctx as { tags?: unknown }).tags)) {
    tags.add(tag);
  }

  const dataRecord = data as unknown as Record<string, unknown>;
  for (const tag of readStringArray(dataRecord.tags)) {
    tags.add(tag);
  }

  addHeaderTags(tags, dataRecord.headers);
  return [...tags];
}

function readStoredHeaderTags(headers: Record<string, string>): string[] {
  const raw = headers['x-next-cache-tags'];
  if (typeof raw !== 'string' || raw.length === 0) return [];
  return raw
    .split(',')
    .map((tag) => tag.trim())
    .filter((tag) => tag.length > 0);
}

function toAbsoluteTimestamp(seconds: number | null, now: number): number | null {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0) {
    return null;
  }
  return now + seconds * 1000;
}

function resolveRevalidateSeconds(
  data: IncrementalCacheValue,
  ctx: SetIncrementalFetchCacheContext | SetIncrementalResponseCacheContext
): number | null {
  const dataRecord = data as unknown as Record<string, unknown>;
  const kind = dataRecord.kind;
  const dataRevalidate = dataRecord.revalidate;

  if (
    ctx.fetchCache &&
    kind === 'FETCH' &&
    typeof dataRevalidate === 'number' &&
    Number.isFinite(dataRevalidate)
  ) {
    return dataRevalidate;
  }

  const revalidate = isResponseSetContext(ctx) ? ctx.cacheControl?.revalidate : undefined;
  if (typeof revalidate === 'number' && Number.isFinite(revalidate)) {
    return revalidate;
  }

  return null;
}

function encodeCacheValue(value: IncrementalCacheValue): string {
  return JSON.stringify(value, (_key, input) => {
    if (input instanceof Map) {
      return {
        [MAP_MARKER]: 'Map',
        entries: [...input.entries()],
      };
    }
    return input;
  });
}

function decodeCacheValue(payload: string): IncrementalCacheValue {
  return JSON.parse(payload, (_key, input) => {
    if (
      input &&
      typeof input === 'object' &&
      'type' in input &&
      input.type === 'Buffer' &&
      'data' in input &&
      Array.isArray(input.data)
    ) {
      return Buffer.from(input.data);
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
  }) as IncrementalCacheValue;
}

async function updateTagManifests(
  tags: string[],
  update: PrerenderTagManifestUpdate & { now: number }
): Promise<void> {
  if (tags.length === 0) return;
  const store = getSharedPrerenderCacheStore();
  store.updateTagManifest?.(tags, update);
}

export default class BunSqliteIncrementalCacheHandler
  implements NextIncrementalCacheHandler
{
  constructor(_ctx: CacheHandlerContext) {}

  resetRequestCache(): void {
    // Request-local behavior is already managed by Next.js.
  }

  async revalidateTag(
    tagsInput: string | string[],
    durations?: { expire?: number }
  ): Promise<void> {
    const tags = normalizeTags(Array.isArray(tagsInput) ? tagsInput : [tagsInput]);
    if (tags.length === 0) return;

    const now = Date.now();
    if (durations && typeof durations === 'object') {
      await updateTagManifests(tags, {
        mode: 'stale',
        now,
        expireSeconds: durations.expire,
      });
      return;
    }

    await updateTagManifests(tags, {
      mode: 'expire',
      now,
    });
  }

  async get(
    cacheKey: string,
    ctx: GetIncrementalFetchCacheContext | GetIncrementalResponseCacheContext
  ): Promise<CacheHandlerValue | null> {
    const store = getSharedPrerenderCacheStore();
    const row = store.get(toStoreKey(cacheKey, ctx.kind));
    if (!row) return null;

    const queryTags = getFetchContextTags(ctx);
    const storedTags = readStoredHeaderTags(row.headers);
    const tagsToCheck = normalizeTags([...queryTags, ...storedTags]);

    if (tagsToCheck.length > 0) {
      const tagEntries = store.getTagManifestEntries?.(tagsToCheck);
      if (tagEntries) {
        for (const tag of tagsToCheck) {
          const tagEntry = tagEntries[tag];
          if (!tagEntry) continue;
          if (tagEntry.expiredAt !== undefined && tagEntry.expiredAt > row.createdAt) {
            return null;
          }
          if (tagEntry.staleAt !== undefined && tagEntry.staleAt > row.createdAt) {
            return null;
          }
        }
      }
    }

    let value: IncrementalCacheValue | null;
    try {
      value = decodeCacheValue(Buffer.from(row.body, 'base64').toString('utf8'));
    } catch {
      return null;
    }

    return {
      lastModified: row.createdAt,
      value,
    };
  }

  async set(
    cacheKey: string,
    data: IncrementalCacheValue | null,
    ctx: SetIncrementalFetchCacheContext | SetIncrementalResponseCacheContext
  ): Promise<void> {
    const store = getSharedPrerenderCacheStore();
    const storeKey = toStoreKey(cacheKey, data?.kind);

    if (data === null || data === undefined) {
      if (ctx?.fetchCache) {
        store.delete?.(toStoreKey(cacheKey, 'FETCH'));
      } else {
        for (const kind of KNOWN_INCREMENTAL_KINDS) {
          store.delete?.(toStoreKey(cacheKey, kind));
        }
      }
      return;
    }

    const now = Date.now();
    const tags = collectTags(data, ctx);
    const headers: Record<string, string> = {};
    if (tags.length > 0) {
      headers['x-next-cache-tags'] = tags.join(',');
    }

    const revalidateSeconds = resolveRevalidateSeconds(data, ctx);
    const expireSeconds =
      isResponseSetContext(ctx) &&
      typeof ctx.cacheControl?.expire === 'number' &&
      Number.isFinite(ctx.cacheControl.expire)
        ? ctx.cacheControl.expire
        : null;

    store.set(storeKey, {
      cacheKey: storeKey,
      pathname: cacheKey,
      groupId: 0,
      status: 200,
      headers,
      body: Buffer.from(encodeCacheValue(data), 'utf8').toString('base64'),
      bodyEncoding: 'base64',
      createdAt: now,
      revalidateAt: toAbsoluteTimestamp(revalidateSeconds, now),
      expiresAt: toAbsoluteTimestamp(expireSeconds, now),
    });
  }
}
