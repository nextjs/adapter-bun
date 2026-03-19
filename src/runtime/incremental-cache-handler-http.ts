import { createFetchPrerenderCacheStore } from './cache-http-client.js';
import cacheHandler from './cache-handler-http.js';
import { registerGlobalCacheHandlers } from './cache-handler-registration.js';
import type { PrerenderTagManifestUpdate } from './isr.js';
import {
  decodeCacheValue,
  decodeStoredBodyBuffer,
  decodeStoredBodyText,
  encodeCacheValue,
  isCacheValue,
  isNullCacheValue,
  NULL_CACHE_ENTRY_MARKER,
} from './incremental-cache-codec.js';
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

const SEGMENT_RSC_SUFFIX = '.segment.rsc';
const store = createFetchPrerenderCacheStore();

registerGlobalCacheHandlers(cacheHandler);

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

function addHeaderTags(target: Set<string>, headersInput: unknown): void {
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

async function decodeSeededPrerenderValue(
  cacheKey: string,
  row: {
    body: Uint8Array | string;
    bodyEncoding: 'binary' | 'base64';
    headers: Record<string, string>;
    status: number;
  },
  ctx: GetIncrementalFetchCacheContext | GetIncrementalResponseCacheContext
): Promise<IncrementalCacheValue | null> {
  if (ctx.kind === 'APP_ROUTE') {
    return {
      kind: 'APP_ROUTE',
      body: decodeStoredBodyBuffer(row),
      headers: row.headers,
      status: row.status,
    } as IncrementalCacheValue;
  }

  if (ctx.kind === 'APP_PAGE') {
    const html = decodeStoredBodyText(row);
    const rscRow = await store.get(`${cacheKey}.rsc`);
    const rscData = rscRow ? decodeStoredBodyBuffer(rscRow) : undefined;
    const segmentRows =
      (await store.findByPrefix?.(`${cacheKey}.segments/`)) ?? [];
    const segmentData = new Map<string, Buffer>();

    for (const segmentRow of segmentRows) {
      if (!segmentRow.cacheKey.endsWith(SEGMENT_RSC_SUFFIX)) {
        continue;
      }
      const segmentPath = segmentRow.cacheKey.slice(
        `${cacheKey}.segments`.length,
        -SEGMENT_RSC_SUFFIX.length
      );
      if (segmentPath.length === 0) {
        continue;
      }
      segmentData.set(segmentPath, decodeStoredBodyBuffer(segmentRow));
    }

    return {
      kind: 'APP_PAGE',
      html,
      rscData,
      headers: row.headers,
      postponed: undefined,
      status: row.status,
      segmentData: segmentData.size > 0 ? segmentData : undefined,
    } as IncrementalCacheValue;
  }

  if (ctx.kind === 'PAGES') {
    return {
      kind: 'PAGES',
      html: decodeStoredBodyText(row),
      pageData: {},
      headers: row.headers,
      status: row.status,
    } as IncrementalCacheValue;
  }

  return null;
}

async function updateTagManifests(
  tags: string[],
  update: PrerenderTagManifestUpdate & { now: number }
): Promise<void> {
  if (tags.length === 0) return;
  await store.updateTagManifest?.(tags, update);
}

export default class FetchIncrementalCacheHandler
  implements NextIncrementalCacheHandler
{
  constructor(_ctx: CacheHandlerContext) {}

  resetRequestCache(): void {}

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
    const row = await store.get(cacheKey);
    if (!row) {
      return null;
    }

    const queryTags = getFetchContextTags(ctx);
    const storedTags = readStoredHeaderTags(row.headers);
    const tagsToCheck = normalizeTags([...queryTags, ...storedTags]);

    if (tagsToCheck.length > 0) {
      const tagEntries = await store.getTagManifestEntries?.(tagsToCheck);
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

    const payload = decodeStoredBodyText(row);
    let value: IncrementalCacheValue | null = null;
    let decoded = false;
    try {
      const decodedValue = decodeCacheValue(payload);
      if (isNullCacheValue(decodedValue)) {
        value = null;
        decoded = true;
      } else if (isCacheValue(decodedValue)) {
        value = decodedValue;
        decoded = true;
      }
    } catch {}

    if (!decoded) {
      const seeded = await decodeSeededPrerenderValue(cacheKey, row, ctx);
      if (!seeded) {
        return null;
      }
      value = seeded;
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
    if (data === null || data === undefined) {
      const now = Date.now();
      const markerPayload = JSON.stringify({
        [NULL_CACHE_ENTRY_MARKER]: true,
      });
      await store.set(cacheKey, {
        cacheKey,
        pathname: cacheKey,
        groupId: 0,
        status: 200,
        headers: {},
        body: new TextEncoder().encode(markerPayload),
        bodyEncoding: 'binary',
        createdAt: now,
        revalidateAt: null,
        expiresAt: null,
      });
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

    await store.set(cacheKey, {
      cacheKey,
      pathname: cacheKey,
      groupId: 0,
      status: 200,
      headers,
      body: new TextEncoder().encode(encodeCacheValue(data)),
      bodyEncoding: 'binary',
      createdAt: now,
      revalidateAt: toAbsoluteTimestamp(revalidateSeconds, now),
      expiresAt: toAbsoluteTimestamp(expireSeconds, now),
    });
  }
}
