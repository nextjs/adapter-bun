export const NEXT_CACHE_TAGS_HEADER = 'x-next-cache-tags';

export interface PrerenderCacheEntry {
  cacheKey: string;
  pathname: string;
  groupId: number;
  status: number;
  headers: Record<string, string>;
  body: string;
  bodyEncoding: 'base64';
  createdAt: number;
  revalidateAt: number | null;
  expiresAt: number | null;
  cacheQuery?: Record<string, string[]>;
  cacheHeaders?: Record<string, string>;
}

export interface PrerenderTagManifestEntry {
  staleAt?: number;
  expiredAt?: number;
}

export interface PrerenderTagManifestUpdate {
  mode: 'stale' | 'expire';
  now?: number;
  expireSeconds?: number;
}

export interface PrerenderRevalidateTarget {
  cacheKey: string;
  pathname: string;
  groupId: number;
}

export interface PrerenderCacheStore {
  get(cacheKey: string): Promise<PrerenderCacheEntry | null> | PrerenderCacheEntry | null;
  set(cacheKey: string, entry: PrerenderCacheEntry): Promise<void> | void;
  delete?(cacheKey: string): Promise<void> | void;
  acquireRevalidateLock?(
    cacheKey: string,
    ttlSeconds: number
  ): Promise<boolean> | boolean;
  getTagManifestEntries?(
    tags: string[]
  ):
    | Promise<Record<string, PrerenderTagManifestEntry>>
    | Record<string, PrerenderTagManifestEntry>;
  updateTagManifest?(
    tags: string[],
    update: PrerenderTagManifestUpdate
  ): Promise<void> | void;
  findRevalidateTargets?(query: {
    tags?: string[];
    pathnames?: string[];
  }): Promise<PrerenderRevalidateTarget[]> | PrerenderRevalidateTarget[];
}

export interface ImageCacheEntry {
  cacheKey: string;
  pathname: string;
  status: number;
  headers: Record<string, string>;
  body: string;
  bodyEncoding: 'base64';
  createdAt: number;
  revalidateAt: number | null;
  expiresAt: number | null;
}

export interface ImageCacheStore {
  get(cacheKey: string): Promise<ImageCacheEntry | null> | ImageCacheEntry | null;
  set(cacheKey: string, entry: ImageCacheEntry): Promise<void> | void;
  delete?(cacheKey: string): Promise<void> | void;
}

function parseCacheTagsHeader(value: string | undefined): string[] {
  if (typeof value !== 'string' || value.length === 0) {
    return [];
  }
  return value
    .split(',')
    .map((tag) => tag.trim())
    .filter((tag) => tag.length > 0);
}

export function readCacheTagsFromHeaders(headers: Record<string, string>): string[] {
  return parseCacheTagsHeader(headers[NEXT_CACHE_TAGS_HEADER]);
}
