import type { IncomingMessage, ServerResponse } from 'node:http';
import type { PrerenderCacheStore } from './isr.js';
import {
  CACHE_HTTP_AUTH_HEADER,
  deserializePrerenderCacheEntry,
  serializePrerenderCacheEntry,
  type CacheHttpRequest,
  type CacheHttpResponse,
} from './cache-http-protocol.js';

export interface CacheHttpServerOptions {
  authToken?: string;
}

function setJsonResponse(
  res: ServerResponse,
  statusCode: number,
  body: CacheHttpResponse
): void {
  const payload = JSON.stringify(body);
  res.statusCode = statusCode;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(payload);
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of req) {
    if (typeof chunk === 'string') {
      chunks.push(new TextEncoder().encode(chunk));
      continue;
    }
    if (chunk instanceof Uint8Array) {
      chunks.push(chunk);
    }
  }

  const totalLength = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const combined = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }

  if (combined.byteLength === 0) {
    return null;
  }

  return JSON.parse(new TextDecoder().decode(combined));
}

export async function handleCacheHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  store: PrerenderCacheStore,
  options: CacheHttpServerOptions = {}
): Promise<void> {
  if (req.method !== 'POST') {
    res.setHeader('allow', 'POST');
    setJsonResponse(res, 405, {
      ok: false,
      error: 'method not allowed',
    });
    return;
  }

  if (options.authToken) {
    const headerValue = req.headers[CACHE_HTTP_AUTH_HEADER];
    const providedToken = Array.isArray(headerValue) ? headerValue[0] : headerValue;
    if (providedToken !== options.authToken) {
      setJsonResponse(res, 401, {
        ok: false,
        error: 'unauthorized cache request',
      });
      return;
    }
  }

  let payload: unknown;
  try {
    payload = await readJsonBody(req);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'invalid cache request payload';
    setJsonResponse(res, 400, {
      ok: false,
      error: message,
    });
    return;
  }

  const request = payload as CacheHttpRequest | null;
  if (!request || typeof request !== 'object' || typeof request.op !== 'string') {
    setJsonResponse(res, 400, {
      ok: false,
      error: 'invalid cache request',
    });
    return;
  }

  try {
    switch (request.op) {
      case 'getEntry': {
        const entry = await store.get(request.cacheKey);
        setJsonResponse(res, 200, {
          ok: true,
          entry: entry ? serializePrerenderCacheEntry(entry) : null,
        });
        return;
      }

      case 'setEntry': {
        await store.set(request.cacheKey, deserializePrerenderCacheEntry(request.entry));
        setJsonResponse(res, 200, {
          ok: true,
        });
        return;
      }

      case 'findByPrefix': {
        const entries = store.findByPrefix
          ? await store.findByPrefix(request.cacheKeyPrefix)
          : [];
        setJsonResponse(res, 200, {
          ok: true,
          entries: entries.map((entry) => serializePrerenderCacheEntry(entry)),
        });
        return;
      }

      case 'getTagManifestEntries': {
        const manifest = store.getTagManifestEntries
          ? await store.getTagManifestEntries(request.tags)
          : {};
        setJsonResponse(res, 200, {
          ok: true,
          manifest,
        });
        return;
      }

      case 'updateTagManifest': {
        if (store.updateTagManifest) {
          await store.updateTagManifest(request.tags, request.update);
        }
        setJsonResponse(res, 200, {
          ok: true,
        });
        return;
      }

      default: {
        setJsonResponse(res, 400, {
          ok: false,
          error: 'unknown cache operation',
        });
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'cache operation failed';
    setJsonResponse(res, 500, {
      ok: false,
      error: message,
    });
  }
}
