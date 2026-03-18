import type {
  PrerenderCacheEntry,
  PrerenderCacheStore,
  PrerenderTagManifestEntry,
  PrerenderTagManifestUpdate,
} from './isr.js';
import {
  CACHE_HTTP_AUTH_HEADER,
  DEFAULT_CACHE_HTTP_ENDPOINT_PATH,
  deserializePrerenderCacheEntry,
  serializePrerenderCacheEntry,
  type CacheHttpRequest,
  type CacheHttpResponse,
} from './cache-http-protocol.js';

export interface FetchPrerenderCacheStoreOptions {
  url?: string;
  authToken?: string;
}

function readRuntimeEnv(name: string): string | undefined {
  if (typeof process === 'undefined' || !process.env) {
    return undefined;
  }

  const value = process.env[name];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function resolveEndpointUrl(explicitUrl?: string): string {
  if (explicitUrl && explicitUrl.length > 0) {
    return explicitUrl;
  }

  const configuredUrl = readRuntimeEnv('BUN_ADAPTER_CACHE_HTTP_URL');
  if (configuredUrl) {
    return configuredUrl;
  }

  const privateOrigin = readRuntimeEnv('__NEXT_PRIVATE_ORIGIN');
  if (privateOrigin) {
    return new URL(DEFAULT_CACHE_HTTP_ENDPOINT_PATH, privateOrigin).toString();
  }

  throw new Error(
    '[adapter-bun] missing cache HTTP endpoint; set BUN_ADAPTER_CACHE_HTTP_URL'
  );
}

function tryResolveEndpointUrl(explicitUrl?: string): string | null {
  try {
    return resolveEndpointUrl(explicitUrl);
  } catch {
    return null;
  }
}

let fallbackStorePromise: Promise<PrerenderCacheStore> | null = null;

async function loadFallbackStore(): Promise<PrerenderCacheStore> {
  if (!fallbackStorePromise) {
    const dynamicImport = new Function(
      'specifier',
      'return import(specifier)'
    ) as (specifier: string) => Promise<{
      getSharedPrerenderCacheStore: () => PrerenderCacheStore;
    }>;

    fallbackStorePromise = dynamicImport(
      new URL('./cache-store.js', import.meta.url).href
    ).then((mod) => mod.getSharedPrerenderCacheStore());
  }

  return fallbackStorePromise;
}

function getTransportFetch(): typeof fetch {
  const candidate = globalThis.fetch as
    | (typeof fetch & { _nextOriginalFetch?: typeof fetch })
    | undefined;
  if (!candidate) {
    throw new Error('[adapter-bun] global fetch is not available');
  }

  return candidate._nextOriginalFetch ?? candidate;
}

async function parseJsonResponse(response: Response): Promise<CacheHttpResponse> {
  try {
    return (await response.json()) as CacheHttpResponse;
  } catch {
    return {
      ok: false,
      error: `invalid cache endpoint response (${response.status})`,
    };
  }
}

export class FetchPrerenderCacheStore implements PrerenderCacheStore {
  readonly #configuredUrl: string | undefined;
  readonly #authToken: string | undefined;

  constructor(options: FetchPrerenderCacheStoreOptions = {}) {
    this.#configuredUrl = options.url;
    this.#authToken =
      options.authToken ?? readRuntimeEnv('BUN_ADAPTER_CACHE_HTTP_TOKEN');
  }

  async #request(payload: CacheHttpRequest): Promise<CacheHttpResponse> {
    const endpointUrl = resolveEndpointUrl(this.#configuredUrl);
    const response = await getTransportFetch()(endpointUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(this.#authToken
          ? { [CACHE_HTTP_AUTH_HEADER]: this.#authToken }
          : {}),
      },
      body: JSON.stringify(payload),
      cache: 'no-store',
    });

    const parsed = await parseJsonResponse(response);
    if (!response.ok) {
      const error =
        parsed.ok === false ? parsed.error : `cache endpoint error (${response.status})`;
      throw new Error(`[adapter-bun] ${error}`);
    }

    if (parsed.ok === false) {
      throw new Error(`[adapter-bun] ${parsed.error}`);
    }

    return parsed;
  }

  async get(cacheKey: string): Promise<PrerenderCacheEntry | null> {
    const endpointUrl = tryResolveEndpointUrl(this.#configuredUrl);
    if (!endpointUrl) {
      const fallbackStore = await loadFallbackStore();
      return (await fallbackStore.get(cacheKey)) ?? null;
    }

    const response = await this.#request({
      op: 'getEntry',
      cacheKey,
    });

    return 'entry' in response && response.entry
      ? deserializePrerenderCacheEntry(response.entry)
      : null;
  }

  async set(cacheKey: string, entry: PrerenderCacheEntry): Promise<void> {
    const endpointUrl = tryResolveEndpointUrl(this.#configuredUrl);
    if (!endpointUrl) {
      const fallbackStore = await loadFallbackStore();
      await fallbackStore.set(cacheKey, entry);
      return;
    }

    await this.#request({
      op: 'setEntry',
      cacheKey,
      entry: serializePrerenderCacheEntry(entry),
    });
  }

  async findByPrefix(cacheKeyPrefix: string): Promise<PrerenderCacheEntry[]> {
    const endpointUrl = tryResolveEndpointUrl(this.#configuredUrl);
    if (!endpointUrl) {
      const fallbackStore = await loadFallbackStore();
      return fallbackStore.findByPrefix
        ? await fallbackStore.findByPrefix(cacheKeyPrefix)
        : [];
    }

    const response = await this.#request({
      op: 'findByPrefix',
      cacheKeyPrefix,
    });

    return 'entries' in response
      ? response.entries.map((entry) => deserializePrerenderCacheEntry(entry))
      : [];
  }

  async getTagManifestEntries(
    tags: string[]
  ): Promise<Record<string, PrerenderTagManifestEntry>> {
    if (tags.length === 0) {
      return {};
    }

    const endpointUrl = tryResolveEndpointUrl(this.#configuredUrl);
    if (!endpointUrl) {
      const fallbackStore = await loadFallbackStore();
      return fallbackStore.getTagManifestEntries
        ? await fallbackStore.getTagManifestEntries(tags)
        : {};
    }

    const response = await this.#request({
      op: 'getTagManifestEntries',
      tags,
    });

    return 'manifest' in response ? response.manifest : {};
  }

  async updateTagManifest(
    tags: string[],
    update: PrerenderTagManifestUpdate
  ): Promise<void> {
    if (tags.length === 0) {
      return;
    }

    const endpointUrl = tryResolveEndpointUrl(this.#configuredUrl);
    if (!endpointUrl) {
      const fallbackStore = await loadFallbackStore();
      if (fallbackStore.updateTagManifest) {
        await fallbackStore.updateTagManifest(tags, update);
      }
      return;
    }

    await this.#request({
      op: 'updateTagManifest',
      tags,
      update,
    });
  }
}

export function createFetchPrerenderCacheStore(
  options: FetchPrerenderCacheStoreOptions = {}
): FetchPrerenderCacheStore {
  return new FetchPrerenderCacheStore(options);
}
