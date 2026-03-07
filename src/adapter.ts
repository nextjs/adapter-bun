import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { Database } from 'bun:sqlite';
import type { NextAdapter } from 'next';
import type { AdapterOutput } from 'next';
import {
  buildDeploymentManifest,
  collectOutputPathnames,
} from './manifest.ts';
import { SCHEMA_SQL } from './runtime/sqlite-cache.ts';
import {
  stageStaticAssets,
  writeTextFile,
  writeJsonFile,
} from './staging.ts';
import type {
  BunAdapterOptions,
  BunDeploymentManifest,
  BuildCompleteContext,
} from './types.ts';

export const ADAPTER_NAME = 'bun';
export const DEFAULT_BUN_ADAPTER_OUT_DIR = 'bun-dist';
const DEFAULT_PORT = 3000;
const DEFAULT_HOSTNAME = '0.0.0.0';
const RUNTIME_NEXT_CONFIG_FILE = 'runtime-next-config.json';
const CACHE_RUNTIME_MODULES = [
  'cache-handler.js',
  'incremental-cache-handler.js',
  'cache-store.js',
  'sqlite-cache.js',
  'isr.js',
];

type PreviewProps = NonNullable<
  NonNullable<BunDeploymentManifest['runtime']>['previewProps']
>;

function normalizeDeploymentHost(value: string | undefined): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return null;
  }

  const withoutProtocol = trimmed.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');
  const [host] = withoutProtocol.split('/', 1);
  const normalizedHost = host?.trim().toLowerCase() ?? '';
  return normalizedHost.length > 0 ? normalizedHost : null;
}

function resolveOutDir(projectDir: string, configuredOutDir: string): string {
  if (path.isAbsolute(configuredOutDir)) {
    return configuredOutDir;
  }
  return path.join(projectDir, configuredOutDir);
}

async function readPreviewProps(
  ctx: BuildCompleteContext
): Promise<PreviewProps | null> {
  const distDir = path.isAbsolute(ctx.distDir)
    ? ctx.distDir
    : path.join(ctx.projectDir, ctx.distDir);
  const prerenderManifestPath = path.join(distDir, 'prerender-manifest.json');

  try {
    const parsed = (await Bun.file(prerenderManifestPath).json()) as {
      preview?: Record<string, unknown>;
    };
    const preview = parsed.preview;
    if (!preview || typeof preview !== 'object') {
      return null;
    }

    const previewModeId = preview.previewModeId;
    const previewModeSigningKey = preview.previewModeSigningKey;
    const previewModeEncryptionKey = preview.previewModeEncryptionKey;
    if (
      typeof previewModeId !== 'string' ||
      typeof previewModeSigningKey !== 'string' ||
      typeof previewModeEncryptionKey !== 'string'
    ) {
      return null;
    }

    return {
      previewModeId,
      previewModeSigningKey,
      previewModeEncryptionKey,
    };
  } catch {
    return null;
  }
}

function toJsonRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}

function createRuntimeNextConfig(
  config: BuildCompleteContext['config']
): Record<string, unknown> {
  let cloned: unknown;
  try {
    cloned = JSON.parse(JSON.stringify(config));
  } catch {
    cloned = {};
  }

  const configRecord = toJsonRecord(cloned);
  delete configRecord.outputFileTracingRoot;
  delete configRecord.cacheHandler;

  const cacheHandlersValue = configRecord.cacheHandlers;
  if (cacheHandlersValue && typeof cacheHandlersValue === 'object') {
    const cacheHandlers = {
      ...(cacheHandlersValue as Record<string, unknown>),
    };
    delete cacheHandlers.remote;
    configRecord.cacheHandlers = cacheHandlers;
  }

  const experimentalValue = configRecord.experimental;
  if (experimentalValue && typeof experimentalValue === 'object') {
    const experimental = {
      ...(experimentalValue as Record<string, unknown>),
    };
    delete experimental.adapterPath;
    configRecord.experimental = experimental;
  }

  return configRecord;
}

async function writeRuntimeNextConfig(
  outDir: string,
  config: BuildCompleteContext['config']
): Promise<void> {
  const runtimeNextConfig = createRuntimeNextConfig(config);
  await writeJsonFile(path.join(outDir, RUNTIME_NEXT_CONFIG_FILE), runtimeNextConfig);
}

const SERVER_ENTRY_TEMPLATE = `import path from 'node:path';
import http from 'node:http';
import { Readable } from 'node:stream';

const adapterDir = import.meta.dirname;
const manifestPath = path.join(adapterDir, 'deployment-manifest.json');
const manifest = await Bun.file(manifestPath).json();

// NEXT_ADAPTER_PATH is required at build-time to activate adapter hooks, but
// keeping it at runtime changes Next.js request handling branches in ways that
// conflict with this standalone server entry.
delete process.env.NEXT_ADAPTER_PATH;

// Tell the cache handler where to find cache.db
process.env.BUN_ADAPTER_CACHE_DB_PATH = path.join(adapterDir, 'cache.db');

// Resolve project directory (parent of bun-dist/)
const projectDir = process.env.NEXT_PROJECT_DIR || path.resolve(adapterDir, '..');

const requestedPort = Number.parseInt(process.env.PORT || '', 10);
const port =
  Number.isFinite(requestedPort) && requestedPort > 0
    ? requestedPort
    : manifest.server.port;
const listenHostname = manifest.server.hostname;
const isWildcardHostname = (value) => value === '0.0.0.0' || value === '::';
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
process.env.__NEXT_PRIVATE_ORIGIN = protocol + '://' + appHostname + ':' + port;

async function loadRuntimeNextConfig() {
  const runtimeNextConfigPath = path.join(
    adapterDir,
    '${RUNTIME_NEXT_CONFIG_FILE}'
  );

  let serializedConfig = {};
  try {
    const loadedConfig = await Bun.file(runtimeNextConfigPath).json();
    if (loadedConfig && typeof loadedConfig === 'object') {
      serializedConfig = loadedConfig;
    }
  } catch (error) {
    console.warn(
      '[adapter-bun] failed to load adapter runtime next config:',
      error
    );
  }

  const configRecord =
    serializedConfig && typeof serializedConfig === 'object' ? serializedConfig : {};
  const distDir =
    typeof configRecord.distDir === 'string' && configRecord.distDir.length > 0
      ? configRecord.distDir
      : typeof manifest.build?.distDir === 'string' && manifest.build.distDir.length > 0
        ? manifest.build.distDir
        : '.next';
  const runtimeCacheHandlerPath = path.join(
    adapterDir,
    'runtime',
    'incremental-cache-handler.js'
  );
  const runtimeRemoteCacheHandlerPath = path.join(
    adapterDir,
    'runtime',
    'cache-handler.js'
  );
  const existingCacheHandlers =
    configRecord.cacheHandlers && typeof configRecord.cacheHandlers === 'object'
      ? configRecord.cacheHandlers
      : {};

  return {
    ...configRecord,
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
  conf: runtimeNextConfig
});
await app.prepare();
const handle = app.getRequestHandler();

function getSingleHeaderValue(value) {
  return Array.isArray(value) ? value[0] : value;
}

async function prepareActionRequestBodyForBun(req) {
  if (req.method !== 'POST') {
    return;
  }

  const actionId = getSingleHeaderValue(req.headers['next-action']);
  if (typeof actionId !== 'string' || actionId.length === 0) {
    return;
  }

  const chunks = [];
  for await (const chunk of req) {
    if (chunk === undefined || chunk === null) {
      continue;
    }
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const requestBody = Buffer.concat(chunks);

  // Bun's IncomingMessage can complete before Next attaches stream listeners
  // for forwarded Server Actions. Replaying a buffered body keeps request
  // consumption semantics stable while letting Next own action routing.
  if (requestBody.length > 0) {
    req.headers['content-length'] = String(requestBody.length);
  } else {
    req.headers['content-length'] = '0';
  }
  delete req.headers['transfer-encoding'];

  const replayStream = Readable.from(requestBody);
  const originalOn = req.on.bind(req);
  const originalOnce = req.once.bind(req);
  const originalRemoveListener = req.removeListener.bind(req);

  req.on = (event, listener) => {
    if (event === 'data' || event === 'end' || event === 'error' || event === 'readable') {
      replayStream.on(event, listener);
      return req;
    }
    return originalOn(event, listener);
  };

  req.once = (event, listener) => {
    if (event === 'data' || event === 'end' || event === 'error' || event === 'readable') {
      replayStream.once(event, listener);
      return req;
    }
    return originalOnce(event, listener);
  };

  req.removeListener = (event, listener) => {
    if (event === 'data' || event === 'end' || event === 'error' || event === 'readable') {
      replayStream.removeListener(event, listener);
      return req;
    }
    return originalRemoveListener(event, listener);
  };

  req.pipe = replayStream.pipe.bind(replayStream);
  req.read = replayStream.read.bind(replayStream);
  req.pause = replayStream.pause.bind(replayStream);
  req.resume = replayStream.resume.bind(replayStream);
  req.setEncoding = replayStream.setEncoding.bind(replayStream);
  req.unshift = replayStream.unshift.bind(replayStream);
  req[Symbol.asyncIterator] = replayStream[Symbol.asyncIterator].bind(replayStream);
}

function getHeaderValue(headers, name) {
  if (!headers || typeof headers !== 'object') {
    return undefined;
  }

  for (const [key, value] of Object.entries(headers)) {
    if (typeof key === 'string' && key.toLowerCase() === name.toLowerCase()) {
      return value;
    }
  }

  return undefined;
}

function normalizeCacheControlHeader(req, value, nextCacheHeaderValue) {
  const raw = Array.isArray(value) ? value.join(', ') : String(value ?? '');
  const normalized = raw.trim();
  if (normalized.length === 0) return raw;

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

function patchCacheControlHeader(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return;
  }

  const originalSetHeader = res.setHeader.bind(res);
  res.setHeader = (name, value) => {
    if (typeof name === 'string' && name.toLowerCase() === 'cache-control') {
      return originalSetHeader(
        name,
        normalizeCacheControlHeader(req, value, res.getHeader('x-nextjs-cache'))
      );
    }
    return originalSetHeader(name, value);
  };

  const originalWriteHead = res.writeHead.bind(res);
  res.writeHead = (statusCode, statusMessage, headers) => {
    let resolvedStatusMessage = statusMessage;
    let resolvedHeaders = headers;

    if (
      resolvedHeaders === undefined &&
      resolvedStatusMessage &&
      typeof resolvedStatusMessage === 'object' &&
      !Array.isArray(resolvedStatusMessage)
    ) {
      resolvedHeaders = resolvedStatusMessage;
      resolvedStatusMessage = undefined;
    }

    if (resolvedHeaders && typeof resolvedHeaders === 'object') {
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

const server = http.createServer(async (req, res) => {
  // Normalize Bun's incoming headers into a plain mutable object so Next can
  // safely patch/strip headers during RSC/action flows.
  req.headers = { ...req.headers };
  patchCacheControlHeader(req, res);

  const userAgent =
    typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'] : '';
  if (userAgent.includes('node-fetch')) {
    // node-fetch@2 can reuse a keep-alive socket across mixed request methods
    // and hit ECONNRESET against the Bun->Node bridge. Force connection close
    // for its requests so each request gets a fresh socket.
    req.headers.connection = 'close';
    res.setHeader('connection', 'close');
  }

  // Some Bun fetch requests use Accept: */* for RSC refetches. Force the
  // expected RSC accept header so Next serves Flight payloads instead of HTML.
  if (req.headers['rsc'] === '1') {
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

const handleListening = () => {
  const addr = server.address();
  const listenPort = typeof addr === 'object' && addr ? addr.port : port;
  const formattedHostname =
    typeof addr === 'object' && addr && typeof addr.address === 'string'
      ? addr.address
      : listenHostname;
  console.log(
    \`\\n  Next.js (\\x1b[36m\${manifest.build.nextVersion}\\x1b[0m) \\x1b[2m|\\x1b[0m adapter-bun\\n\` +
    \`  Listening on http://\${formattedHostname}:\${listenPort}\\n\` +
    \`  Build ID: \${manifest.build.buildId}\\n\`
  );
};

if (isWildcardHostname(listenHostname)) {
  // Let Node choose an unspecified address so IPv6/IPv4 dual-stack works when available.
  server.listen(port, handleListening);
} else {
  server.listen(port, listenHostname, handleListening);
}
`;

async function writeServerEntry(outDir: string): Promise<void> {
  await writeTextFile(path.join(outDir, 'server.js'), SERVER_ENTRY_TEMPLATE);
}

async function copyRuntimeModule(
  outDir: string,
  moduleName: string
): Promise<void> {
  const sourceDir = path.join(import.meta.dirname, 'runtime');
  const destDir = path.join(outDir, 'runtime');
  await mkdir(destDir, { recursive: true });
  await Bun.write(
    path.join(destDir, moduleName),
    Bun.file(path.join(sourceDir, moduleName))
  );
}

async function stageRuntimeModules(outDir: string): Promise<void> {
  await Promise.all(
    CACHE_RUNTIME_MODULES.map((mod) => copyRuntimeModule(outDir, mod))
  );
}

function flattenHeaders(
  headers: Record<string, string | string[]> | null
): Record<string, string> {
  if (!headers) return {};
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    result[key] = Array.isArray(value) ? value.join(', ') : value;
  }
  return result;
}

function collectTags(
  config: AdapterOutput['PRERENDER']['config'],
  fallbackHeaders?: Record<string, string | string[]> | null
): string[] {
  const tags = new Set<string>();
  const record = config as Record<string, unknown>;

  function addValues(value: unknown): void {
    if (typeof value === 'string' && value.length > 0) {
      tags.add(value);
    } else if (Array.isArray(value)) {
      for (const item of value) {
        if (typeof item === 'string' && item.length > 0) tags.add(item);
      }
    }
  }

  addValues(record.tags);
  addValues(record.revalidateTags);
  addValues(record.cacheTags);

  const experimental =
    record.experimental && typeof record.experimental === 'object'
      ? (record.experimental as Record<string, unknown>)
      : null;
  if (experimental) {
    addValues(experimental.tags);
    addValues(experimental.revalidateTags);
    addValues(experimental.cacheTags);
  }

  if (fallbackHeaders) {
    const headerVal = fallbackHeaders['x-next-cache-tags'];
    const raw = Array.isArray(headerVal) ? headerVal.join(',') : headerVal;
    if (typeof raw === 'string') {
      for (const t of raw.split(',')) {
        const trimmed = t.trim();
        if (trimmed.length > 0) tags.add(trimmed);
      }
    }
  }

  return [...tags].sort();
}

function resolveSourcePath(repoRoot: string, filePath: string): string {
  return path.isAbsolute(filePath) ? filePath : path.resolve(repoRoot, filePath);
}

async function seedPrerenderCache({
  outDir,
  prerenders,
  repoRoot,
}: {
  outDir: string;
  prerenders: AdapterOutput['PRERENDER'][];
  repoRoot: string;
}): Promise<void> {
  const seedable = prerenders.filter((p) => p.fallback?.filePath);
  if (seedable.length === 0) return;

  const dbPath = path.join(outDir, 'cache.db');
  const db = new Database(dbPath);

  try {
    db.run('PRAGMA journal_mode = WAL');
    db.run(SCHEMA_SQL);

    const insertEntry = db.query(
      `INSERT OR REPLACE INTO prerender_entries
       (cache_key, pathname, group_id, status, headers, body, body_encoding,
        created_at, revalidate_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const insertTarget = db.query(
      `INSERT OR REPLACE INTO revalidate_targets (cache_key, pathname, group_id, tags)
       VALUES (?, ?, ?, ?)`
    );
    const insertTag = db.query(
      `INSERT OR IGNORE INTO revalidate_target_tags (tag, cache_key) VALUES (?, ?)`
    );

    const createdAt = Date.now();

    const entries: Array<{
      cacheKey: string;
      pathname: string;
      groupId: number;
      status: number;
      headers: string;
      body: Uint8Array;
      tags: string[];
      revalidateAt: number | null;
      expiresAt: number | null;
    }> = [];

    for (const prerender of seedable) {
      const fallback = prerender.fallback!;
      const sourcePath = resolveSourcePath(repoRoot, fallback.filePath!);

      const body = await Bun.file(sourcePath).bytes();

      const cacheKey = prerender.pathname;

      const tags = collectTags(prerender.config, fallback.initialHeaders);
      const headers = flattenHeaders(fallback.initialHeaders ?? null);
      if (tags.length > 0) {
        headers['x-next-cache-tags'] = tags.join(',');
      }

      const status = fallback.initialStatus ?? 200;

      let revalidateAt: number | null = null;
      if (typeof fallback.initialRevalidate === 'number' && fallback.initialRevalidate > 0) {
        revalidateAt = createdAt + fallback.initialRevalidate * 1000;
      }

      let expiresAt: number | null = null;
      if (typeof fallback.initialExpiration === 'number' && fallback.initialExpiration > 0) {
        expiresAt = createdAt + fallback.initialExpiration * 1000;
      }

      entries.push({
        cacheKey,
        pathname: prerender.pathname,
        groupId: prerender.groupId,
        status,
        headers: JSON.stringify(headers),
        body,
        tags,
        revalidateAt,
        expiresAt,
      });
    }

    db.transaction(() => {
      for (const entry of entries) {
        insertEntry.run(
          entry.cacheKey,
          entry.pathname,
          entry.groupId,
          entry.status,
          entry.headers,
          entry.body,
          'binary',
          createdAt,
          entry.revalidateAt,
          entry.expiresAt
        );

        insertTarget.run(
          entry.cacheKey,
          entry.pathname,
          entry.groupId,
          JSON.stringify(entry.tags)
        );

        for (const tag of entry.tags) {
          insertTag.run(tag, entry.cacheKey);
        }
      }
    })();
  } finally {
    db.close();
  }
}

async function onBuildComplete(
  ctx: BuildCompleteContext,
  configuredOutDir: string,
  options: BunAdapterOptions
): Promise<void> {
  const outDir = resolveOutDir(ctx.projectDir, configuredOutDir);
  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });

  const generatedAt = new Date().toISOString();
  const pathnames = collectOutputPathnames(ctx.outputs);

  const staticAssets = await stageStaticAssets({
    outputs: ctx.outputs,
    projectDir: ctx.projectDir,
    basePath: ctx.config.basePath,
    outDir,
  });

  const port = options.port ?? DEFAULT_PORT;
  const hostname = options.hostname ?? DEFAULT_HOSTNAME;
  const previewProps = await readPreviewProps(ctx);

  const deploymentManifest = buildDeploymentManifest({
    adapterName: ADAPTER_NAME,
    adapterOutDir: configuredOutDir,
    ctx,
    generatedAt,
    pathnames,
    staticAssets,
    port,
    hostname,
    previewProps,
  });

  await writeJsonFile(
    path.join(outDir, 'deployment-manifest.json'),
    deploymentManifest
  );

  await stageRuntimeModules(outDir);
  await seedPrerenderCache({
    outDir,
    prerenders: ctx.outputs.prerenders,
    repoRoot: ctx.repoRoot,
  });
  await writeRuntimeNextConfig(outDir, ctx.config);
  await writeServerEntry(outDir);
}

export function createBunAdapter(options: BunAdapterOptions = {}): NextAdapter {
  const configuredOutDir = options.outDir ?? DEFAULT_BUN_ADAPTER_OUT_DIR;
  const deploymentHost = normalizeDeploymentHost(
    options.deploymentHost ??
      process.env.BUN_ADAPTER_DEPLOYMENT_HOST ??
      undefined
  );

  return {
    name: ADAPTER_NAME,
    modifyConfig(config) {
      const configRecord = config as unknown as Record<string, unknown>;
      const existingServerActionsRaw = configRecord.serverActions;
      const existingServerActions =
        existingServerActionsRaw && typeof existingServerActionsRaw === 'object'
          ? (existingServerActionsRaw as Record<string, unknown>)
          : null;
      const existingAllowedOrigins = Array.isArray(
        existingServerActions?.allowedOrigins
      )
        ? existingServerActions.allowedOrigins.filter(
            (entry): entry is string => typeof entry === 'string'
          )
        : [];
      const allowedOrigins = deploymentHost
        ? [...new Set([...existingAllowedOrigins, deploymentHost])]
        : existingAllowedOrigins;

      // Inject SQLite-backed handlers for both Next.js cache APIs:
      // 1) nextConfig.cacheHandler (IncrementalCache handler class)
      // 2) nextConfig.cacheHandlers.default/remote (cacheComponents handlers)
      const existingCacheHandlers = configRecord.cacheHandlers as
        | Record<string, string | undefined>
        | undefined;

      // Stage the cache handler runtime into the output dir so the path is
      // inside the project tree (Turbopack rejects absolute paths that leave
      // the project root). The files are small and this is idempotent.
      const runtimeDir = path.resolve(configuredOutDir, 'runtime');
      if (!existsSync(runtimeDir)) {
        mkdirSync(runtimeDir, { recursive: true });
      }
      const sourceDir = path.join(import.meta.dirname, 'runtime');
      for (const mod of CACHE_RUNTIME_MODULES) {
        const dest = path.join(runtimeDir, mod);
        copyFileSync(path.join(sourceDir, mod), dest);
      }
      const useCacheHandlerPath = path.resolve(
        configuredOutDir,
        'runtime',
        'cache-handler.js'
      );
      const incrementalCacheHandlerPath = path.resolve(
        configuredOutDir,
        'runtime',
        'incremental-cache-handler.js'
      );

      const cacheHandlersConfig: Record<string, string | undefined> = {
        ...(existingCacheHandlers ?? {}),
        remote: useCacheHandlerPath,
      };

      return {
        ...config,
        ...(existingServerActions || allowedOrigins.length > 0
          ? {
              serverActions: {
                ...(existingServerActions ?? {}),
                ...(allowedOrigins.length > 0 ? { allowedOrigins } : {}),
              },
            }
          : {}),
        cacheHandler: incrementalCacheHandlerPath,
        cacheHandlers: cacheHandlersConfig,
        // Enable cacheComponents when the experimental flag is set via env.
        ...(process.env.__NEXT_CACHE_COMPONENTS === 'true' ||
        process.env.NEXT_PRIVATE_EXPERIMENTAL_CACHE_COMPONENTS === 'true'
          ? { cacheComponents: true }
          : {}),
      } as typeof config;
    },
    async onBuildComplete(ctx) {
      await onBuildComplete(ctx, configuredOutDir, options);
    },
  };
}
