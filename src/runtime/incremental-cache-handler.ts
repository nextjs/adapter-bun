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

const MAP_MARKER = '__adapter_bun_type';
const SEGMENT_RSC_SUFFIX = '.segment.rsc';
const NULL_CACHE_ENTRY_MARKER = '__adapter_bun_null_cache_entry';
const KNOWN_CACHE_KINDS = new Set([
  'APP_PAGE',
  'APP_ROUTE',
  'PAGES',
  'FETCH',
  'REDIRECT',
  'IMAGE',
]);

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

function decodeCacheValue(payload: string): unknown {
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
  });
}

function decodeStoredBodyBytes(row: {
  body: Uint8Array | string;
  bodyEncoding: 'binary' | 'base64';
}): Uint8Array {
  if (row.bodyEncoding === 'binary') {
    return row.body instanceof Uint8Array
      ? row.body
      : new TextEncoder().encode(row.body);
  }

  const encodedBody =
    typeof row.body === 'string' ? row.body : Buffer.from(row.body).toString('utf8');
  return Buffer.from(encodedBody, 'base64');
}

function decodeStoredBodyBuffer(row: {
  body: Uint8Array | string;
  bodyEncoding: 'binary' | 'base64';
}): Buffer {
  return Buffer.from(decodeStoredBodyBytes(row));
}

function decodeStoredBodyText(row: {
  body: Uint8Array | string;
  bodyEncoding: 'binary' | 'base64';
}): string {
  return Buffer.from(decodeStoredBodyBytes(row)).toString('utf8');
}

function isCacheValue(value: unknown): value is IncrementalCacheValue {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return typeof record.kind === 'string' && KNOWN_CACHE_KINDS.has(record.kind);
}

function isNullCacheValue(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return record[NULL_CACHE_ENTRY_MARKER] === true;
}

function decodeSeededPrerenderValue(
  cacheKey: string,
  row: {
    body: Uint8Array | string;
    bodyEncoding: 'binary' | 'base64';
    headers: Record<string, string>;
    status: number;
  },
  ctx: GetIncrementalFetchCacheContext | GetIncrementalResponseCacheContext,
  store: ReturnType<typeof getSharedPrerenderCacheStore>
): IncrementalCacheValue | null {
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
    const rscRow = store.get(`${cacheKey}.rsc`);
    const rscData = rscRow ? decodeStoredBodyBuffer(rscRow) : undefined;
    const segmentRows = store.findByPrefix(`${cacheKey}.segments/`);
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
    const html = decodeStoredBodyText(row);
    return {
      kind: 'PAGES',
      html,
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
    const row = store.get(cacheKey);
    if (!row) {
      return null;
    }

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
      const seeded = decodeSeededPrerenderValue(cacheKey, row, ctx, store);
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
    const store = getSharedPrerenderCacheStore();

    if (data === null || data === undefined) {
      const now = Date.now();
      const markerPayload = JSON.stringify({
        [NULL_CACHE_ENTRY_MARKER]: true,
      });
      store.set(cacheKey, {
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

    store.set(cacheKey, {
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
