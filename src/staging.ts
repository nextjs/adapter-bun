import { copyFile, cp, lstat, mkdir, readdir, realpath, stat, writeFile } from 'node:fs/promises';
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

function buildStaticObjectKey(pathname: string, sourcePath: string): string {
  const baseKey = safePathnameToObjectKey(pathname);
  const sourceExtension = path.extname(sourcePath);
  const hasExtension = path.posix.extname(baseKey).length > 0;

  if (sourceExtension === '.html' && !hasExtension) {
    return `${baseKey}.html`;
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
  await mkdir(path.dirname(destinationPath), { recursive: true });

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

  await copyFile(sourceCopyPath, destinationPath);
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

async function writeJson(filePath: string, payload: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
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
