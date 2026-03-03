export const NEXT_CACHE_TAGS_HEADER = 'x-next-cache-tags';
function parseCacheTagsHeader(value) {
    if (typeof value !== 'string' || value.length === 0) {
        return [];
    }
    return value
        .split(',')
        .map((tag) => tag.trim())
        .filter((tag) => tag.length > 0);
}
export function readCacheTagsFromHeaders(headers) {
    return parseCacheTagsHeader(headers[NEXT_CACHE_TAGS_HEADER]);
}
