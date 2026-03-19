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
const DEFAULT_CACHE_HANDLER_MODE = 'http';
const DEFAULT_CACHE_ENDPOINT_PATH = '/_adapter/cache';
const RUNTIME_NEXT_CONFIG_FILE = 'runtime-next-config.json';
const CACHE_RUNTIME_MODULES = [
  'cache-handler.js',
  'cache-handler-http.js',
  'cache-handler-registration.js',
  'cache-http-client.js',
  'cache-http-protocol.js',
  'cache-http-server.js',
  'incremental-cache-handler.js',
  'incremental-cache-codec.js',
  'incremental-cache-handler-http.js',
  'binary.js',
  'cache-store.js',
  'sqlite-cache.js',
  'isr.js',
];

type PreviewProps = NonNullable<
  NonNullable<BunDeploymentManifest['runtime']>['previewProps']
>;
type CacheRuntimeConfig = NonNullable<
  NonNullable<BunDeploymentManifest['runtime']>['cache']
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

function resolveCacheHandlerMode(
  options: BunAdapterOptions
): 'sqlite' | 'http' {
  return options.cacheHandlerMode ?? DEFAULT_CACHE_HANDLER_MODE;
}

function getRuntimeHandlerModuleNames(options: BunAdapterOptions): {
  incremental: string;
  useCache: string;
} {
  const mode = resolveCacheHandlerMode(options);
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
  delete configRecord.adapterPath;

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

function createRuntimeCacheConfig(options: BunAdapterOptions): CacheRuntimeConfig {
  return {
    handlerMode: resolveCacheHandlerMode(options),
    endpointPath: options.cacheEndpointPath ?? DEFAULT_CACHE_ENDPOINT_PATH,
    authToken: options.cacheAuthToken ?? null,
  };
}

async function writeServerEntry(outDir: string): Promise<void> {
  const sourcePath = path.join(import.meta.dirname, 'runtime', 'server.js');
  const sourceCode = await Bun.file(sourcePath).text();
  const runtimeServerCode = sourceCode
    .replace("from './cache-store.js';", "from './runtime/cache-store.js';")
    .replace(
      "from './cache-http-server.js';",
      "from './runtime/cache-http-server.js';"
    );
  await Bun.write(path.join(outDir, 'server.js'), runtimeServerCode);
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
  const cacheRuntime = createRuntimeCacheConfig(options);

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
    cacheRuntime,
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

      // Inject the IncrementalCache handler. The module also registers the
      // corresponding use-cache handler through Next's global cache symbol so
      // Edge bundles do not need nextConfig.cacheHandlers imports injected.
      const handlerModules = getRuntimeHandlerModuleNames(options);

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
      const incrementalCacheHandlerPath = path.resolve(
        configuredOutDir,
        'runtime',
        handlerModules.incremental
      );

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
