import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { Database } from 'bun:sqlite';
import type { NextAdapter } from 'next';
import type { AdapterOutput } from 'next';
import {
  buildDeploymentManifest,
  collectPrerenderedPathnames,
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
  BunMiddlewareArtifact,
  BunPrerenderArtifact,
  BunRouteArtifact,
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
  'server.js',
];
const EXTERNAL_RUNTIME_MODULES = [
  {
    sourcePath: createRequire(import.meta.url).resolve('@next/routing'),
    outputName: 'next-routing.cjs',
  },
] as const;

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

function resolveDistDirPath(ctx: BuildCompleteContext): string {
  return path.isAbsolute(ctx.distDir)
    ? ctx.distDir
    : path.join(ctx.projectDir, ctx.distDir);
}

function toPosixRelativePath(basePath: string, targetPath: string): string {
  return path.relative(basePath, targetPath).replace(/\\/g, '/');
}

function serializeMiddlewareOutput(
  ctx: BuildCompleteContext
): BunMiddlewareArtifact | null {
  const middlewareOutput = ctx.outputs.middleware;
  if (!middlewareOutput) {
    return null;
  }

  const distDirPath = resolveDistDirPath(ctx);
  const serialized: BunMiddlewareArtifact = {
    id: middlewareOutput.id,
    pathname: middlewareOutput.pathname,
    sourcePage: middlewareOutput.sourcePage,
    runtime: middlewareOutput.runtime,
    filePath: toPosixRelativePath(distDirPath, middlewareOutput.filePath),
    env: middlewareOutput.config.env ?? undefined,
    matchers: middlewareOutput.config.matchers ?? undefined,
  };

  if (middlewareOutput.runtime === 'edge') {
    serialized.assets = Object.fromEntries(
      Object.entries(middlewareOutput.assets).map(([name, assetPath]) => [
        name,
        toPosixRelativePath(distDirPath, assetPath),
      ])
    );

    if (middlewareOutput.wasmAssets) {
      serialized.wasmAssets = Object.fromEntries(
        Object.entries(middlewareOutput.wasmAssets).map(([name, assetPath]) => [
          name,
          toPosixRelativePath(distDirPath, assetPath),
        ])
      );
    }
  }

  return serialized;
}

function serializeRouteOutputs(ctx: BuildCompleteContext): BunRouteArtifact[] {
  const distDirPath = resolveDistDirPath(ctx);
  const outputs = [
    ...ctx.outputs.pages,
    ...ctx.outputs.pagesApi,
    ...ctx.outputs.appPages,
    ...ctx.outputs.appRoutes,
  ];

  return outputs.map((output) => ({
    id: output.id,
    pathname: output.pathname,
    sourcePage: output.sourcePage,
    runtime: output.runtime,
    type: output.type,
    filePath: toPosixRelativePath(distDirPath, output.filePath),
    assets:
      output.runtime === 'edge'
        ? Object.fromEntries(
            Object.entries(output.assets).map(([name, assetPath]) => [
              name,
              toPosixRelativePath(distDirPath, assetPath),
            ])
          )
        : undefined,
    wasmAssets:
      output.runtime === 'edge' && output.wasmAssets
        ? Object.fromEntries(
            Object.entries(output.wasmAssets).map(([name, assetPath]) => [
              name,
              toPosixRelativePath(distDirPath, assetPath),
            ])
          )
        : undefined,
    env: output.runtime === 'edge' ? output.config.env ?? undefined : undefined,
  }));
}

function serializePrerenderOutputs(ctx: BuildCompleteContext): BunPrerenderArtifact[] {
  return ctx.outputs.prerenders.map((output) => ({
    id: output.id,
    pathname: output.pathname,
    parentOutputId: output.parentOutputId,
    parentFallbackMode: output.parentFallbackMode,
  }));
}

function collectPrerenderFallbackFalseMap({
  ctx,
  routeOutputs,
}: {
  ctx: BuildCompleteContext;
  routeOutputs: BunRouteArtifact[];
}): Record<string, string[]> {
  const routeOutputPathnameById = new Map(
    routeOutputs.map((output) => [output.id, output.pathname])
  );
  const fallbackFalseMap = new Map<string, Set<string>>();

  for (const prerender of ctx.outputs.prerenders) {
    if (
      prerender.parentFallbackMode !== false ||
      prerender.pathname.includes('_next/data') ||
      prerender.pathname.endsWith('.rsc')
    ) {
      continue;
    }

    const parentPathname = routeOutputPathnameById.get(prerender.parentOutputId);
    if (!parentPathname) {
      throw new Error(
        `Invariant: missing parent output ${prerender.parentOutputId} for prerender ${JSON.stringify(prerender)}`
      );
    }

    const existing = fallbackFalseMap.get(parentPathname) ?? new Set<string>();
    existing.add(prerender.pathname);
    fallbackFalseMap.set(parentPathname, existing);
  }

  const serialized = Object.fromEntries(
    [...fallbackFalseMap.entries()].map(([pathname, values]) => [
      pathname,
      [...values].sort((a, b) => a.localeCompare(b)),
    ])
  );

  return serialized;
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

const SERVER_ENTRY_TEMPLATE = `import { startServer } from './runtime/server.js';

await startServer({
  adapterDir: import.meta.dirname,
  runtimeNextConfigFile: '${RUNTIME_NEXT_CONFIG_FILE}',
});
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

async function copyExternalRuntimeModule(
  outDir: string,
  sourcePath: string,
  outputName: string
): Promise<void> {
  const destDir = path.join(outDir, 'runtime');
  await mkdir(destDir, { recursive: true });
  await Bun.write(path.join(destDir, outputName), Bun.file(sourcePath));
}

async function stageRuntimeModules(outDir: string): Promise<void> {
  await Promise.all(
    [
      ...CACHE_RUNTIME_MODULES.map((mod) => copyRuntimeModule(outDir, mod)),
      ...EXTERNAL_RUNTIME_MODULES.map((mod) =>
        copyExternalRuntimeModule(outDir, mod.sourcePath, mod.outputName)
      ),
    ]
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
        created_at, revalidate_at, expires_at, postponed)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
      postponed: string | null;
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
        postponed:
          typeof fallback.postponedState === 'string'
            ? fallback.postponedState
            : null,
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
          entry.expiresAt,
          entry.postponed
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
  const prerenderedPathnames = collectPrerenderedPathnames(ctx.outputs);

  const staticAssets = await stageStaticAssets({
    outputs: ctx.outputs,
    projectDir: ctx.projectDir,
    basePath: ctx.config.basePath,
    outDir,
  });

  const port = options.port ?? DEFAULT_PORT;
  const hostname = options.hostname ?? DEFAULT_HOSTNAME;
  const previewProps = await readPreviewProps(ctx);
  const middleware = serializeMiddlewareOutput(ctx);
  const routeOutputs = serializeRouteOutputs(ctx);
  const prerenderArtifacts = serializePrerenderOutputs(ctx);
  const prerenderFallbackFalseMap = collectPrerenderFallbackFalseMap({
    ctx,
    routeOutputs,
  });

  const deploymentManifest = buildDeploymentManifest({
    adapterName: ADAPTER_NAME,
    adapterOutDir: configuredOutDir,
    ctx,
    generatedAt,
    pathnames,
    prerenderedPathnames,
    prerenderArtifacts,
    prerenderFallbackFalseMap,
    staticAssets,
    port,
    hostname,
    routeOutputs,
    routeGraph: ctx.routing,
    middleware,
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

      const distDirName =
        typeof config.distDir === 'string' && config.distDir.length > 0
          ? config.distDir
          : '.next';

      // Stage cache handler modules into the build dist tree so both Node and
      // edge output bundles can import them during compilation/runtime.
      const buildRuntimeDir = path.resolve(distDirName, 'adapter-bun-runtime');
      if (!existsSync(buildRuntimeDir)) {
        mkdirSync(buildRuntimeDir, { recursive: true });
      }
      const sourceDir = path.join(import.meta.dirname, 'runtime');
      for (const mod of CACHE_RUNTIME_MODULES) {
        const dest = path.join(buildRuntimeDir, mod);
        copyFileSync(path.join(sourceDir, mod), dest);
      }
      const useCacheHandlerPath = path.resolve(
        distDirName,
        'adapter-bun-runtime',
        'cache-handler.js'
      );
      const incrementalCacheHandlerPath = path.resolve(
        distDirName,
        'adapter-bun-runtime',
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
