import http from 'node:http';
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';
import { Readable } from 'node:stream';
import { getSharedPrerenderCacheStore } from './cache-store.js';
import { handleCacheHttpRequest } from './cache-http-server.js';

const DEFAULT_CACHE_HANDLER_MODE = 'http';
const DEFAULT_CACHE_ENDPOINT_PATH = '/_adapter/cache';
const DEFAULT_DIST_DIR = '.next';
const DEFAULT_PORT = 3000;
const DEFAULT_HOSTNAME = '0.0.0.0';
const DEFAULT_KEEP_ALIVE_TIMEOUT = 75_000;
const RUNTIME_NEXT_CONFIG_FILE = 'runtime-next-config.json';

type CacheHandlerMode = 'sqlite' | 'http';
type RuntimeConfigRecord = Record<string, unknown>;

interface RuntimeCacheConfig {
  handlerMode?: CacheHandlerMode;
  endpointPath?: string;
  authToken?: string | null;
}

interface RuntimeSection {
  cache?: RuntimeCacheConfig | null;
}

interface DeploymentManifest {
  server?: {
    port?: number;
    hostname?: string;
  };
  build?: {
    nextVersion?: string;
    buildId?: string;
    distDir?: string;
  };
  runtime?: RuntimeSection | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isWildcardHostname(value: string): boolean {
  return value === '0.0.0.0' || value === '::';
}

function resolveManifestPort(manifest: DeploymentManifest): number {
  const candidate = manifest.server?.port;
  return typeof candidate === 'number' && Number.isFinite(candidate) && candidate > 0
    ? candidate
    : DEFAULT_PORT;
}

function resolveManifestHostname(manifest: DeploymentManifest): string {
  const candidate = manifest.server?.hostname;
  return typeof candidate === 'string' && candidate.length > 0
    ? candidate
    : DEFAULT_HOSTNAME;
}

function resolveCacheRuntimeConfig(manifest: DeploymentManifest): {
  handlerMode: CacheHandlerMode;
  endpointPath: string;
  authToken: string;
} {
  const cacheConfig = manifest.runtime?.cache;
  const handlerMode: CacheHandlerMode =
    cacheConfig?.handlerMode === 'sqlite' ? 'sqlite' : DEFAULT_CACHE_HANDLER_MODE;
  const endpointPath =
    typeof cacheConfig?.endpointPath === 'string' && cacheConfig.endpointPath.length > 0
      ? cacheConfig.endpointPath
      : DEFAULT_CACHE_ENDPOINT_PATH;
  const authToken =
    typeof cacheConfig?.authToken === 'string' ? cacheConfig.authToken : '';

  return {
    handlerMode,
    endpointPath,
    authToken,
  };
}

function getRuntimeHandlerModuleNames(mode: CacheHandlerMode): {
  incremental: string;
  useCache: string;
} {
  return mode === 'http'
    ? {
        incremental: 'incremental-cache-handler-http.js',
        useCache: 'cache-handler-http.js',
      }
    : {
        incremental: 'incremental-cache-handler.js',
        useCache: 'cache-handler.js',
      };
}

function getSingleHeaderValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function getHeaderValue(
  headers: Record<string, unknown> | undefined,
  name: string
): unknown {
  if (!headers) {
    return undefined;
  }

  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === name.toLowerCase()) {
      return value;
    }
  }

  return undefined;
}

function normalizeCacheControlHeader(
  req: IncomingMessage,
  value: unknown,
  nextCacheHeaderValue: unknown
): string {
  const raw = Array.isArray(value) ? value.join(', ') : String(value ?? '');
  const normalized = raw.trim();
  if (normalized.length === 0) {
    return raw;
  }

  const lower = normalized.toLowerCase();
  const hasNextCacheMarker =
    typeof nextCacheHeaderValue === 'string' && nextCacheHeaderValue.length > 0;
  const isDataRequest =
    typeof req.url === 'string' && req.url.includes('/_next/data/');

  if (
    hasNextCacheMarker &&
    !isDataRequest &&
    lower === 'private, no-cache, no-store, max-age=0, must-revalidate'
  ) {
    // Pages-router fallback HTML responses in deploy mode still flow through
    // Next's private no-store branch on the first MISS. Deployed environments
    // expose these as public must-revalidate responses instead.
    return 'public, max-age=0, must-revalidate';
  }

  if (lower.includes('immutable')) {
    return normalized;
  }

  if (lower.includes('s-maxage=')) {
    return 'public, max-age=0, must-revalidate';
  }

  return normalized;
}

function patchCacheControlHeader(req: IncomingMessage, res: ServerResponse): void {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return;
  }

  const mutableRes = res as unknown as {
    setHeader: (...args: unknown[]) => ServerResponse;
    writeHead: (...args: unknown[]) => ServerResponse;
  };
  const originalSetHeader = res.setHeader.bind(res);
  mutableRes.setHeader = (name: unknown, value: unknown) => {
    if (typeof name === 'string' && name.toLowerCase() === 'cache-control') {
      return originalSetHeader(
        name,
        normalizeCacheControlHeader(req, value, res.getHeader('x-nextjs-cache'))
      );
    }
    return originalSetHeader(name as string, value as never);
  };

  const originalWriteHead = res.writeHead.bind(res) as (
    ...args: unknown[]
  ) => ServerResponse;
  mutableRes.writeHead = (
    statusCode: unknown,
    statusMessage?: unknown,
    headers?: unknown
  ) => {
    let resolvedStatusMessage = statusMessage;
    let resolvedHeaders = headers;

    if (
      resolvedHeaders === undefined &&
      isRecord(resolvedStatusMessage)
    ) {
      resolvedHeaders = resolvedStatusMessage;
      resolvedStatusMessage = undefined;
    }

    if (isRecord(resolvedHeaders)) {
      const nextCacheHeaderValue =
        getHeaderValue(resolvedHeaders, 'x-nextjs-cache') ??
        res.getHeader('x-nextjs-cache');
      for (const key of Object.keys(resolvedHeaders)) {
        if (key.toLowerCase() !== 'cache-control') {
          continue;
        }
        resolvedHeaders[key] = normalizeCacheControlHeader(
          req,
          resolvedHeaders[key],
          nextCacheHeaderValue
        );
      }
    }

    if (resolvedStatusMessage === undefined) {
      return originalWriteHead(statusCode, resolvedHeaders);
    }

    return originalWriteHead(statusCode, resolvedStatusMessage, resolvedHeaders);
  };
}

async function prepareActionRequestBodyForBun(req: IncomingMessage): Promise<void> {
  if (req.method !== 'POST') {
    return;
  }

  const actionId = getSingleHeaderValue(req.headers['next-action']);
  if (typeof actionId !== 'string' || actionId.length === 0) {
    return;
  }

  const chunks: Buffer[] = [];
  for await (const chunk of req as AsyncIterable<unknown>) {
    if (chunk === undefined || chunk === null) {
      continue;
    }
    if (Buffer.isBuffer(chunk)) {
      chunks.push(chunk);
      continue;
    }
    if (chunk instanceof Uint8Array) {
      chunks.push(Buffer.from(chunk));
      continue;
    }
    if (typeof chunk === 'string') {
      chunks.push(Buffer.from(chunk));
    }
  }

  const requestBody = Buffer.concat(chunks);

  // Bun's IncomingMessage can complete before Next attaches stream listeners
  // for forwarded Server Actions. Replaying a buffered body keeps request
  // consumption semantics stable while letting Next own action routing.
  req.headers['content-length'] =
    requestBody.length > 0 ? String(requestBody.length) : '0';
  delete req.headers['transfer-encoding'];

  const replayStream = Readable.from(requestBody);
  const mutableReq = req as any;
  const originalOn = req.on.bind(req);
  const originalOnce = req.once.bind(req);
  const originalRemoveListener = req.removeListener.bind(req);

  mutableReq.on = (event: string, listener: (...args: unknown[]) => void) => {
    if (event === 'data' || event === 'end' || event === 'error' || event === 'readable') {
      replayStream.on(event, listener);
      return req;
    }
    return originalOn(event, listener);
  };

  mutableReq.once = (event: string, listener: (...args: unknown[]) => void) => {
    if (event === 'data' || event === 'end' || event === 'error' || event === 'readable') {
      replayStream.once(event, listener);
      return req;
    }
    return originalOnce(event, listener);
  };

  mutableReq.removeListener = (
    event: string,
    listener: (...args: unknown[]) => void
  ) => {
    if (event === 'data' || event === 'end' || event === 'error' || event === 'readable') {
      replayStream.removeListener(event, listener);
      return req;
    }
    return originalRemoveListener(event, listener);
  };

  mutableReq.pipe = replayStream.pipe.bind(replayStream);
  mutableReq.read = replayStream.read.bind(replayStream);
  mutableReq.pause = replayStream.pause.bind(replayStream);
  mutableReq.resume = replayStream.resume.bind(replayStream);
  mutableReq.setEncoding = replayStream.setEncoding.bind(replayStream);
  mutableReq.unshift = replayStream.unshift.bind(replayStream);
  mutableReq[Symbol.asyncIterator] = replayStream[Symbol.asyncIterator].bind(
    replayStream
  );
}

const adapterDir = import.meta.dirname;
const manifestPath = path.join(adapterDir, 'deployment-manifest.json');
const manifest = (await Bun.file(manifestPath).json()) as DeploymentManifest;

// NEXT_ADAPTER_PATH is required at build-time to activate adapter hooks, but
// keeping it at runtime changes Next.js request handling branches in ways that
// conflict with this standalone server entry.
delete process.env.NEXT_ADAPTER_PATH;

// Tell the cache handler where to find cache.db.
process.env.BUN_ADAPTER_CACHE_DB_PATH = path.join(adapterDir, 'cache.db');

// Resolve project directory (parent of bun-dist/).
const projectDir = process.env.NEXT_PROJECT_DIR || path.resolve(adapterDir, '..');

const requestedPort = Number.parseInt(process.env.PORT || '', 10);
const port =
  Number.isFinite(requestedPort) && requestedPort > 0
    ? requestedPort
    : resolveManifestPort(manifest);
const listenHostname = resolveManifestHostname(manifest);

const configuredHostname = process.env.NEXT_HOSTNAME || '';
const appHostname =
  configuredHostname &&
  !isWildcardHostname(configuredHostname)
    ? configuredHostname
    : !isWildcardHostname(listenHostname)
      ? listenHostname
      : 'localhost';
const protocol = process.env.__NEXT_EXPERIMENTAL_HTTPS === '1' ? 'https' : 'http';

// Next's forwarded action/redirect fetches rely on this internal origin.
process.env.__NEXT_PRIVATE_ORIGIN = `${protocol}://${appHostname}:${port}`;

const cacheRuntime = resolveCacheRuntimeConfig(manifest);
if (cacheRuntime.handlerMode === 'http') {
  const cacheAuthToken =
    process.env.BUN_ADAPTER_CACHE_HTTP_TOKEN ||
    cacheRuntime.authToken ||
    crypto.randomUUID();
  process.env.BUN_ADAPTER_CACHE_HTTP_TOKEN = cacheAuthToken;
  process.env.BUN_ADAPTER_CACHE_HTTP_URL =
    process.env.__NEXT_PRIVATE_ORIGIN + cacheRuntime.endpointPath;
}

async function loadRuntimeNextConfig(): Promise<RuntimeConfigRecord> {
  const runtimeNextConfigPath = path.join(adapterDir, RUNTIME_NEXT_CONFIG_FILE);

  let serializedConfig: RuntimeConfigRecord = {};
  try {
    const loadedConfig = await Bun.file(runtimeNextConfigPath).json();
    if (isRecord(loadedConfig)) {
      serializedConfig = loadedConfig;
    }
  } catch (error) {
    console.warn('[adapter-bun] failed to load adapter runtime next config:', error);
  }

  const distDir =
    typeof serializedConfig.distDir === 'string' && serializedConfig.distDir.length > 0
      ? serializedConfig.distDir
      : typeof manifest.build?.distDir === 'string' && manifest.build.distDir.length > 0
        ? manifest.build.distDir
        : DEFAULT_DIST_DIR;

  const handlerModules = getRuntimeHandlerModuleNames(cacheRuntime.handlerMode);
  const runtimeCacheHandlerPath = path.join(
    adapterDir,
    'runtime',
    handlerModules.incremental
  );
  const runtimeRemoteCacheHandlerPath = path.join(
    adapterDir,
    'runtime',
    handlerModules.useCache
  );
  const existingCacheHandlers = isRecord(serializedConfig.cacheHandlers)
    ? serializedConfig.cacheHandlers
    : {};

  return {
    ...serializedConfig,
    distDir,
    cacheHandler: runtimeCacheHandlerPath,
    cacheHandlers: {
      ...existingCacheHandlers,
      remote: runtimeRemoteCacheHandlerPath,
    },
  };
}

const runtimeNextConfig = await loadRuntimeNextConfig();
const createNext = (await import('next')).default;
const app = createNext({
  dir: projectDir,
  dev: false,
  quiet: false,
  hostname: appHostname,
  port,
  conf: runtimeNextConfig,
});
await app.prepare();
const handle = app.getRequestHandler();

const server = http.createServer(async (req, res) => {
  // Normalize Bun's incoming headers into a plain mutable object so Next can
  // safely patch/strip headers during RSC/action flows.
  (req as IncomingMessage & { headers: IncomingHttpHeaders }).headers = {
    ...req.headers,
  };

  if (cacheRuntime.handlerMode === 'http') {
    const requestUrl = new URL(req.url || '/', process.env.__NEXT_PRIVATE_ORIGIN);
    if (requestUrl.pathname === cacheRuntime.endpointPath) {
      await handleCacheHttpRequest(req, res, getSharedPrerenderCacheStore(), {
        authToken: process.env.BUN_ADAPTER_CACHE_HTTP_TOKEN,
      });
      return;
    }
  }

  patchCacheControlHeader(req, res);

  req.headers.connection = 'close';
  res.setHeader('connection', 'close');

  // Some Bun fetch requests use Accept: */* for RSC refetches. Force the
  // expected RSC accept header so Next serves Flight payloads instead of HTML.
  if (req.headers.rsc === '1') {
    if (!req.headers.accept || req.headers.accept === '*/*') {
      req.headers.accept = 'text/x-component';
    }
    // Forwarded action redirects can inherit POST content-type on GET.
    if (req.method === 'GET' && typeof req.headers['content-type'] === 'string') {
      delete req.headers['content-type'];
    }
  }

  try {
    await prepareActionRequestBodyForBun(req);
    await handle(req, res);
  } catch (err) {
    console.error('[adapter-bun] error handling request:', err);
    if (!res.headersSent) {
      res.writeHead(500, { 'content-type': 'text/plain' });
    }
    res.end('Internal Server Error');
  }
});

// The deploy test runner uses a shared keep-alive node-fetch agent.
// Node's default keepAliveTimeout (5s) is too short and can reset pooled
// sockets between requests, surfacing intermittent "socket hang up" errors.
const requestedKeepAliveTimeout = Number.parseInt(
  process.env.BUN_ADAPTER_KEEP_ALIVE_TIMEOUT || '',
  10
);
const keepAliveTimeout =
  Number.isFinite(requestedKeepAliveTimeout) && requestedKeepAliveTimeout > 0
    ? requestedKeepAliveTimeout
    : DEFAULT_KEEP_ALIVE_TIMEOUT;
server.keepAliveTimeout = keepAliveTimeout;
server.headersTimeout = Math.max(server.headersTimeout, keepAliveTimeout + 1_000);

const handleListening = () => {
  const addr = server.address();
  const listenPort = typeof addr === 'object' && addr ? addr.port : port;
  const formattedHostname =
    typeof addr === 'object' && addr && typeof addr.address === 'string'
      ? addr.address
      : listenHostname;
  const nextVersion =
    typeof manifest.build?.nextVersion === 'string'
      ? manifest.build.nextVersion
      : 'unknown';
  const buildId =
    typeof manifest.build?.buildId === 'string' ? manifest.build.buildId : 'unknown';

  console.log(
    `\n  Next.js (\x1b[36m${nextVersion}\x1b[0m) \x1b[2m|\x1b[0m adapter-bun\n` +
      `  Listening on http://${formattedHostname}:${listenPort}\n` +
      `  Build ID: ${buildId}\n`
  );
};

if (isWildcardHostname(listenHostname)) {
  // Let Node choose an unspecified address so IPv6/IPv4 dual-stack works when available.
  server.listen(port, handleListening);
} else {
  server.listen(port, listenHostname, handleListening);
}
