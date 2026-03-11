import { cp, lstat, mkdir, readdir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import type {
  BunStaticAsset,
  BuildCompleteContext,
} from './types.ts';

const IMMUTABLE_STATIC_CACHE_CONTROL = 'public, max-age=31536000, immutable';
const HTML_ROUTE_CACHE_CONTROL = 'public, max-age=0, must-revalidate';
const INDEX_OBJECT_KEY = 'index';

function toPosixPath(input: string): string {
  return input.replace(/\\/g, '/');
}

function trimSlashes(value: string): string {
  return value.replace(/^\/+/, '').replace(/\/+$/, '');
}

function normalizeRelativePath(value: string): string {
  const normalized = path.posix.normalize(toPosixPath(value).replace(/^\/+/, ''));

  if (normalized === '.' || normalized.length === 0) {
    throw new Error(`Invalid relative path: "${value}"`);
  }
  if (normalized === '..' || normalized.startsWith('../')) {
    throw new Error(`Path escapes target directory: "${value}"`);
  }

  return normalized;
}

function resolveInside(baseDir: string, relativePath: string): string {
  const resolvedBase = path.resolve(baseDir);
  const resolvedTarget = path.resolve(resolvedBase, relativePath);
  const prefix = `${resolvedBase}${path.sep}`;

  if (resolvedTarget !== resolvedBase && !resolvedTarget.startsWith(prefix)) {
    throw new Error(`Resolved path escapes base directory: "${relativePath}"`);
  }

  return resolvedTarget;
}

function safePathnameToObjectKey(pathname: string): string {
  const trimmed = trimSlashes(pathname);
  return trimmed.length > 0 ? trimmed : INDEX_OBJECT_KEY;
}

function hasPathnameExtension(objectKey: string): boolean {
  const segments = objectKey.split('/');
  const lastSegment = segments[segments.length - 1] ?? '';
  const withoutInterceptionPrefix = lastSegment
    .replace(/^\(\.\.\.\)/, '')
    .replace(/^\(\.\.\)/, '')
    .replace(/^\(\.\)/, '');
  return path.posix.extname(withoutInterceptionPrefix).length > 0;
}

function buildStaticObjectKey(pathname: string, sourcePath: string): string {
  const baseKey = safePathnameToObjectKey(pathname);
  const sourceExtension = path.extname(sourcePath);
  const hasExtension = hasPathnameExtension(baseKey);

  if (!hasExtension && sourceExtension.length > 0) {
    return `${baseKey}${sourceExtension}`;
  }
  if (!hasExtension) {
    return path.posix.join(baseKey, INDEX_OBJECT_KEY);
  }

  return baseKey;
}

function sortByPathnameAndId<
  T extends {
    pathname: string;
    id: string;
  },
>(items: T[]): T[] {
  return [...items].sort((a, b) => {
    const byPathname = a.pathname.localeCompare(b.pathname);
    if (byPathname !== 0) return byPathname;
    return a.id.localeCompare(b.id);
  });
}

async function copyToOutDir({
  sourcePath,
  outDir,
  relativePath,
}: {
  sourcePath: string;
  outDir: string;
  relativePath: string;
}): Promise<void> {
  const normalizedRelativePath = normalizeRelativePath(relativePath);
  const destinationPath = resolveInside(outDir, normalizedRelativePath);
  const destinationDir = path.dirname(destinationPath);
  try {
    await mkdir(destinationDir, { recursive: true });
  } catch (error) {
    if (
      error &&
      typeof error === 'object' &&
      'code' in error &&
      (error as { code?: string }).code === 'EEXIST'
    ) {
      throw new Error(
        `Failed to create destination directory "${destinationDir}" while staging "${sourcePath}" as "${normalizedRelativePath}"`
      );
    }
    throw error;
  }

  const sourceLStat = await lstat(sourcePath);
  let sourceCopyPath = sourcePath;
  let sourceStat = sourceLStat;

  if (sourceLStat.isSymbolicLink()) {
    sourceCopyPath = await realpath(sourcePath);
    sourceStat = await stat(sourceCopyPath);
  }

  if (sourceStat.isDirectory()) {
    await cp(sourceCopyPath, destinationPath, {
      recursive: true,
      force: true,
    });
    return;
  }

  if (!sourceStat.isFile()) {
    throw new Error(
      `Unsupported asset type for "${sourcePath}" while staging "${relativePath}"`
    );
  }

  await Bun.write(destinationPath, Bun.file(sourceCopyPath));
}

async function findFilesRecursively(rootDir: string): Promise<string[]> {
  const entries = await readdir(rootDir, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const entryPath = path.join(rootDir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await findFilesRecursively(entryPath)));
      continue;
    }
    if (entry.isFile()) {
      files.push(entryPath);
    }
  }

  return files;
}

export async function writeTextFile(filePath: string, contents: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const writer = Bun.file(filePath).writer();
  writer.write(contents);
  await writer.end();
}

async function writeJson(filePath: string, payload: unknown): Promise<void> {
  await writeTextFile(filePath, `${JSON.stringify(payload, null, 2)}\n`);
}

function recordByObjectKey(
  seenByObjectKey: Map<string, string>,
  objectKey: string,
  sourcePath: string
): void {
  const existing = seenByObjectKey.get(objectKey);
  if (existing && existing !== sourcePath) {
    throw new Error(
      `Duplicate staged object key "${objectKey}" from "${existing}" and "${sourcePath}"`
    );
  }
  seenByObjectKey.set(objectKey, sourcePath);
}

function buildPublicPathname(basePath: string, fileRelativePath: string): string {
  const basePathWithoutSlashes = trimSlashes(basePath);
  if (basePathWithoutSlashes.length === 0) {
    return `/${fileRelativePath}`;
  }

  return path.posix.join('/', basePathWithoutSlashes, fileRelativePath);
}

function isHtmlSourcePath(sourcePath: string): boolean {
  return sourcePath.endsWith('.html');
}

function resolveStaticAssetCacheControl({
  pathname,
  sourcePath,
}: {
  pathname: string;
  sourcePath: string;
}): string | null {
  if (pathname.startsWith('/_next/static/')) {
    return IMMUTABLE_STATIC_CACHE_CONTROL;
  }
  if (isHtmlSourcePath(sourcePath)) {
    return HTML_ROUTE_CACHE_CONTROL;
  }
  return null;
}

function isExtensionlessRoutePathname(pathname: string): boolean {
  const normalized = trimSlashes(pathname);
  if (normalized.length === 0) {
    return true;
  }

  const segments = normalized.split('/');
  const lastSegment = segments[segments.length - 1] ?? '';
  if (lastSegment.startsWith('[') && lastSegment.endsWith(']')) {
    return true;
  }

  return path.posix.extname(lastSegment) === '';
}

function flattenHeaders(
  headers: Record<string, string | string[]> | undefined
): Record<string, string> | undefined {
  if (!headers) {
    return undefined;
  }

  const flattened: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    flattened[key] = Array.isArray(value) ? value.join(', ') : value;
  }
  return flattened;
}

export async function stageStaticAssets({
  outputs,
  projectDir,
  basePath,
  outDir,
}: {
  outputs: BuildCompleteContext['outputs'];
  projectDir: string;
  basePath: string;
  outDir: string;
}): Promise<BunStaticAsset[]> {
  const seenByObjectKey = new Map<string, string>();
  const assets: BunStaticAsset[] = [];

  for (const output of sortByPathnameAndId(outputs.staticFiles)) {
    const objectKey = buildStaticObjectKey(output.pathname, output.filePath);
    recordByObjectKey(seenByObjectKey, objectKey, output.filePath);

    const stagedPath = path.posix.join('static', objectKey);
    await copyToOutDir({
      sourcePath: output.filePath,
      outDir,
      relativePath: stagedPath,
    });

    assets.push({
      id: output.id,
      pathname: output.pathname,
      sourceType: 'next-static',
      sourcePath: output.filePath,
      stagedPath,
      objectKey,
      status: 200,
      contentType:
        path.extname(output.filePath) === '.html' &&
        isExtensionlessRoutePathname(output.pathname)
          ? 'text/html; charset=utf-8'
          : null,
      cacheControl: resolveStaticAssetCacheControl({
        pathname: output.pathname,
        sourcePath: output.filePath,
      }),
    });
  }

  for (const output of sortByPathnameAndId(outputs.prerenders).filter(
    (entry) => typeof entry.fallback?.filePath === 'string' && entry.fallback.filePath.length > 0
  )) {
    const sourcePath = output.fallback!.filePath!;
    const objectKey = buildStaticObjectKey(output.pathname, sourcePath);
    recordByObjectKey(seenByObjectKey, objectKey, sourcePath);

    const stagedPath = path.posix.join('static', objectKey);
    await copyToOutDir({
      sourcePath,
      outDir,
      relativePath: stagedPath,
    });

    const headers = flattenHeaders(output.fallback?.initialHeaders);
    const contentType =
      headers?.['content-type'] ??
      (path.extname(sourcePath) === '.html' &&
      isExtensionlessRoutePathname(output.pathname)
        ? 'text/html; charset=utf-8'
        : null);
    const cacheControl =
      headers?.['cache-control'] ??
      resolveStaticAssetCacheControl({
        pathname: output.pathname,
        sourcePath,
      });

    assets.push({
      id: output.id,
      pathname: output.pathname,
      sourceType: 'prerender',
      sourcePath,
      stagedPath,
      objectKey,
      status: output.fallback?.initialStatus ?? 200,
      headers,
      contentType,
      cacheControl,
    });
  }

  const publicDir = path.join(projectDir, 'public');
  const publicStat = await stat(publicDir).catch(() => null);
  if (publicStat?.isDirectory()) {
    const publicFiles = await findFilesRecursively(publicDir);
    publicFiles.sort((a, b) => a.localeCompare(b));

    for (const publicFilePath of publicFiles) {
      const fileRelativePath = toPosixPath(path.relative(publicDir, publicFilePath));
      const pathname = buildPublicPathname(basePath, fileRelativePath);
      const objectKey = safePathnameToObjectKey(pathname);
      recordByObjectKey(seenByObjectKey, objectKey, publicFilePath);

      const stagedPath = path.posix.join('static', objectKey);
      await copyToOutDir({
        sourcePath: publicFilePath,
        outDir,
        relativePath: stagedPath,
      });

      assets.push({
        id: `public:${fileRelativePath}`,
        pathname,
        sourceType: 'public',
        sourcePath: publicFilePath,
        stagedPath,
        objectKey,
        status: 200,
        contentType: null,
        cacheControl: null,
      });
    }
  }

  return assets.sort((a, b) => a.objectKey.localeCompare(b.objectKey));
}

export function writeJsonFile(filePath: string, payload: unknown): Promise<void> {
  return writeJson(filePath, payload);
}
