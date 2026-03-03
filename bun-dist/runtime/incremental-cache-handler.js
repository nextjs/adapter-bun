import { deserialize, serialize } from 'node:v8';
import { getSharedPrerenderCacheStore } from './cache-store.js';
import { syncNextTagManifest } from './next-tags-manifest.js';
const STORE_KEY_PREFIX = 'incremental:';
const KNOWN_INCREMENTAL_KINDS = [
    'FETCH',
    'APP_PAGE',
    'APP_ROUTE',
    'PAGES',
    'IMAGE',
    'REDIRECT',
    'UNKNOWN',
];
function normalizeKind(kind) {
    return typeof kind === 'string' && kind.length > 0 ? kind : 'UNKNOWN';
}
function toStoreKey(cacheKey, kind) {
    return `${STORE_KEY_PREFIX}${normalizeKind(kind)}:${cacheKey}`;
}
function normalizeTags(tags) {
    const unique = new Set();
    for (const tag of tags) {
        if (typeof tag !== 'string')
            continue;
        const trimmed = tag.trim();
        if (trimmed.length > 0)
            unique.add(trimmed);
    }
    return [...unique];
}
function addHeaderTags(target, headers) {
    if (!headers || typeof headers !== 'object')
        return;
    const value = headers['x-next-cache-tags'];
    const raw = Array.isArray(value) ? value.join(',') : typeof value === 'string' ? value : null;
    if (!raw)
        return;
    for (const tag of raw.split(',')) {
        const trimmed = tag.trim();
        if (trimmed.length > 0)
            target.add(trimmed);
    }
}
function collectTags(data, ctx) {
    const tags = new Set();
    if (Array.isArray(ctx?.tags)) {
        for (const tag of ctx.tags) {
            if (typeof tag === 'string' && tag.trim().length > 0) {
                tags.add(tag.trim());
            }
        }
    }
    if (Array.isArray(data.tags)) {
        for (const tag of data.tags) {
            if (typeof tag === 'string' && tag.trim().length > 0) {
                tags.add(tag.trim());
            }
        }
    }
    addHeaderTags(tags, data.headers);
    return [...tags];
}
function toAbsoluteTimestamp(seconds, now) {
    if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0) {
        return null;
    }
    return now + seconds * 1000;
}
function resolveRevalidateSeconds(data, ctx) {
    if (ctx?.fetchCache &&
        data.kind === 'FETCH' &&
        typeof data.revalidate === 'number' &&
        Number.isFinite(data.revalidate)) {
        return data.revalidate;
    }
    const revalidate = ctx?.cacheControl?.revalidate;
    if (typeof revalidate === 'number' && Number.isFinite(revalidate)) {
        return revalidate;
    }
    return null;
}
async function updateTagManifests(tags, update) {
    if (tags.length === 0)
        return;
    await syncNextTagManifest(tags, update);
    const store = getSharedPrerenderCacheStore();
    store.updateTagManifest?.(tags, update);
}
export default class BunSqliteIncrementalCacheHandler {
    constructor(_ctx) { }
    resetRequestCache() {
        // Request-local behavior is already managed by Next.js.
    }
    async revalidateTag(tagsInput, durations) {
        const tags = normalizeTags(Array.isArray(tagsInput) ? tagsInput : [tagsInput]);
        if (tags.length === 0)
            return;
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
    async get(cacheKey, ctx) {
        const store = getSharedPrerenderCacheStore();
        const row = store.get(toStoreKey(cacheKey, ctx.kind));
        if (!row)
            return null;
        let value;
        try {
            value = deserialize(Buffer.from(row.body, 'base64'));
        }
        catch {
            return null;
        }
        return {
            lastModified: row.createdAt,
            value,
        };
    }
    async set(cacheKey, data, ctx) {
        const store = getSharedPrerenderCacheStore();
        const storeKey = toStoreKey(cacheKey, data?.kind);
        if (data === null || data === undefined) {
            if (ctx?.fetchCache) {
                store.delete?.(toStoreKey(cacheKey, 'FETCH'));
            }
            else {
                for (const kind of KNOWN_INCREMENTAL_KINDS) {
                    store.delete?.(toStoreKey(cacheKey, kind));
                }
            }
            return;
        }
        const now = Date.now();
        const tags = collectTags(data, ctx);
        const headers = {};
        if (tags.length > 0) {
            headers['x-next-cache-tags'] = tags.join(',');
        }
        const revalidateSeconds = resolveRevalidateSeconds(data, ctx);
        const expireSeconds = typeof ctx?.cacheControl?.expire === 'number' && Number.isFinite(ctx.cacheControl.expire)
            ? ctx.cacheControl.expire
            : null;
        store.set(storeKey, {
            cacheKey: storeKey,
            pathname: cacheKey,
            groupId: 0,
            status: 200,
            headers,
            body: serialize(data).toString('base64'),
            bodyEncoding: 'base64',
            createdAt: now,
            revalidateAt: toAbsoluteTimestamp(revalidateSeconds, now),
            expiresAt: toAbsoluteTimestamp(expireSeconds, now),
        });
    }
}
