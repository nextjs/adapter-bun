import type { CacheHandler as NextUseCacheHandler } from 'next/dist/server/lib/cache-handlers/types';

const handlersSymbol = Symbol.for('@next/cache-handlers');

type GlobalCacheHandlersReference = typeof globalThis & {
  [handlersSymbol]?: {
    DefaultCache?: NextUseCacheHandler;
    RemoteCache?: NextUseCacheHandler;
  };
};

export function registerGlobalCacheHandlers(
  cacheHandler: NextUseCacheHandler
): void {
  const reference = globalThis as GlobalCacheHandlersReference;
  const existing = reference[handlersSymbol] ?? {};

  reference[handlersSymbol] = {
    ...existing,
    DefaultCache: cacheHandler,
    RemoteCache: cacheHandler,
  };
}
