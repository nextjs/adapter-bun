import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
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
    const parsed = JSON.parse(await readFile(prerenderManifestPath, 'utf8')) as {
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

const adapterDir = import.meta.dirname;
const manifestPath = path.join(adapterDir, 'deployment-manifest.json');
const manifest = await Bun.file(manifestPath).json();

// NEXT_ADAPTER_PATH is required at build-time to activate adapter hooks, but
// keeping it at runtime changes Next.js request handling branches in ways that
// conflict with this standalone server entry.
delete process.env.NEXT_ADAPTER_PATH;

function inferContentType(pathname) {
  if (pathname.endsWith('.xml')) return 'application/xml';
  if (pathname.endsWith('.webmanifest')) return 'application/manifest+json';
  if (pathname.endsWith('.json')) return 'application/json';
  if (pathname.endsWith('.txt')) return 'text/plain';
  if (pathname.endsWith('.ico')) return 'image/x-icon';
  if (pathname.endsWith('.png')) return 'image/png';
  if (pathname.endsWith('.svg')) return 'image/svg+xml';
  if (pathname.endsWith('.js')) return 'application/javascript';
  if (pathname.endsWith('.css')) return 'text/css';
  if (pathname.endsWith('.html')) return 'text/html; charset=utf-8';
  return null;
}

const defaultStaticAssetCacheControl = 'public, max-age=0, must-revalidate';

const staticAssetMap = new Map();
if (Array.isArray(manifest.staticAssets)) {
  for (const asset of manifest.staticAssets) {
    if (!asset || typeof asset !== 'object') continue;
    if (
      typeof asset.pathname !== 'string' ||
      asset.pathname.length === 0 ||
      typeof asset.stagedPath !== 'string' ||
      asset.stagedPath.length === 0
    ) {
      continue;
    }
    staticAssetMap.set(asset.pathname, {
      filePath: path.join(adapterDir, asset.stagedPath),
      contentType:
        typeof asset.contentType === 'string' && asset.contentType.length > 0
          ? asset.contentType
          : inferContentType(asset.pathname),
      cacheControl:
        typeof asset.cacheControl === 'string' && asset.cacheControl.length > 0
          ? asset.cacheControl
          : defaultStaticAssetCacheControl,
    });
  }
}

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
const configuredHostname = process.env.NEXT_HOSTNAME || '';
const appHostname =
  configuredHostname && configuredHostname !== '0.0.0.0'
    ? configuredHostname
    : listenHostname !== '0.0.0.0'
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

const server = http.createServer(async (req, res) => {
  // Normalize Bun's incoming headers into a plain mutable object so Next can
  // safely patch/strip headers during RSC/action flows.
  req.headers = { ...req.headers };

  // Serve adapter-staged static assets directly. Some static metadata routes
  // are emitted as .body files and are not always represented in prerender
  // cache outputs.
  const requestTarget = req.url || '/';
  if (req.method === 'GET' || req.method === 'HEAD') {
    let pathname = null;
    try {
      pathname = new URL(requestTarget, protocol + '://' + appHostname).pathname;
    } catch {}

    if (pathname) {
      const staticAsset = staticAssetMap.get(pathname);
      if (staticAsset) {
        try {
          const file = Bun.file(staticAsset.filePath);
          if (await file.exists()) {
            if (staticAsset.contentType) {
              res.setHeader('content-type', staticAsset.contentType);
            }
            if (staticAsset.cacheControl) {
              res.setHeader('cache-control', staticAsset.cacheControl);
            }
            if (Number.isFinite(file.size) && file.size >= 0) {
              res.setHeader('content-length', String(file.size));
            }
            res.statusCode = 200;
            if (req.method === 'HEAD') {
              res.end();
              return;
            }
            const body = Buffer.from(await file.arrayBuffer());
            res.end(body);
            return;
          }
        } catch {}
      }
    }
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

  // Bun's Node HTTP compatibility can intermittently reset reused keep-alive
  // sockets in long E2E runs. Force short-lived connections for stability.
  req.headers.connection = 'close';
  res.setHeader('connection', 'close');

  try {
    await handle(req, res);
  } catch (err) {
    console.error('[adapter-bun] error handling request:', err);
    if (!res.headersSent) {
      res.writeHead(500, { 'content-type': 'text/plain' });
    }
    res.end('Internal Server Error');
  }
});

server.listen(port, listenHostname, () => {
  const addr = server.address();
  const listenPort = typeof addr === 'object' && addr ? addr.port : port;
  console.log(
    \`\\n  Next.js (\\x1b[36m\${manifest.build.nextVersion}\\x1b[0m) \\x1b[2m|\\x1b[0m adapter-bun\\n\` +
    \`  Listening on http://\${listenHostname}:\${listenPort}\\n\` +
    \`  Build ID: \${manifest.build.buildId}\\n\`
  );
});
`;

async function writeServerEntry(outDir: string): Promise<void> {
  await writeFile(path.join(outDir, 'server.js'), SERVER_ENTRY_TEMPLATE, 'utf8');
}

async function copyRuntimeModule(
  outDir: string,
  moduleName: string
): Promise<void> {
  const sourceDir = path.join(import.meta.dirname, 'runtime');
  const destDir = path.join(outDir, 'runtime');
  await mkdir(destDir, { recursive: true });
  await copyFile(
    path.join(sourceDir, moduleName),
    path.join(destDir, moduleName)
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
      body: string;
      tags: string[];
      revalidateAt: number | null;
      expiresAt: number | null;
    }> = [];

    for (const prerender of seedable) {
      const fallback = prerender.fallback!;
      const sourcePath = resolveSourcePath(repoRoot, fallback.filePath!);

      const bodyBuffer = await Bun.file(sourcePath).arrayBuffer();
      const body = Buffer.from(bodyBuffer).toString('base64');

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
          'base64',
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
