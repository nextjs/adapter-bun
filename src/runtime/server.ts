import { AsyncLocalStorage } from 'node:async_hooks';
import * as AsyncHooksImplementation from 'node:async_hooks';
import * as AssertImplementation from 'node:assert';
import * as BufferImplementation from 'node:buffer';
import { once } from 'node:events';
import * as EventsImplementation from 'node:events';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import http from 'node:http';
import { createRequire } from 'node:module';
import path from 'node:path';
import { Readable } from 'node:stream';
import * as UtilImplementation from 'node:util';
import { pathToFileURL } from 'node:url';
import { runInContext } from 'node:vm';
import { EdgeRuntime } from 'edge-runtime';
import edgeUseCacheHandler from './cache-handler.ts';
import BunSqliteIncrementalCacheHandler from './incremental-cache-handler.ts';
import type {
  BunDeploymentManifest,
  BunMiddlewareArtifact,
  BunPrerenderArtifact,
  BunRouteArtifact,
} from '../types.ts';

type JsonRecord = Record<string, unknown>;
type QueryValue = string | string[];
type QueryObject = Record<string, QueryValue>;
type ResolveRoutesResult = {
  middlewareResponded?: boolean;
  externalRewrite?: URL;
  redirect?: {
    url: URL;
    status: number;
  };
  matchedPathname?: string;
  resolvedPathname?: string;
  query?: QueryObject;
  resolvedQuery?: QueryObject;
  resolvedHeaders?: Headers;
  status?: number;
  routeMatches?: Record<string, string>;
};
type ResolveRoutesFn = (params: {
  url: URL;
  buildId: string;
  basePath: string;
  requestBody: ReadableStream;
  headers: Headers;
  pathnames: string[];
  i18n?: {
    defaultLocale: string;
    domains?: Array<{
      defaultLocale: string;
      domain: string;
      http?: true;
      locales?: string[];
    }>;
    localeDetection?: false;
    locales: string[];
  };
  routes: BunDeploymentManifest['routeGraph'];
  invokeMiddleware: (ctx: {
    url: URL;
    headers: Headers;
    requestBody: ReadableStream;
  }) => Promise<{
    bodySent?: boolean;
    requestHeaders?: Headers;
    responseHeaders?: Headers;
    redirect?: {
      url: URL;
      status: number;
    };
    rewrite?: URL;
  }>;
}) => Promise<ResolveRoutesResult>;
type ResponseToMiddlewareResultFn = (
  response: Response,
  requestHeaders: Headers,
  url: URL
) => {
  bodySent?: boolean;
  requestHeaders?: Headers;
  responseHeaders?: Headers;
  redirect?: {
    url: URL;
    status: number;
  };
  rewrite?: URL;
};
type NodeRouteHandler = (
  req: http.IncomingMessage,
  res: http.ServerResponse,
  ctx: {
    waitUntil?: (promise: Promise<void>) => void;
    requestMeta?: JsonRecord;
  }
) => Promise<unknown> | unknown;
type EdgeRouteHandler = (
  request: Request,
  ctx: {
    waitUntil?: (promise: Promise<void>) => void;
    signal?: AbortSignal;
    requestMeta?: JsonRecord;
  }
) => Promise<unknown> | unknown;
type EdgeRuntimeInstance = InstanceType<typeof EdgeRuntime>;
type EdgeRuntimeExecutor = {
  runtime: EdgeRuntimeInstance;
  entryKey: string;
  sourcePage: string;
  outputId: string;
};
type EdgeEntryModule = {
  handler?: EdgeRouteHandler;
};
type EdgeFetchEventResultLike = {
  response: unknown;
  waitUntil?: Promise<unknown>;
};
type EdgeResponseLike = {
  status: number;
  statusText?: string;
  headers: unknown;
  arrayBuffer: () => Promise<ArrayBuffer>;
};
type RouteInvocationMeta = {
  originalUrl: string;
  resolvedPathname?: string;
  routeMatches?: Record<string, string>;
  source?: 'not-found' | 'error';
};
type EdgeGlobalCacheHandlers = {
  FetchCache?: unknown;
  DefaultCache?: unknown;
  RemoteCache?: unknown;
};
type MiddlewareMatcher = NonNullable<BunMiddlewareArtifact['matchers']>[number];
type MiddlewareMatcherCondition = {
  type: 'header' | 'query' | 'cookie' | 'host';
  key: string;
  value?: string;
};

const EDGE_NATIVE_MODULES = new Map<string, unknown>([
  ['async_hooks', AsyncHooksImplementation],
  ['node:async_hooks', AsyncHooksImplementation],
  ['assert', AssertImplementation],
  ['node:assert', AssertImplementation],
  ['buffer', BufferImplementation],
  ['node:buffer', BufferImplementation],
  ['events', EventsImplementation],
  ['node:events', EventsImplementation],
  ['util', UtilImplementation],
  ['node:util', UtilImplementation],
]);
const NEXT_ROUTER_STATE_TREE_HEADER = 'next-router-state-tree';
const NEXT_URL_HEADER = 'next-url';
const NEXT_RSC_UNION_QUERY = '_rsc';

interface StartServerOptions {
  adapterDir?: string;
  runtimeNextConfigFile?: string;
}

function readFunctionExport<T extends Function>(
  name: string,
  namespace: Record<string, unknown>
): T {
  const direct = namespace[name];
  if (typeof direct === 'function') {
    return direct as unknown as T;
  }

  const defaultNamespace = namespace.default as
    | Record<string, unknown>
    | undefined;
  const fromDefault = defaultNamespace?.[name];
  if (typeof fromDefault === 'function') {
    return fromDefault as unknown as T;
  }

  throw new Error(
    `[adapter-bun] failed to resolve @next/routing export "${name}"`
  );
}

function createEmptyBodyStream(): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.close();
    },
  });
}

function toJsonRecord(value: unknown): JsonRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  return value as JsonRecord;
}

function toResolutionI18nConfig(
  manifest: BunDeploymentManifest
): ResolveRoutesFn extends (params: infer P) => unknown
  ? P extends { i18n?: infer I18n }
    ? I18n
    : never
  : never {
  const i18n = manifest.build.i18n;
  if (!i18n) {
    return undefined as never;
  }

  return {
    defaultLocale: i18n.defaultLocale,
    locales: [...i18n.locales],
    localeDetection: i18n.localeDetection ?? undefined,
    domains: i18n.domains?.map((domain) => ({
      defaultLocale: domain.defaultLocale,
      domain: domain.domain,
      http: domain.http,
      locales: domain.locales ? [...domain.locales] : undefined,
    })),
  } as never;
}

function isI18nRootPathname(pathname: string, basePath: string): boolean {
  const normalizedBasePath =
    basePath && basePath !== '/' ? (basePath.endsWith('/') ? basePath.slice(0, -1) : basePath) : '';
  if (normalizedBasePath.length > 0) {
    return pathname === normalizedBasePath || pathname === `${normalizedBasePath}/`;
  }
  return pathname === '/';
}

function stripMiddlewareResponse(result: JsonRecord): JsonRecord {
  if (!('response' in result)) {
    return result;
  }

  const { response: _response, ...rest } = result;
  return rest;
}

function applyResolutionToResponse(
  response: Response,
  resolution: ResolveRoutesResult,
  explicitStatus?: number
): Response {
  const nextStatus = explicitStatus ?? resolution.status ?? response.status;
  const headers = new Headers(response.headers);

  if (resolution.resolvedHeaders) {
    for (const [key, value] of resolution.resolvedHeaders.entries()) {
      const normalizedKey = key.toLowerCase();
      if (normalizedKey === 'x-middleware-set-cookie') {
        headers.append('set-cookie', value);
        continue;
      }
      if (normalizedKey === 'cache-control' && headers.has('cache-control')) {
        continue;
      }
      if (headers.has(key)) {
        continue;
      }
      headers.set(key, value);
    }
  }

  return new Response(response.body, {
    status: nextStatus,
    statusText: response.statusText,
    headers,
  });
}

function resolveRedirectLocationWithPreservedSearch({
  location,
  requestUrl,
}: {
  location: string;
  requestUrl: URL;
}): string {
  if (requestUrl.search.length === 0 || location.length === 0) {
    return location;
  }

  let redirectedUrl: URL;
  try {
    redirectedUrl = new URL(location, requestUrl.origin);
  } catch {
    return location;
  }

  if (
    redirectedUrl.origin !== requestUrl.origin ||
    redirectedUrl.search.length > 0
  ) {
    return location;
  }

  const normalizePathname = (value: string): string =>
    value.length > 1 && value.endsWith('/') ? value.slice(0, -1) : value;
  if (
    normalizePathname(redirectedUrl.pathname) !==
    normalizePathname(requestUrl.pathname)
  ) {
    return location;
  }

  redirectedUrl.search = requestUrl.search;
  if (location.startsWith('/')) {
    return `${redirectedUrl.pathname}${redirectedUrl.search}${redirectedUrl.hash}`;
  }
  return redirectedUrl.toString();
}

function isRedirectResolution(resolution: ResolveRoutesResult): boolean {
  if (!resolution.status || resolution.status < 300 || resolution.status >= 400) {
    return false;
  }
  return Boolean(resolution.resolvedHeaders?.get('location'));
}

function resolveRouteOutputModulePath(
  runtimeDistDir: string,
  output: BunRouteArtifact
): string {
  const normalizedSourcePage = output.sourcePage.replace(/^\/+/, '');
  const candidatePaths: string[] = [path.join(runtimeDistDir, output.filePath)];

  switch (output.type) {
    case 'APP_PAGE':
      candidatePaths.push(
        path.join(runtimeDistDir, 'server', 'app', `${normalizedSourcePage}.js`),
        path.join(runtimeDistDir, 'server', 'app', normalizedSourcePage, 'page.js')
      );
      break;
    case 'APP_ROUTE':
      candidatePaths.push(
        path.join(runtimeDistDir, 'server', 'app', `${normalizedSourcePage}.js`),
        path.join(runtimeDistDir, 'server', 'app', normalizedSourcePage, 'route.js')
      );
      break;
    case 'PAGES':
    case 'PAGES_API': {
      const pagePath =
        normalizedSourcePage === '' || normalizedSourcePage === 'index'
          ? 'index'
          : normalizedSourcePage;
      candidatePaths.push(
        path.join(runtimeDistDir, 'server', 'pages', `${pagePath}.js`)
      );
      if (pagePath.endsWith('/index')) {
        candidatePaths.push(
          path.join(
            runtimeDistDir,
            'server',
            'pages',
            `${pagePath.slice(0, -'/index'.length)}.js`
          )
        );
      }
      break;
    }
    default:
      candidatePaths.push(path.join(runtimeDistDir, output.filePath));
      break;
  }

  for (const candidatePath of candidatePaths) {
    if (existsSync(candidatePath)) {
      return candidatePath;
    }
  }

  return candidatePaths[0] ?? path.join(runtimeDistDir, output.filePath);
}

function resolveEdgeArtifactModulePaths(
  runtimeDistDir: string,
  artifact: Pick<BunRouteArtifact, 'filePath' | 'assets'> &
    Partial<Pick<BunMiddlewareArtifact, 'assets'>>
): string[] {
  const seen = new Set<string>();
  const modulePaths: string[] = [];
  const isEdgeRuntimeModuleSource = (value: string): boolean => {
    const pathname = value.split('?')[0] ?? value;
    const ext = path.extname(pathname).toLowerCase();
    return ext === '.js' || ext === '.mjs' || ext === '.cjs';
  };

  const pushPath = ({
    moduleRelativePath,
    force,
  }: {
    moduleRelativePath: string | undefined;
    force?: boolean;
  }): void => {
    if (!moduleRelativePath || moduleRelativePath.length === 0) {
      return;
    }
    if (!force && !isEdgeRuntimeModuleSource(moduleRelativePath)) {
      return;
    }
    const absolutePath = path.isAbsolute(moduleRelativePath)
      ? moduleRelativePath
      : path.join(runtimeDistDir, moduleRelativePath);
    if (seen.has(absolutePath) || !existsSync(absolutePath)) {
      return;
    }
    seen.add(absolutePath);
    modulePaths.push(absolutePath);
  };

  const assetPaths = Object.values(artifact.assets ?? {});
  const nonWrapperAssetPaths = assetPaths.filter(
    (value) => !value.toLowerCase().includes('edge-wrapper')
  );
  const wrapperAssetPaths = assetPaths.filter((value) =>
    value.toLowerCase().includes('edge-wrapper')
  );

  for (const moduleRelativePath of nonWrapperAssetPaths) {
    pushPath({ moduleRelativePath });
  }
  for (const moduleRelativePath of wrapperAssetPaths) {
    pushPath({ moduleRelativePath });
  }
  pushPath({
    moduleRelativePath: artifact.filePath,
    force: true,
  });

  return modulePaths;
}

function normalizeEdgeEntrySourcePage(sourcePage: string): string {
  return sourcePage.replace(/^\/+/, '');
}

function normalizeEdgeOutputId(outputId: string): string {
  return outputId
    .replace(/\.rsc$/, '')
    .replace('_middleware', 'middleware')
    .replace(/^\/+/, '');
}

function getExpectedEdgeEntryKey(outputId: string): string {
  return `middleware_${normalizeEdgeOutputId(outputId)}`;
}

function getEdgeEntryKeyHints(sourcePage: string): string[] {
  const normalizedSourcePage = normalizeEdgeEntrySourcePage(sourcePage);
  if (normalizedSourcePage.length === 0) {
    return ['middleware_middleware'];
  }

  return [
    `middleware_${normalizedSourcePage}`,
    `middleware_app/${normalizedSourcePage}`,
    `middleware_pages/${normalizedSourcePage}`,
  ];
}

function resolveEdgeEntryKey({
  entries,
  sourcePage,
  outputId,
  previousEntryKey,
  beforeEntryKeys,
}: {
  entries: JsonRecord;
  sourcePage: string;
  outputId?: string;
  previousEntryKey?: string;
  beforeEntryKeys: Set<string>;
}): string | null {
  const entryKeys = Object.keys(entries);
  if (previousEntryKey && entryKeys.includes(previousEntryKey)) {
    return previousEntryKey;
  }

  const expectedEntryKey = outputId
    ? getExpectedEdgeEntryKey(outputId)
    : undefined;
  if (expectedEntryKey && entryKeys.includes(expectedEntryKey)) {
    return expectedEntryKey;
  }

  const hints = getEdgeEntryKeyHints(sourcePage);
  for (const hint of hints) {
    if (entryKeys.includes(hint)) {
      return hint;
    }
  }

  const normalizedSourcePage = normalizeEdgeEntrySourcePage(sourcePage);
  const newKeys = entryKeys.filter((key) => !beforeEntryKeys.has(key));
  const matchingNewKey = newKeys.find((key) =>
    normalizedSourcePage.length > 0 && key.includes(normalizedSourcePage)
  );
  if (matchingNewKey) {
    return matchingNewKey;
  }
  if (newKeys.length === 1) {
    return newKeys[0]!;
  }

  const matchingExistingKey = entryKeys.find((key) =>
    normalizedSourcePage.length > 0 && key.includes(normalizedSourcePage)
  );
  if (matchingExistingKey) {
    return matchingExistingKey;
  }

  return null;
}

function normalizeRscBasePathname(pathname: string): string {
  if (pathname === '/') {
    return '/index';
  }
  return pathname.endsWith('/') ? pathname.slice(0, -1) : pathname;
}

function isRscStaticAssetPath(
  pathname: string,
  routeGraph: BunDeploymentManifest['routeGraph']
): boolean {
  return (
    pathname.endsWith(routeGraph.rsc.suffix) ||
    pathname.includes(`${routeGraph.rsc.prefetchSegmentDirSuffix}/`)
  );
}

function canServeStaticAssetDirectly(
  asset: BunDeploymentManifest['staticAssets'][number],
  routeGraph: BunDeploymentManifest['routeGraph']
): boolean {
  return (
    asset.sourceType === 'next-static' ||
    asset.sourceType === 'public' ||
    asset.pathname.startsWith('/_next/static/') ||
    (asset.sourceType === 'prerender' &&
      isRscStaticAssetPath(asset.pathname, routeGraph))
  );
}

function maybeResolveRscMatchedPathname({
  request,
  matchedPathname,
  routeGraph,
  routeOutputsByPathname,
  staticAssetsByPathname,
}: {
  request: Request;
  matchedPathname: string;
  routeGraph: BunDeploymentManifest['routeGraph'];
  routeOutputsByPathname: Map<string, BunRouteArtifact>;
  staticAssetsByPathname: Map<string, BunDeploymentManifest['staticAssets'][number]>;
}): string {
  const rsc = routeGraph.rsc;
  const isRscRequest = request.headers.get(rsc.header) === '1';
  if (!isRscRequest) {
    return matchedPathname;
  }

  const hasOutputPathname = (pathname: string): boolean =>
    routeOutputsByPathname.has(pathname) || staticAssetsByPathname.has(pathname);

  const basePathname = normalizeRscBasePathname(matchedPathname);
  const segmentPrefetchPath = request.headers.get(rsc.prefetchSegmentHeader);

  if (segmentPrefetchPath && segmentPrefetchPath.length > 0) {
    const normalizedSegmentPath = segmentPrefetchPath.replace(/^\/+/, '');
    const segmentCandidatePathname = `${basePathname}${rsc.prefetchSegmentDirSuffix}/${normalizedSegmentPath}${rsc.prefetchSegmentSuffix}`;
    if (hasOutputPathname(segmentCandidatePathname)) {
      return segmentCandidatePathname;
    }
  }

  const rscCandidatePathname = `${basePathname}${rsc.suffix}`;
  if (hasOutputPathname(rscCandidatePathname)) {
    return rscCandidatePathname;
  }

  return matchedPathname;
}

function maybeResolveNextDataMatchedPathname({
  request,
  manifest,
  routeOutputsByPathname,
  staticAssetsByPathname,
}: {
  request: Request;
  manifest: BunDeploymentManifest;
  routeOutputsByPathname: Map<string, BunRouteArtifact>;
  staticAssetsByPathname: Map<string, BunDeploymentManifest['staticAssets'][number]>;
}): string | null {
  const requestUrl = new URL(request.url);
  const resolvedPathname = resolvePagePathnameFromNextDataPathname(
    requestUrl.pathname,
    manifest
  );
  if (!resolvedPathname) {
    return null;
  }
  if (
    routeOutputsByPathname.has(resolvedPathname) ||
    staticAssetsByPathname.has(resolvedPathname)
  ) {
    return resolvedPathname;
  }

  return null;
}

function isNextDataRequestPath({
  request,
  manifest,
}: {
  request: Request;
  manifest: BunDeploymentManifest;
}): boolean {
  return (
    request.headers.get('x-nextjs-data') === '1' ||
    isNextDataPathname(new URL(request.url).pathname, manifest)
  );
}

function getNextDataPathPrefix(manifest: BunDeploymentManifest): string {
  const basePath =
    manifest.build.basePath && manifest.build.basePath !== '/'
      ? manifest.build.basePath
      : '';
  return `${basePath}/_next/data/${manifest.build.buildId}/`;
}

function isNextDataPathname(
  pathname: string,
  manifest: BunDeploymentManifest
): boolean {
  const dataPrefix = getNextDataPathPrefix(manifest);
  return pathname.startsWith(dataPrefix) && pathname.endsWith('.json');
}

function resolvePagePathnameFromNextDataPathname(
  pathname: string,
  manifest: BunDeploymentManifest
): string | null {
  if (!isNextDataPathname(pathname, manifest)) {
    return null;
  }

  const dataPrefix = getNextDataPathPrefix(manifest);
  const withoutPrefix = pathname.slice(dataPrefix.length, -'.json'.length);
  let pagePathname =
    withoutPrefix === 'index'
      ? '/'
      : `/${withoutPrefix}`.replace(/\/+/g, '/').replace(/\/index$/, '') || '/';
  const basePath =
    manifest.build.basePath && manifest.build.basePath !== '/'
      ? manifest.build.basePath
      : '';
  if (basePath) {
    pagePathname = pagePathname === '/' ? basePath : `${basePath}${pagePathname}`;
  }
  return pagePathname;
}

function resolveNextDataPathnameFromPagePathname(
  pathname: string,
  manifest: BunDeploymentManifest
): string {
  const dataPrefix = getNextDataPathPrefix(manifest);
  const basePath =
    manifest.build.basePath && manifest.build.basePath !== '/'
      ? manifest.build.basePath
      : '';
  let normalizedPathname = pathname;
  if (basePath && pathHasPrefix(normalizedPathname, basePath)) {
    normalizedPathname = removePathPrefix(normalizedPathname, basePath);
  }
  if (normalizedPathname.length === 0 || normalizedPathname === '/') {
    return `${dataPrefix}index.json`;
  }
  const withoutLeadingSlash = normalizedPathname.replace(/^\/+/, '');
  return `${dataPrefix}${withoutLeadingSlash}.json`;
}

function resolveNextDataInvocationPathname({
  requestPathname,
  middlewareRewriteUrl,
  requestedResolutionPathname,
  upstreamRequestUrl,
  manifest,
}: {
  requestPathname: string;
  middlewareRewriteUrl: string | null;
  requestedResolutionPathname: string | null;
  upstreamRequestUrl: URL;
  manifest: BunDeploymentManifest;
}): string {
  const requestIsNextDataPath = isNextDataPathname(requestPathname, manifest);
  if (!requestIsNextDataPath) {
    let targetPagePathname = requestPathname;
    if (middlewareRewriteUrl) {
      try {
        targetPagePathname = new URL(
          middlewareRewriteUrl,
          upstreamRequestUrl
        ).pathname;
      } catch {
        // Fall through to resolution/request path when rewrite URL cannot be parsed.
      }
    } else if (
      requestedResolutionPathname &&
      !requestedResolutionPathname.includes('[') &&
      !hasInterceptionMarker(requestedResolutionPathname)
    ) {
      targetPagePathname = requestedResolutionPathname;
    }
    const normalizedTargetPagePathname =
      targetPagePathname.length > 1 && targetPagePathname.endsWith('/')
        ? targetPagePathname.slice(0, -1)
        : targetPagePathname;
    return resolveNextDataPathnameFromPagePathname(
      normalizedTargetPagePathname,
      manifest
    );
  }

  if (!requestedResolutionPathname) {
    return requestPathname;
  }

  if (middlewareRewriteUrl) {
    try {
      const rewritePathname = new URL(
        middlewareRewriteUrl,
        upstreamRequestUrl
      ).pathname;
      if (isNextDataPathname(rewritePathname, manifest)) {
        return rewritePathname;
      }
    } catch {
      // Fall through to request pathname when rewrite URL cannot be parsed.
    }
  }

  return requestPathname;
}

function resolveCanonicalNextDataToPageRedirectUrl({
  requestPathname,
  resolution,
  requestUrl,
  manifest,
}: {
  requestPathname: string;
  resolution: ResolveRoutesResult;
  requestUrl: URL;
  manifest: BunDeploymentManifest;
}): URL | null {
  if (!isNextDataPathname(requestPathname, manifest)) {
    return null;
  }

  const requestPagePathname = resolvePagePathnameFromNextDataPathname(
    requestPathname,
    manifest
  );
  if (!requestPagePathname) {
    return null;
  }

  const location =
    resolution.redirect?.url.toString() ??
    resolution.resolvedHeaders?.get('location') ??
    null;
  if (!location) {
    return null;
  }

  let redirectUrl: URL;
  try {
    redirectUrl = new URL(location, requestUrl);
  } catch {
    return null;
  }

  const normalizePathname = (value: string): string =>
    value.length > 1 && value.endsWith('/') ? value.slice(0, -1) : value;

  if (
    normalizePathname(redirectUrl.pathname) !==
    normalizePathname(requestPagePathname)
  ) {
    return null;
  }

  return redirectUrl;
}

function normalizeIndexPathnameAlias(
  pathname: string | null,
  routeOutputsByPathname: Map<string, BunRouteArtifact>,
  staticAssetsByPathname: Map<string, BunDeploymentManifest['staticAssets'][number]>,
  prerenderArtifactsByPathname: Map<string, BunPrerenderArtifact>
): string | null {
  if (!pathname) {
    return pathname;
  }

  const hasPathname = (candidate: string): boolean =>
    routeOutputsByPathname.has(candidate) ||
    staticAssetsByPathname.has(candidate) ||
    prerenderArtifactsByPathname.has(candidate);

  const hasRootPathname = hasPathname('/');
  const hasIndexPathname = hasPathname('/index');

  if (pathname === '/index' && hasRootPathname) {
    return '/';
  }

  if (pathname === '/' && !hasRootPathname && hasIndexPathname) {
    return '/index';
  }

  if (pathname !== '/' && pathname.endsWith('/')) {
    const withoutTrailingSlash = pathname.slice(0, -1);
    if (!hasPathname(pathname) && hasPathname(withoutTrailingSlash)) {
      const prefersNestedIndexForPrerender =
        staticAssetsByPathname.get(withoutTrailingSlash)?.sourceType ===
          'prerender' &&
        routeOutputsByPathname.has(`${withoutTrailingSlash}/index`);
      if (!prefersNestedIndexForPrerender) {
        return withoutTrailingSlash;
      }
    }
  } else if (pathname !== '/') {
    const withTrailingSlash = `${pathname}/`;
    if (!hasPathname(pathname) && hasPathname(withTrailingSlash)) {
      return withTrailingSlash;
    }
  }

  if (pathname !== '/' && pathname.endsWith('/index')) {
    const withoutIndex = pathname.slice(0, -'/index'.length) || '/';
    if (hasPathname(withoutIndex)) {
      return withoutIndex;
    }
  }

  if (
    pathname !== '/' &&
    !pathname.endsWith('/index') &&
    (!hasPathname(pathname) ||
      (staticAssetsByPathname.get(pathname)?.sourceType === 'prerender' &&
        routeOutputsByPathname.has(
          `${pathname.endsWith('/') ? pathname.slice(0, -1) : pathname}/index`
        )))
  ) {
    const pathnameWithoutTrailingSlash =
      pathname.endsWith('/') && pathname.length > 1
        ? pathname.slice(0, -1)
        : pathname;
    const withIndex = `${pathnameWithoutTrailingSlash}/index`;
    if (hasPathname(withIndex)) {
      return withIndex;
    }
  }

  return pathname;
}

function searchParamsToQueryObject(searchParams: URLSearchParams): QueryObject {
  const query: QueryObject = {};

  for (const [key, value] of searchParams.entries()) {
    const existing = query[key];
    if (existing === undefined) {
      query[key] = value;
      continue;
    }
    query[key] = Array.isArray(existing) ? [...existing, value] : [existing, value];
  }

  return query;
}

function appendQueryObject(
  searchParams: URLSearchParams,
  query: QueryObject
): void {
  for (const [key, value] of Object.entries(query)) {
    if (Array.isArray(value)) {
      for (const item of value) {
        searchParams.append(key, item);
      }
      continue;
    }
    searchParams.append(key, value);
  }
}

function overwriteQueryObject(
  searchParams: URLSearchParams,
  query: QueryObject
): void {
  for (const key of Object.keys(query)) {
    searchParams.delete(key);
  }
  appendQueryObject(searchParams, query);
}

function extractRouteGraphDestinationQuery({
  requestUrl,
  requestHeaders,
  routeGraph,
}: {
  requestUrl: URL;
  requestHeaders: Headers;
  routeGraph: BunDeploymentManifest['routeGraph'];
}): QueryObject {
  const query: QueryObject = {};
  const routeGroups = [
    routeGraph.beforeFiles,
    routeGraph.afterFiles,
    routeGraph.fallback,
  ];

  for (const routes of routeGroups) {
    for (const route of routes) {
      if (
        !route.destination ||
        route.destination.length === 0 ||
        route.status ||
        route.destination.startsWith('http://') ||
        route.destination.startsWith('https://')
      ) {
        continue;
      }
      if (
        Array.isArray((route as { has?: unknown[] }).has) &&
        ((route as { has?: unknown[] }).has?.length ?? 0) > 0
      ) {
        const hasConditions = (route as { has?: MiddlewareMatcherCondition[] })
          .has!;
        const hasMatched = hasConditions.every((condition) =>
          matcherConditionSatisfied(condition, requestUrl, requestHeaders)
        );
        if (!hasMatched) {
          continue;
        }
      }
      if (
        Array.isArray((route as { missing?: unknown[] }).missing) &&
        ((route as { missing?: unknown[] }).missing?.length ?? 0) > 0
      ) {
        const missingConditions = (
          route as { missing?: MiddlewareMatcherCondition[] }
        ).missing!;
        const hasMissing = missingConditions.some((condition) =>
          matcherConditionSatisfied(condition, requestUrl, requestHeaders)
        );
        if (hasMissing) {
          continue;
        }
      }

      let routePattern: RegExp;
      try {
        routePattern = new RegExp(route.sourceRegex);
      } catch {
        continue;
      }

      const match = requestUrl.pathname.match(routePattern);
      if (!match) {
        continue;
      }

      let destination = route.destination;
      for (let index = 1; index < match.length; index++) {
        const value = match[index];
        if (value === undefined) {
          continue;
        }
        destination = destination.replace(new RegExp(`\\$${index}`, 'g'), value);
      }
      const groups =
        (match as RegExpMatchArray & { groups?: Record<string, string> }).groups ??
        undefined;
      if (groups) {
        for (const [key, value] of Object.entries(groups)) {
          destination = destination.replace(new RegExp(`\\$${key}`, 'g'), value);
        }
      }

      const destinationUrl = new URL(destination, requestUrl);
      for (const [key, value] of destinationUrl.searchParams.entries()) {
        const existing = query[key];
        if (existing === undefined) {
          query[key] = value;
        } else if (Array.isArray(existing)) {
          query[key] = [...existing, value];
        } else {
          query[key] = [existing, value];
        }
      }

      break;
    }
  }

  return query;
}

function extractRouteGraphDestinationPathname({
  requestUrl,
  requestHeaders,
  routeGraph,
  routeOutputsByPathname,
  staticAssetsByPathname,
  prerenderArtifactsByPathname,
  basePath,
}: {
  requestUrl: URL;
  requestHeaders: Headers;
  routeGraph: BunDeploymentManifest['routeGraph'];
  routeOutputsByPathname: Map<string, BunRouteArtifact>;
  staticAssetsByPathname: Map<string, BunDeploymentManifest['staticAssets'][number]>;
  prerenderArtifactsByPathname: Map<string, BunPrerenderArtifact>;
  basePath: string;
}): string | null {
  const hasOutputPathname = (candidatePathname: string): boolean =>
    routeOutputsByPathname.has(candidatePathname) ||
    staticAssetsByPathname.has(candidatePathname) ||
    prerenderArtifactsByPathname.has(candidatePathname);
  const routeGroups = [
    routeGraph.beforeFiles,
    routeGraph.afterFiles,
    routeGraph.fallback,
  ];

  for (const routes of routeGroups) {
    for (const route of routes) {
      if (
        !route.destination ||
        route.destination.length === 0 ||
        route.status ||
        route.destination.startsWith('http://') ||
        route.destination.startsWith('https://')
      ) {
        continue;
      }
      if (
        Array.isArray((route as { has?: unknown[] }).has) &&
        ((route as { has?: unknown[] }).has?.length ?? 0) > 0
      ) {
        const hasConditions = (route as { has?: MiddlewareMatcherCondition[] })
          .has!;
        const hasMatched = hasConditions.every((condition) =>
          matcherConditionSatisfied(condition, requestUrl, requestHeaders)
        );
        if (!hasMatched) {
          continue;
        }
      }
      if (
        Array.isArray((route as { missing?: unknown[] }).missing) &&
        ((route as { missing?: unknown[] }).missing?.length ?? 0) > 0
      ) {
        const missingConditions = (
          route as { missing?: MiddlewareMatcherCondition[] }
        ).missing!;
        const hasMissing = missingConditions.some((condition) =>
          matcherConditionSatisfied(condition, requestUrl, requestHeaders)
        );
        if (hasMissing) {
          continue;
        }
      }

      let routePattern: RegExp;
      try {
        routePattern = new RegExp(route.sourceRegex);
      } catch {
        continue;
      }

      const match = requestUrl.pathname.match(routePattern);
      if (!match) {
        continue;
      }

      let destination = route.destination;
      for (let index = 1; index < match.length; index++) {
        const value = match[index];
        if (value === undefined) {
          continue;
        }
        destination = destination.replace(new RegExp(`\\$${index}`, 'g'), value);
      }
      const groups =
        (match as RegExpMatchArray & { groups?: Record<string, string> }).groups ??
        undefined;
      if (groups) {
        for (const [key, value] of Object.entries(groups)) {
          destination = destination.replace(new RegExp(`\\$${key}`, 'g'), value);
        }
      }

      const destinationUrl = new URL(destination, requestUrl);
      const lookupCandidates = getLookupPathnameCandidates(
        destinationUrl.pathname,
        basePath
      );
      for (const candidate of lookupCandidates) {
        if (hasOutputPathname(candidate)) {
          return candidate;
        }
      }
    }
  }

  return null;
}

function toStringArray(value: unknown): string[] {
  if (typeof value === 'string') {
    return [value];
  }
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === 'string');
  }
  return [];
}

function extractResolutionQuery(resolution: ResolveRoutesResult): QueryObject {
  const query: QueryObject = {};
  const record = resolution as unknown as JsonRecord;

  const candidates = [record.query, record.resolvedQuery];
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
      continue;
    }
    for (const [key, value] of Object.entries(candidate)) {
      const values = toStringArray(value);
      if (values.length === 0) {
        continue;
      }
      const existing = query[key];
      if (existing === undefined) {
        query[key] = values.length === 1 ? values[0]! : values;
        continue;
      }
      const merged = Array.isArray(existing) ? [...existing, ...values] : [existing, ...values];
      query[key] = merged;
    }
  }

  return query;
}

function resolveResolutionPathname(
  resolution: ResolveRoutesResult
): string | null {
  const record = resolution as unknown as JsonRecord;
  const resolvedPathname = record.resolvedPathname;
  if (typeof resolvedPathname === 'string' && resolvedPathname.length > 0) {
    return resolvedPathname;
  }

  return typeof resolution.matchedPathname === 'string' &&
    resolution.matchedPathname.length > 0
    ? resolution.matchedPathname
    : null;
}

function resolveConcretePathnameFromRouteMatches(
  pathnameTemplate: string | null,
  routeMatches?: Record<string, string> | null
): string | null {
  if (
    typeof pathnameTemplate !== 'string' ||
    pathnameTemplate.length === 0 ||
    !pathnameTemplate.includes('[')
  ) {
    return null;
  }
  const normalizedParams = normalizeRouteParams(
    pathnameTemplate,
    routeMatches ?? undefined
  );
  if (!normalizedParams) {
    return null;
  }

  const templateSegments = pathnameTemplate.split('/').filter(Boolean);
  const concreteSegments: string[] = [];

  for (const templateSegment of templateSegments) {
    if (
      templateSegment.startsWith('[[...') &&
      templateSegment.endsWith(']]')
    ) {
      const key = templateSegment.slice('[[...'.length, -']]'.length);
      const value = normalizedParams[key];
      if (Array.isArray(value)) {
        concreteSegments.push(...value);
      } else if (typeof value === 'string' && value.length > 0) {
        concreteSegments.push(value);
      }
      continue;
    }

    if (templateSegment.startsWith('[...') && templateSegment.endsWith(']')) {
      const key = templateSegment.slice('[...'.length, -']'.length);
      const value = normalizedParams[key];
      if (Array.isArray(value) && value.length > 0) {
        concreteSegments.push(...value);
      } else if (typeof value === 'string' && value.length > 0) {
        concreteSegments.push(value);
      } else {
        return null;
      }
      continue;
    }

    if (templateSegment.startsWith('[') && templateSegment.endsWith(']')) {
      const key = templateSegment.slice(1, -1);
      const value = normalizedParams[key];
      if (typeof value !== 'string' || value.length === 0) {
        return null;
      }
      concreteSegments.push(value);
      continue;
    }

    concreteSegments.push(templateSegment);
  }

  return `/${concreteSegments.join('/')}`;
}

function resolveInvocationPathname({
  requestPathname,
  matchedPathname,
  resolvedPathname,
}: {
  requestPathname: string;
  matchedPathname: string | null;
  resolvedPathname: string | null;
}): string {
  const candidate = resolvedPathname ?? matchedPathname;
  if (!candidate || candidate.length === 0) {
    return requestPathname;
  }

  // Internal Next.js dynamic segment syntax should not be used as the
  // invocation pathname.
  if (candidate.includes('[') || hasInterceptionMarker(candidate)) {
    return requestPathname;
  }

  if (candidate === '/index' && requestPathname === '/') {
    return '/';
  }

  return candidate;
}

function hasInterceptionMarker(pathname: string): boolean {
  return (
    pathname.includes('/(.)') ||
    pathname.includes('/(..)') ||
    pathname.includes('/(...)')
  );
}

function normalizeRouteParams(
  pathnameTemplate: string,
  routeMatches?: Record<string, string>
): Record<string, string | string[]> | undefined {
  if (!routeMatches) {
    return undefined;
  }

  const normalized: Record<string, string | string[]> = {};
  const namedEntries = Object.entries(routeMatches).filter(
    ([key, value]) => !/^\d+$/.test(key) && typeof value === 'string'
  );
  if (namedEntries.length === 0) {
    return undefined;
  }

  for (const [rawKey, value] of namedEntries) {
    const key = normalizeRouteMatchKey(rawKey);
    const normalizedValue = normalizeRouteMatchValue(value);
    const catchAllPattern = `[...${key}]`;
    const optionalCatchAllPattern = `[[...${key}]]`;
    const segmentPattern = `[${key}]`;
    if (
      pathnameTemplate.includes(optionalCatchAllPattern) ||
      pathnameTemplate.includes(catchAllPattern)
    ) {
      normalized[key] =
        normalizedValue.length > 0 ? normalizedValue.split('/') : [];
    } else if (pathnameTemplate.includes(segmentPattern)) {
      normalized[key] = normalizedValue;
    }
  }

  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

function normalizeRouteMatchKey(rawKey: string): string {
  if (rawKey.startsWith('nxtP') || rawKey.startsWith('nxtI')) {
    return rawKey.slice(4);
  }
  return rawKey;
}

function normalizeRouteMatchValue(rawValue: string): string {
  let value = rawValue;
  while (/^\((?:\.\.\.|\.\.|\.)\)/.test(value)) {
    value = value.replace(/^\((?:\.\.\.|\.\.|\.)\)/, '');
  }
  return value;
}

function normalizeResolutionRouteMatches(
  routeMatches?: Record<string, string> | null
): Record<string, string> | null {
  if (!routeMatches) {
    return null;
  }

  const normalized: Record<string, string> = {};
  for (const [rawKey, value] of Object.entries(routeMatches)) {
    if (typeof value !== 'string' || /^\d+$/.test(rawKey)) {
      continue;
    }
    const key = normalizeRouteMatchKey(rawKey);
    normalized[key] = normalizeRouteMatchValue(value);
  }

  return Object.keys(normalized).length > 0 ? normalized : null;
}

function routeMatchesToQueryObject(
  routeMatches?: Record<string, string> | null
): QueryObject {
  const query: QueryObject = {};
  if (!routeMatches) {
    return query;
  }

  for (const [rawKey, value] of Object.entries(routeMatches)) {
    if (typeof value !== 'string' || /^\d+$/.test(rawKey)) {
      continue;
    }
    const normalizedValue = normalizeRouteMatchValue(value);
    query[rawKey] = normalizedValue;
    const normalizedKey = normalizeRouteMatchKey(rawKey);
    if (!Object.prototype.hasOwnProperty.call(query, normalizedKey)) {
      query[normalizedKey] = normalizedValue;
    }
  }

  return query;
}

function routeParamsToQueryObject(
  params?: Record<string, string | string[]>
): QueryObject {
  const query: QueryObject = {};
  if (!params) {
    return query;
  }

  const decodeParamValue = (value: string): string => {
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  };

  for (const [key, value] of Object.entries(params)) {
    query[key] = Array.isArray(value)
      ? value.map((entry) => decodeParamValue(entry))
      : decodeParamValue(value);
  }
  return query;
}

function computeDjb2Hash(input: string): number {
  let hash = 5381;
  for (let i = 0; i < input.length; i++) {
    hash = ((hash << 5) + hash + input.charCodeAt(i)) & 0xffffffff;
  }
  return hash >>> 0;
}

function computeHexHash(input: string): string {
  return computeDjb2Hash(input).toString(36).slice(0, 5);
}

function computeCacheBustingSearchParam(
  prefetchHeader: '1' | '2' | undefined,
  segmentPrefetchHeader: string | undefined,
  stateTreeHeader: string | undefined,
  nextUrlHeader: string | undefined
): string {
  if (
    prefetchHeader === undefined &&
    segmentPrefetchHeader === undefined &&
    stateTreeHeader === undefined &&
    nextUrlHeader === undefined
  ) {
    return '';
  }

  return computeHexHash(
    [
      prefetchHeader ?? '0',
      segmentPrefetchHeader ?? '0',
      stateTreeHeader ?? '0',
      nextUrlHeader ?? '0',
    ].join(',')
  );
}

function setCacheBustingSearchParamWithHash(url: URL, hash: string): void {
  const rawQuery = url.search.startsWith('?')
    ? url.search.slice(1)
    : url.search;

  const pairs = rawQuery
    .split('&')
    .filter(
      (pair) => pair.length > 0 && !pair.startsWith(`${NEXT_RSC_UNION_QUERY}=`)
    );

  if (hash.length > 0) {
    pairs.push(`${NEXT_RSC_UNION_QUERY}=${hash}`);
  } else {
    pairs.push(NEXT_RSC_UNION_QUERY);
  }

  url.search = pairs.length > 0 ? `?${pairs.join('&')}` : '';
}

function resolveRscValidationRedirectLocation({
  request,
  routeGraph,
  validateRSCRequestHeaders,
}: {
  request: Request;
  routeGraph: BunDeploymentManifest['routeGraph'];
  validateRSCRequestHeaders: boolean;
}): string | null {
  if (!validateRSCRequestHeaders) {
    return null;
  }

  if (request.headers.get(routeGraph.rsc.header) !== '1') {
    return null;
  }

  const requestUrl = new URL(request.url);
  if (requestUrl.pathname === '/404') {
    return null;
  }

  const prefetchHeaderValue = request.headers.get(routeGraph.rsc.prefetchHeader);
  const prefetchHeader =
    prefetchHeaderValue === '1' || prefetchHeaderValue === '2'
      ? prefetchHeaderValue
      : undefined;
  const segmentPrefetchHeader =
    request.headers.get(routeGraph.rsc.prefetchSegmentHeader) ?? undefined;
  const stateTreeHeader =
    request.headers.get(NEXT_ROUTER_STATE_TREE_HEADER) ?? undefined;
  const nextUrlHeader = request.headers.get(NEXT_URL_HEADER) ?? undefined;
  const expectedHash = computeCacheBustingSearchParam(
    prefetchHeader,
    segmentPrefetchHeader,
    stateTreeHeader,
    nextUrlHeader
  );
  const actualHash = requestUrl.searchParams.get(NEXT_RSC_UNION_QUERY);

  if (expectedHash === actualHash) {
    return null;
  }

  setCacheBustingSearchParamWithHash(requestUrl, expectedHash);
  return `${requestUrl.pathname}${requestUrl.search}`;
}

function resolutionRouteMatchesFromMeta(
  requestMeta?: JsonRecord
): Record<string, string> | undefined {
  if (!requestMeta) {
    return undefined;
  }
  const candidate = requestMeta.routeMatches;
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
    return undefined;
  }

  const routeMatches: Record<string, string> = {};
  for (const [key, value] of Object.entries(candidate)) {
    if (typeof value === 'string') {
      routeMatches[key] = value;
    }
  }
  return Object.keys(routeMatches).length > 0 ? routeMatches : undefined;
}

function extractRouteParamsFromPathname(
  pathnameTemplate: string,
  concretePathname: string
): Record<string, string | string[]> | undefined {
  const decodeParamSegment = (value: string): string => {
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  };
  const normalizeTemplateSegment = (segment: string): string => {
    const withoutInterceptionMarker = normalizeRouteMatchValue(segment);
    return withoutInterceptionMarker.endsWith('.rsc')
      ? withoutInterceptionMarker.slice(0, -'.rsc'.length)
      : withoutInterceptionMarker;
  };
  const templateSegments = pathnameTemplate.split('/').filter(Boolean);
  const concreteSegments = concretePathname.split('/').filter(Boolean);
  const params: Record<string, string | string[]> = {};
  let concreteIndex = 0;

  for (
    let templateIndex = 0;
    templateIndex < templateSegments.length;
    templateIndex++
  ) {
    const templateSegment = templateSegments[templateIndex];
    if (templateSegment === undefined) {
      return undefined;
    }
    const normalizedTemplateSegment = normalizeTemplateSegment(templateSegment);
    const concreteSegment = concreteSegments[concreteIndex];

    if (
      normalizedTemplateSegment.startsWith('[[...') &&
      normalizedTemplateSegment.endsWith(']]')
    ) {
      const key = normalizedTemplateSegment.slice('[[...'.length, -']]'.length);
      params[key] = concreteSegments
        .slice(concreteIndex)
        .map((segment) => decodeParamSegment(segment));
      concreteIndex = concreteSegments.length;
      break;
    }

    if (
      normalizedTemplateSegment.startsWith('[...') &&
      normalizedTemplateSegment.endsWith(']')
    ) {
      const key = normalizedTemplateSegment.slice('[...'.length, -']'.length);
      if (concreteIndex >= concreteSegments.length) {
        return undefined;
      }
      params[key] = concreteSegments
        .slice(concreteIndex)
        .map((segment) => decodeParamSegment(segment));
      concreteIndex = concreteSegments.length;
      break;
    }

    if (
      normalizedTemplateSegment.startsWith('[') &&
      normalizedTemplateSegment.endsWith(']')
    ) {
      if (concreteSegment === undefined) {
        return undefined;
      }
      const key = normalizedTemplateSegment.slice(1, -1);
      params[key] = decodeParamSegment(concreteSegment);
      concreteIndex += 1;
      continue;
    }

    if (normalizedTemplateSegment !== concreteSegment) {
      return undefined;
    }
    concreteIndex += 1;
  }

  if (concreteIndex !== concreteSegments.length) {
    return undefined;
  }

  return Object.keys(params).length > 0 ? params : undefined;
}

function mergeRouteParams(
  pathnameParams?: Record<string, string | string[]>,
  routeMatchParams?: Record<string, string | string[]>
): Record<string, string | string[]> | undefined {
  if (!pathnameParams) {
    return routeMatchParams;
  }
  if (!routeMatchParams) {
    return pathnameParams;
  }
  return {
    ...pathnameParams,
    ...routeMatchParams,
  };
}

function getSingleHeaderValue(
  value: string | string[] | undefined
): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function shouldSendRequestBody(method: string): boolean {
  return method !== 'GET' && method !== 'HEAD';
}

function getRequestUserAgent(request: Request): string {
  const userAgent = request.headers.get('user-agent');
  return typeof userAgent === 'string' ? userAgent : '';
}

function shouldForceConnectionClose(request: Request): boolean {
  const userAgent = getRequestUserAgent(request).toLowerCase();
  return (
    userAgent.includes('node-fetch') ||
    userAgent.includes('googlebot') ||
    userAgent.includes('google-pagerenderer')
  );
}

function shouldBufferEdgeResponseForCrawler(request: Request): boolean {
  const userAgent = getRequestUserAgent(request).toLowerCase();
  return (
    userAgent.includes('googlebot') ||
    userAgent.includes('google-pagerenderer')
  );
}

function isDocumentNavigationRequest(request: Request): boolean {
  if (request.headers.get('upgrade-insecure-requests') === '1') {
    return true;
  }
  if (
    request.headers.get('sec-fetch-mode') === 'navigate' ||
    request.headers.get('sec-fetch-dest') === 'document'
  ) {
    return true;
  }
  const accept = request.headers.get('accept')?.toLowerCase() ?? '';
  return accept.includes('text/html');
}

function getForwardedPort(url: URL): string {
  if (url.port) {
    return url.port;
  }
  return url.protocol === 'https:' ? '443' : '80';
}

function buildProxyHeaders({
  request,
  server,
  sourceHeaders,
  upstreamUrl,
  preserveHost,
}: {
  request: Request;
  server: Bun.Server<unknown>;
  sourceHeaders: Headers;
  upstreamUrl: URL;
  preserveHost: boolean;
}): Headers {
  const headers = new Headers(sourceHeaders);
  const requestUrl = new URL(request.url);

  headers.set('host', preserveHost ? requestUrl.host : upstreamUrl.host);
  headers.set('x-forwarded-host', requestUrl.host);
  headers.set('x-forwarded-proto', requestUrl.protocol.slice(0, -1));
  headers.set('x-forwarded-port', getForwardedPort(requestUrl));
  headers.set('accept-encoding', 'identity');

  if (!headers.has('x-forwarded-for')) {
    const requestIp = server.requestIP(request);
    if (requestIp?.address) {
      headers.set('x-forwarded-for', requestIp.address);
    }
  }

  return headers;
}

function normalizeNextJsRedirectHeaderValue(value: string): string {
  const toPageRedirect = ({
    pathname,
    search,
  }: {
    pathname: string;
    search: string;
  }): string | null => {
    const match = pathname.match(/^\/_next\/data\/[^/]+\/(.+)\.json$/);
    if (!match) {
      return null;
    }

    let pagePathname = `/${match[1]}`;
    if (pagePathname === '/index') {
      pagePathname = '/';
    } else if (pagePathname.endsWith('/index')) {
      pagePathname = pagePathname.slice(0, -'/index'.length) || '/';
    }

    return `${pagePathname}${search}`;
  };

  if (value.startsWith('/')) {
    const relativeUrl = new URL(value, 'http://adapter-bun.local');
    return (
      toPageRedirect({
        pathname: relativeUrl.pathname,
        search: relativeUrl.search,
      }) ?? value
    );
  }

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return value;
  }

  const normalizedPath = toPageRedirect({
    pathname: parsed.pathname,
    search: parsed.search,
  });
  if (!normalizedPath) {
    return value;
  }

  return `${parsed.origin}${normalizedPath}`;
}

function sanitizeProxyResponse(response: Response, request: Request): Response {
  const headers = new Headers(response.headers);
  headers.delete('connection');
  headers.delete('keep-alive');
  headers.delete('transfer-encoding');
  headers.delete('x-next-cache-tags');
  if (headers.get('x-nextjs-prerender') === '1') {
    const nextJsCache = headers.get('x-nextjs-cache');
    if (nextJsCache === null || nextJsCache === 'MISS') {
      headers.set('x-nextjs-cache', 'HIT');
    }
  }
  const nextJsRedirect = headers.get('x-nextjs-redirect');
  if (nextJsRedirect) {
    headers.set(
      'x-nextjs-redirect',
      normalizeNextJsRedirectHeaderValue(nextJsRedirect)
    );
  }

  if (shouldForceConnectionClose(request)) {
    headers.set('connection', 'close');
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function normalizeEdgeResponseEncoding(response: Response): Response {
  if (!response.headers.has('content-encoding')) {
    return response;
  }

  const normalizedHeaders = new Headers(response.headers);
  normalizedHeaders.delete('content-encoding');
  normalizedHeaders.delete('content-length');
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: normalizedHeaders,
  });
}

function buildStaticAssetHeaders(
  file: Bun.BunFile,
  asset: BunDeploymentManifest['staticAssets'][number]
): Headers {
  const headers = new Headers(asset.headers);
  if (asset.cacheControl) {
    headers.set('cache-control', asset.cacheControl);
  } else if (shouldUseDefaultAppMetadataCacheControl(asset)) {
    headers.set('cache-control', 'public, max-age=0, must-revalidate');
  }
  const contentType = asset.contentType || file.type;
  if (contentType) {
    headers.set('content-type', contentType);
  }
  if (typeof file.size === 'number' && Number.isFinite(file.size) && file.size >= 0) {
    headers.set('content-length', String(file.size));
  }
  return headers;
}

function shouldUseDefaultAppMetadataCacheControl(
  asset: BunDeploymentManifest['staticAssets'][number]
): boolean {
  if (asset.sourceType !== 'next-static') {
    return false;
  }
  const normalizedSourcePath = asset.sourcePath.replaceAll('\\', '/');
  return (
    normalizedSourcePath.includes('/.next/server/app/') &&
    normalizedSourcePath.endsWith('.body')
  );
}

function serveStaticAsset(
  request: Request,
  adapterDir: string,
  asset: BunDeploymentManifest['staticAssets'][number],
  routeGraph: BunDeploymentManifest['routeGraph']
): Response {
  const file = Bun.file(path.join(adapterDir, asset.stagedPath));
  const headers = buildStaticAssetHeaders(file, asset);
  const isRscFallbackStaticAsset =
    asset.sourceType === 'next-static' &&
    asset.sourcePath.endsWith('rsc-fallback.json');

  if (isRscStaticAssetPath(asset.pathname, routeGraph) && !isRscFallbackStaticAsset) {
    headers.set('content-type', 'text/x-component');
  }
  if (request.headers.get(routeGraph.rsc.header) === '1') {
    headers.set('vary', routeGraph.rsc.varyHeader);
  }

  if (shouldForceConnectionClose(request)) {
    headers.set('connection', 'close');
  }

  if (request.method === 'HEAD') {
    return new Response(null, {
      status: asset.status,
      headers,
    });
  }

  return new Response(file, {
    status: asset.status,
    headers,
  });
}

function encodeRouteInvocationMeta(meta: RouteInvocationMeta): string {
  return Buffer.from(JSON.stringify(meta), 'utf8').toString('base64url');
}

function sanitizeIncomingRequestHeaders(headers: Headers): Headers {
  const sanitized = new Headers(headers);
  sanitized.delete('x-middleware-set-cookie');
  return sanitized;
}

function decodeRouteInvocationMeta(value: string | undefined): RouteInvocationMeta | undefined {
  if (!value) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(
      Buffer.from(value, 'base64url').toString('utf8')
    );
    if (!parsed || typeof parsed !== 'object') {
      return undefined;
    }
    return parsed as RouteInvocationMeta;
  } catch {
    return undefined;
  }
}

function toResponseHeaders(headers: http.IncomingHttpHeaders): Headers {
  const normalized = new Headers();
  for (const [key, value] of Object.entries(headers)) {
    if (typeof value === 'undefined') {
      continue;
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        normalized.append(key, item);
      }
      continue;
    }
    normalized.set(key, value);
  }
  return normalized;
}

async function writeResponseToNode(
  destination: http.ServerResponse,
  response: Response
): Promise<void> {
  destination.statusCode = response.status;

  const groupedHeaders = new Map<string, string[]>();
  for (const [key, value] of response.headers.entries()) {
    const current = groupedHeaders.get(key) ?? [];
    current.push(value);
    groupedHeaders.set(key, current);
  }

  for (const [key, values] of groupedHeaders.entries()) {
    if (key.toLowerCase() === 'set-cookie') {
      destination.setHeader(key, values);
      continue;
    }
    destination.setHeader(key, values.join(', '));
  }

  if (!response.body) {
    destination.end();
    return;
  }

  const reader = response.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (!value || value.byteLength === 0) {
        continue;
      }
      const shouldContinue = destination.write(Buffer.from(value));
      if (!shouldContinue) {
        await once(destination, 'drain');
      }
    }
    destination.end();
  } finally {
    reader.releaseLock();
  }
}

function toResponseFromLambdaLike(result: {
  statusCode?: number;
  headers?: Record<string, string | number | undefined>;
  body?: string | null;
  isBase64Encoded?: boolean;
}): Response {
  const headers = new Headers();
  for (const [key, value] of Object.entries(result.headers ?? {})) {
    if (value === undefined) continue;
    headers.set(key, String(value));
  }

  const body =
    typeof result.body === 'string'
      ? result.isBase64Encoded
        ? Buffer.from(result.body, 'base64')
        : result.body
      : null;

  return new Response(body, {
    status: result.statusCode ?? 200,
    headers,
  });
}

function responseInputToString(input: unknown): string {
  if (typeof input === 'string') {
    return input;
  }

  if (input && typeof input === 'object' && 'url' in input) {
    const withUrl = input as { url?: unknown };
    if (typeof withUrl.url === 'string') {
      return withUrl.url;
    }
  }

  return String(input);
}

async function maybeReadInlineAssetResponse({
  input,
  assetsByName,
  context,
}: {
  input: unknown;
  assetsByName: Map<string, string>;
  context: EdgeRuntimeInstance['context'];
}): Promise<Response | undefined> {
  const inputString = responseInputToString(input);
  if (!inputString.startsWith('blob:')) {
    return undefined;
  }

  const name = inputString.slice('blob:'.length);
  const assetPath =
    assetsByName.get(name) ??
    assetsByName.get(decodeURIComponent(name)) ??
    assetsByName.get(name.replace(/^\/+/, ''));
  if (!assetPath || !existsSync(assetPath)) {
    return undefined;
  }

  const content = await readFile(assetPath);
  return new context.Response(content);
}

function isEdgeFetchEventResultLike(value: unknown): value is EdgeFetchEventResultLike {
  return Boolean(
    value &&
      typeof value === 'object' &&
      'response' in value &&
      (value as { response?: unknown }).response
  );
}

function isEdgeResponseLike(value: unknown): value is EdgeResponseLike {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const candidate = value as Partial<EdgeResponseLike>;
  return (
    typeof candidate.status === 'number' &&
    typeof candidate.arrayBuffer === 'function' &&
    candidate.headers !== undefined
  );
}

function isLambdaLikeResponse(value: unknown): value is {
  statusCode?: number;
  headers?: Record<string, string | number | undefined>;
  body?: string | null;
  isBase64Encoded?: boolean;
} {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const candidate = value as {
    statusCode?: number;
    body?: string | null;
  };
  return (
    typeof candidate.statusCode === 'number' ||
    typeof candidate.body === 'string'
  );
}

async function toHostResponse(response: Response | EdgeResponseLike): Promise<Response> {
  if (response instanceof Response) {
    return response;
  }

  return new Response(Buffer.from(await response.arrayBuffer()), {
    status: response.status,
    statusText: response.statusText,
    headers: new Headers(response.headers as Headers),
  });
}

async function toResponse(value: unknown): Promise<Response> {
  if (isEdgeFetchEventResultLike(value)) {
    return toResponse(value.response);
  }

  if (value instanceof Response) {
    return value;
  }

  if (isEdgeResponseLike(value)) {
    return toHostResponse(value);
  }

  if (isLambdaLikeResponse(value)) {
    return toResponseFromLambdaLike(value);
  }

  return new Response(null, { status: 204 });
}

function toRequestHeadersRecord(headers: Headers): Record<string, string> {
  const record: Record<string, string> = {};
  for (const [key, value] of headers.entries()) {
    record[key] = value;
  }
  return record;
}

function buildEdgeProcessEnv(injected: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === 'string') {
      env[key] = value;
    }
  }
  for (const [key, value] of Object.entries(injected)) {
    env[key] = value;
  }
  env.NEXT_RUNTIME = 'edge';
  return env;
}

function installEdgeCacheHandlers(context: EdgeRuntimeInstance['context']): void {
  const cacheHandlersSymbol = Symbol.for('@next/cache-handlers');
  const contextRecord = context as unknown as Record<string | symbol, unknown>;
  const existing = contextRecord[cacheHandlersSymbol];

  if (!existing || typeof existing !== 'object') {
    contextRecord[cacheHandlersSymbol] = {
      FetchCache: BunSqliteIncrementalCacheHandler,
      DefaultCache: edgeUseCacheHandler,
      RemoteCache: edgeUseCacheHandler,
    } as EdgeGlobalCacheHandlers;
    return;
  }

  const handlers = existing as EdgeGlobalCacheHandlers;
  if (typeof handlers.FetchCache !== 'function') {
    handlers.FetchCache = BunSqliteIncrementalCacheHandler;
  }
  if (!handlers.DefaultCache) {
    handlers.DefaultCache = edgeUseCacheHandler;
  }
  if (!handlers.RemoteCache) {
    handlers.RemoteCache = edgeUseCacheHandler;
  }
}

function normalizeEdgeEnv(
  value: BunRouteArtifact['env'] | BunMiddlewareArtifact['env']
): Record<string, string> {
  if (!value) {
    return {};
  }
  const env: Record<string, string> = {};
  for (const [key, current] of Object.entries(value)) {
    env[key] = String(current);
  }
  return env;
}

function resolveEdgeEntryHandlerExport(
  executor: EdgeRuntimeExecutor
): EdgeRouteHandler {
  const entriesValue = (executor.runtime.context as Record<string, unknown>)._ENTRIES;
  if (!entriesValue || typeof entriesValue !== 'object') {
    throw new Error(
      `[adapter-bun] edge output "${executor.sourcePage}" did not register global _ENTRIES`
    );
  }

  const entries = entriesValue as Record<string, EdgeEntryModule>;
  const entry = entries[executor.entryKey];
  if (!entry) {
    throw new Error(
      `[adapter-bun] edge output "${executor.sourcePage}" is missing entry "${executor.entryKey}"`
    );
  }

  const entryRecord = entry as unknown as Record<string, unknown>;
  if (typeof entryRecord.handler === 'function') {
    return entryRecord.handler as EdgeRouteHandler;
  }

  throw new Error(
    `[adapter-bun] edge entry "${executor.entryKey}" does not expose a handler export`
  );
}

async function invokeEdgeEntryHandler({
  executor,
  request,
  waitUntil,
  requestMeta,
}: {
  executor: EdgeRuntimeExecutor;
  request: Request;
  waitUntil?: (promise: Promise<void>) => void;
  requestMeta?: JsonRecord;
}): Promise<unknown> {
  const handler = resolveEdgeEntryHandlerExport(executor);
  return handler(request, {
    waitUntil,
    signal: request.signal,
    requestMeta: {
      initURL: request.url,
      ...(requestMeta ?? {}),
    },
  });
}

async function prepareActionRequestBodyForBun(
  req: http.IncomingMessage
): Promise<void> {
  if (req.method !== 'POST') {
    return;
  }

  const actionId = getSingleHeaderValue(req.headers['next-action']);
  if (typeof actionId !== 'string' || actionId.length === 0) {
    return;
  }

  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    if (chunk === undefined || chunk === null) {
      continue;
    }
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  const requestBody = Buffer.concat(chunks);
  req.headers['content-length'] = String(requestBody.length);
  delete req.headers['transfer-encoding'];

  const replayStream = Readable.from(requestBody);
  const originalOn = req.on.bind(req);
  const originalOnce = req.once.bind(req);
  const originalRemoveListener = req.removeListener.bind(req);

  req.on = ((
    event: string | symbol,
    listener: (...args: unknown[]) => void
  ) => {
    if (
      event === 'data' ||
      event === 'end' ||
      event === 'error' ||
      event === 'readable'
    ) {
      replayStream.on(event, listener);
      return req;
    }
    return originalOn(event, listener);
  }) as typeof req.on;

  req.once = ((
    event: string | symbol,
    listener: (...args: unknown[]) => void
  ) => {
    if (
      event === 'data' ||
      event === 'end' ||
      event === 'error' ||
      event === 'readable'
    ) {
      replayStream.once(event, listener);
      return req;
    }
    return originalOnce(event, listener);
  }) as typeof req.once;

  req.removeListener = ((
    event: string | symbol,
    listener: (...args: unknown[]) => void
  ) => {
    if (
      event === 'data' ||
      event === 'end' ||
      event === 'error' ||
      event === 'readable'
    ) {
      replayStream.removeListener(event, listener);
      return req;
    }
    return originalRemoveListener(event, listener);
  }) as typeof req.removeListener;

  req.pipe = replayStream.pipe.bind(replayStream) as unknown as typeof req.pipe;
  req.read = replayStream.read.bind(replayStream) as unknown as typeof req.read;
  req.pause = replayStream.pause.bind(replayStream) as unknown as typeof req.pause;
  req.resume = replayStream.resume.bind(replayStream) as unknown as typeof req.resume;
  req.setEncoding = replayStream.setEncoding.bind(
    replayStream
  ) as unknown as typeof req.setEncoding;
  req.unshift = replayStream.unshift.bind(
    replayStream
  ) as unknown as typeof req.unshift;
  req[Symbol.asyncIterator] = replayStream[Symbol.asyncIterator].bind(
    replayStream
  ) as unknown as typeof req[typeof Symbol.asyncIterator];
}

function getHeaderValue(
  headers: http.OutgoingHttpHeaders | http.IncomingHttpHeaders | undefined,
  name: string
): string | string[] | number | undefined {
  if (!headers || typeof headers !== 'object') {
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
  req: http.IncomingMessage,
  value: string | number | string[] | undefined,
  nextCacheHeaderValue: string | string[] | number | undefined
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

function patchCacheControlHeader(
  req: http.IncomingMessage,
  res: http.ServerResponse
): void {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return;
  }

  const originalSetHeader = res.setHeader.bind(res);
  res.setHeader = ((name, value) => {
    if (typeof name === 'string' && name.toLowerCase() === 'cache-control') {
      return originalSetHeader(
        name,
        normalizeCacheControlHeader(
          req,
          value as string | number | string[] | undefined,
          res.getHeader('x-nextjs-cache')
        )
      );
    }
    return originalSetHeader(name, value);
  }) as typeof res.setHeader;

  const originalWriteHead = res.writeHead.bind(res);
  res.writeHead = ((statusCode, statusMessage, headers) => {
    let resolvedStatusMessage = statusMessage;
    let resolvedHeaders = headers;

    if (
      resolvedHeaders === undefined &&
      resolvedStatusMessage &&
      typeof resolvedStatusMessage === 'object' &&
      !Array.isArray(resolvedStatusMessage)
    ) {
      resolvedHeaders = resolvedStatusMessage as http.OutgoingHttpHeaders;
      resolvedStatusMessage = undefined;
    }

    if (
      resolvedHeaders &&
      typeof resolvedHeaders === 'object' &&
      !Array.isArray(resolvedHeaders)
    ) {
      const nextCacheHeaderValue =
        getHeaderValue(resolvedHeaders, 'x-nextjs-cache') ??
        res.getHeader('x-nextjs-cache');

      for (const key of Object.keys(resolvedHeaders)) {
        if (key.toLowerCase() !== 'cache-control') {
          continue;
        }
        const currentValue = resolvedHeaders[key];
        resolvedHeaders[key] = normalizeCacheControlHeader(
          req,
          currentValue as string | number | string[] | undefined,
          nextCacheHeaderValue
        );
      }
    }

    if (resolvedStatusMessage === undefined) {
      return originalWriteHead(statusCode, resolvedHeaders);
    }
    return originalWriteHead(statusCode, resolvedStatusMessage, resolvedHeaders);
  }) as typeof res.writeHead;
}

function patchApiResponseDefaultContentType(res: http.ServerResponse): void {
  if ((res as http.ServerResponse & { __adapterApiContentTypePatched?: boolean }).__adapterApiContentTypePatched) {
    return;
  }
  (
    res as http.ServerResponse & { __adapterApiContentTypePatched?: boolean }
  ).__adapterApiContentTypePatched = true;

  const originalEnd = res.end.bind(res);
  res.end = ((chunk?: unknown, encoding?: unknown, cb?: unknown) => {
    if (!res.headersSent && !res.hasHeader('content-type')) {
      res.setHeader('content-type', 'text/plain; charset=utf-8');
    }
    return originalEnd(
      chunk as Parameters<typeof originalEnd>[0],
      encoding as Parameters<typeof originalEnd>[1],
      cb as Parameters<typeof originalEnd>[2]
    );
  }) as typeof res.end;
}

async function loadRuntimeNextConfig(
  adapterDir: string,
  manifest: BunDeploymentManifest,
  runtimeNextConfigFile = 'runtime-next-config.json'
): Promise<JsonRecord & { distDir: string }> {
  const runtimeNextConfigPath = path.join(adapterDir, runtimeNextConfigFile);
  let serializedConfig: JsonRecord = {};

  try {
    const loadedConfig = await Bun.file(runtimeNextConfigPath).json();
    if (loadedConfig && typeof loadedConfig === 'object') {
      serializedConfig = loadedConfig as JsonRecord;
    }
  } catch (error) {
    console.warn('[adapter-bun] failed to load adapter runtime next config:', error);
  }

  const distDir =
    typeof serializedConfig.distDir === 'string' && serializedConfig.distDir.length > 0
      ? serializedConfig.distDir
      : typeof manifest.build.distDir === 'string' && manifest.build.distDir.length > 0
        ? manifest.build.distDir
        : '.next';

  return {
    ...serializedConfig,
    distDir,
  };
}

function isRequireEsmError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const message = error.message.toLowerCase();
  return (
    message.includes('err_require_esm') ||
    message.includes('must use import') ||
    message.includes('esm')
  );
}

async function loadOutputModule(
  projectRequire: NodeRequire,
  modulePath: string
): Promise<Record<string, unknown>> {
  try {
    const loaded = projectRequire(modulePath);
    if (loaded && typeof loaded === 'object') {
      return loaded as Record<string, unknown>;
    }
    return { default: loaded } as Record<string, unknown>;
  } catch (error) {
    if (!isRequireEsmError(error)) {
      throw error;
    }
    const imported = await import(pathToFileURL(modulePath).href);
    return imported as unknown as Record<string, unknown>;
  }
}

function resolveNodeHandlerExport(module: Record<string, unknown>): NodeRouteHandler {
  if (typeof module.handler === 'function') {
    return module.handler as NodeRouteHandler;
  }

  const defaultExport = module.default;
  if (defaultExport && typeof defaultExport === 'object') {
    const nested = defaultExport as Record<string, unknown>;
    if (typeof nested.handler === 'function') {
      return nested.handler as NodeRouteHandler;
    }
  }

  if (typeof defaultExport === 'function') {
    return defaultExport as NodeRouteHandler;
  }

  throw new Error(
    '[adapter-bun] output module does not export a node handler function'
  );
}

function resolveNodeMiddlewareHandlerExport(
  module: Record<string, unknown>
): EdgeRouteHandler {
  if (typeof module.handler === 'function') {
    return module.handler as EdgeRouteHandler;
  }
  if (typeof module.middleware === 'function') {
    return module.middleware as EdgeRouteHandler;
  }
  if (typeof module.proxy === 'function') {
    return module.proxy as EdgeRouteHandler;
  }

  const defaultExport = module.default;
  if (defaultExport && typeof defaultExport === 'object') {
    const nested = defaultExport as Record<string, unknown>;
    if (typeof nested.handler === 'function') {
      return nested.handler as EdgeRouteHandler;
    }
    if (typeof nested.middleware === 'function') {
      return nested.middleware as EdgeRouteHandler;
    }
    if (typeof nested.proxy === 'function') {
      return nested.proxy as EdgeRouteHandler;
    }
  }

  throw new Error(
    '[adapter-bun] middleware module does not export a supported handler function'
  );
}

function parseCookieHeader(headerValue: string | null): Map<string, string> {
  const cookies = new Map<string, string>();
  if (!headerValue) {
    return cookies;
  }
  for (const entry of headerValue.split(';')) {
    const separatorIndex = entry.indexOf('=');
    if (separatorIndex <= 0) {
      continue;
    }
    const key = entry.slice(0, separatorIndex).trim();
    if (key.length === 0) {
      continue;
    }
    const value = entry.slice(separatorIndex + 1).trim();
    cookies.set(key, value);
  }
  return cookies;
}

function getMatcherConditionValue(
  condition: MiddlewareMatcherCondition,
  url: URL,
  headers: Headers
): string | null {
  switch (condition.type) {
    case 'header':
      return headers.get(condition.key);
    case 'query':
      return url.searchParams.get(condition.key);
    case 'cookie': {
      const cookies = parseCookieHeader(headers.get('cookie'));
      return cookies.get(condition.key) ?? null;
    }
    case 'host': {
      const host = headers.get('host');
      if (!host) {
        return null;
      }
      const portIndex = host.indexOf(':');
      return portIndex > 0 ? host.slice(0, portIndex) : host;
    }
    default:
      return null;
  }
}

function matcherConditionSatisfied(
  condition: MiddlewareMatcherCondition,
  url: URL,
  headers: Headers
): boolean {
  const value = getMatcherConditionValue(condition, url, headers);
  if (value === null) {
    return false;
  }
  if (typeof condition.value !== 'string') {
    return true;
  }

  try {
    return new RegExp(`^${condition.value}$`).test(value);
  } catch {
    return value === condition.value;
  }
}

function middlewareMatcherMatchesRequest(
  matcher: MiddlewareMatcher,
  url: URL,
  headers: Headers
): boolean {
  try {
    if (!new RegExp(matcher.sourceRegex).test(url.pathname)) {
      return false;
    }
  } catch {
    return false;
  }

  for (const condition of matcher.has ?? []) {
    if (
      !matcherConditionSatisfied(
        condition as MiddlewareMatcherCondition,
        url,
        headers
      )
    ) {
      return false;
    }
  }

  for (const condition of matcher.missing ?? []) {
    if (
      matcherConditionSatisfied(
        condition as MiddlewareMatcherCondition,
        url,
        headers
      )
    ) {
      return false;
    }
  }

  return true;
}

function shouldInvokeMiddlewareForRequest(
  middleware: BunMiddlewareArtifact | null | undefined,
  url: URL,
  headers: Headers
): boolean {
  if (!middleware) {
    return false;
  }

  const matchers = middleware.matchers;
  if (!Array.isArray(matchers) || matchers.length === 0) {
    return true;
  }

  return matchers.some((matcher) =>
    middlewareMatcherMatchesRequest(matcher, url, headers)
  );
}

function hasOutputPathname(
  routeOutputsByPathname: Map<string, BunRouteArtifact>,
  pathname: string
): boolean {
  return routeOutputsByPathname.has(pathname);
}

function isAppRouteOutput(output: BunRouteArtifact): boolean {
  return output.type === 'APP_PAGE' || output.type === 'APP_ROUTE';
}

function hasLocalePrefix(
  pathname: string,
  i18n: BunDeploymentManifest['build']['i18n']
): boolean {
  if (!i18n || !Array.isArray(i18n.locales) || i18n.locales.length === 0) {
    return false;
  }

  const segments = pathname.split('/');
  const localeSegment = segments[1];
  if (!localeSegment) {
    return false;
  }

  return i18n.locales.some(
    (locale) => locale.toLowerCase() === localeSegment.toLowerCase()
  );
}

function isPagesApiPathname(
  pathname: string,
  basePath: string
): boolean {
  const normalizedBasePath = normalizeBasePathPrefix(basePath);
  const pathnameWithoutBasePath =
    normalizedBasePath && pathHasPrefix(pathname, normalizedBasePath)
      ? removePathPrefix(pathname, normalizedBasePath)
      : pathname;
  return (
    pathnameWithoutBasePath === '/api' ||
    pathnameWithoutBasePath.startsWith('/api/')
  );
}

function normalizeRouteOutputForRuntime(
  output: BunRouteArtifact,
  basePath: string
): BunRouteArtifact {
  if (
    output.type === 'PAGES_API' &&
    !isPagesApiPathname(output.pathname, basePath)
  ) {
    return {
      ...output,
      type: 'PAGES' as BunRouteArtifact['type'],
    };
  }
  return output;
}

function maybePrefixDefaultLocalePathname({
  pathname,
  basePath,
  i18n,
}: {
  pathname: string;
  basePath: string;
  i18n: BunDeploymentManifest['build']['i18n'];
}): string | null {
  if (!i18n) {
    return null;
  }

  let pathnameWithoutBasePath = pathname;
  const normalizedBasePath = normalizeBasePathPrefix(basePath);
  if (
    normalizedBasePath &&
    pathHasPrefix(pathnameWithoutBasePath, normalizedBasePath)
  ) {
    pathnameWithoutBasePath = removePathPrefix(
      pathnameWithoutBasePath,
      normalizedBasePath
    );
  }

  if (hasLocalePrefix(pathnameWithoutBasePath, i18n)) {
    return null;
  }

  const defaultLocalePathname =
    pathnameWithoutBasePath === '/'
      ? `/${i18n.defaultLocale}`
      : `/${i18n.defaultLocale}${pathnameWithoutBasePath}`;

  return withBasePath(defaultLocalePathname, basePath);
}

function decodePathnameSegmentsPreservingEncodedSlashes(
  pathname: string
): string {
  return pathname
    .split('/')
    .map((segment) => {
      if (segment.length === 0) {
        return segment;
      }
      try {
        return decodeURIComponent(segment).replaceAll('/', '%2F');
      } catch {
        return segment;
      }
    })
    .join('/');
}

function normalizePathnameForFallbackMatch(pathname: string): string {
  const decodedPathname = decodePathnameSegmentsPreservingEncodedSlashes(pathname);

  if (decodedPathname === '/') {
    return decodedPathname;
  }
  return decodedPathname.endsWith('/')
    ? decodedPathname.slice(0, -1)
    : decodedPathname;
}

function findDynamicOutputForPathname(
  routeOutputs: BunRouteArtifact[],
  requestPathname: string,
  prerenderFallbackFalseByPathname?: Map<string, Set<string>>
): BunRouteArtifact | undefined {
  const normalizedRequestPathname =
    normalizePathnameForFallbackMatch(requestPathname);

  for (const output of routeOutputs) {
    if (!output.pathname.includes('[')) {
      continue;
    }
    const params = extractRouteParamsFromPathname(
      output.pathname,
      normalizedRequestPathname
    );
    if (params) {
      const fallbackFalsePaths = prerenderFallbackFalseByPathname?.get(
        output.pathname
      );
      if (
        fallbackFalsePaths &&
        !fallbackFalsePaths.has(normalizedRequestPathname)
      ) {
        continue;
      }
      return output;
    }
  }
  return undefined;
}

function buildPrerenderFallbackFalseByPathname(
  map: BunDeploymentManifest['prerenderFallbackFalseMap']
): Map<string, Set<string>> {
  const normalized = new Map<string, Set<string>>();
  for (const [routePathname, fallbackPathnames] of Object.entries(map ?? {})) {
    if (!Array.isArray(fallbackPathnames) || fallbackPathnames.length === 0) {
      continue;
    }
    const values = new Set<string>();
    for (const pathname of fallbackPathnames) {
      if (typeof pathname !== 'string' || pathname.length === 0) {
        continue;
      }
      values.add(normalizePathnameForFallbackMatch(pathname));
    }
    if (values.size > 0) {
      normalized.set(routePathname, values);
    }
  }
  return normalized;
}

function findAppRouteOutputForRequestPathname({
  requestPathname,
  routeOutputsByPathname,
  appRouteOutputs,
  prerenderFallbackFalseByPathname,
}: {
  requestPathname: string;
  routeOutputsByPathname: Map<string, BunRouteArtifact>;
  appRouteOutputs: BunRouteArtifact[];
  prerenderFallbackFalseByPathname?: Map<string, Set<string>>;
}): BunRouteArtifact | undefined {
  const normalizedPathname = normalizePathnameForFallbackMatch(requestPathname);
  const exactAppRouteOutput = routeOutputsByPathname.get(normalizedPathname);
  if (exactAppRouteOutput && isAppRouteOutput(exactAppRouteOutput)) {
    return exactAppRouteOutput;
  }

  return findDynamicOutputForPathname(
    appRouteOutputs,
    normalizedPathname,
    prerenderFallbackFalseByPathname
  );
}

function normalizeBasePathPrefix(basePath: string): string {
  if (typeof basePath !== 'string' || basePath.length === 0 || basePath === '/') {
    return '';
  }
  return basePath.endsWith('/') ? basePath.slice(0, -1) : basePath;
}

function withBasePath(pathname: string, basePath: string): string {
  const normalizedBasePath = normalizeBasePathPrefix(basePath);
  if (!normalizedBasePath) {
    return pathname;
  }
  if (pathname === '/') {
    return normalizedBasePath;
  }
  return `${normalizedBasePath}${pathname}`;
}

function getLookupPathnameCandidates(pathname: string, basePath: string): string[] {
  const prefixedPathname = withBasePath(pathname, basePath);
  if (prefixedPathname !== pathname) {
    return [prefixedPathname, pathname];
  }
  return [pathname];
}

function getLocalePathnameCandidates(
  pathname: string,
  i18n: BunDeploymentManifest['build']['i18n']
): string[] {
  if (!i18n) {
    return [pathname];
  }

  const localized = [pathname];
  for (const locale of i18n.locales) {
    localized.push(pathname === '/' ? `/${locale}` : `/${locale}${pathname}`);
  }
  return localized;
}

function resolveNotFoundRouteOutput(
  routeOutputsByPathname: Map<string, BunRouteArtifact>,
  basePath: string,
  i18n: BunDeploymentManifest['build']['i18n']
): BunRouteArtifact | undefined {
  const candidates = ['/_not-found', '/404', '/_error'];
  for (const candidate of candidates) {
    for (const localeCandidate of getLocalePathnameCandidates(candidate, i18n)) {
      for (const lookupPathname of getLookupPathnameCandidates(
        localeCandidate,
        basePath
      )) {
        const routeOutput = routeOutputsByPathname.get(lookupPathname);
        if (routeOutput) {
          return routeOutput;
        }
      }
    }
  }
  return undefined;
}

function resolveServerErrorRouteOutput(
  routeOutputsByPathname: Map<string, BunRouteArtifact>,
  basePath: string,
  i18n: BunDeploymentManifest['build']['i18n']
): BunRouteArtifact | undefined {
  const candidates = ['/500', '/_error'];
  for (const candidate of candidates) {
    for (const localeCandidate of getLocalePathnameCandidates(candidate, i18n)) {
      for (const lookupPathname of getLookupPathnameCandidates(
        localeCandidate,
        basePath
      )) {
        const routeOutput = routeOutputsByPathname.get(lookupPathname);
        if (routeOutput) {
          return routeOutput;
        }
      }
    }
  }
  return undefined;
}

function resolveNotFoundStaticAsset(
  staticAssetsByPathname: Map<
    string,
    BunDeploymentManifest['staticAssets'][number]
  >,
  basePath: string,
  i18n: BunDeploymentManifest['build']['i18n']
): BunDeploymentManifest['staticAssets'][number] | undefined {
  const candidates = ['/_not-found', '/404'];
  for (const candidate of candidates) {
    for (const localeCandidate of getLocalePathnameCandidates(candidate, i18n)) {
      for (const lookupPathname of getLookupPathnameCandidates(
        localeCandidate,
        basePath
      )) {
        const staticAsset = staticAssetsByPathname.get(lookupPathname);
        if (staticAsset) {
          return staticAsset;
        }
      }
    }
  }
  return undefined;
}

function resolveServerErrorStaticAsset(
  staticAssetsByPathname: Map<
    string,
    BunDeploymentManifest['staticAssets'][number]
  >,
  basePath: string,
  i18n: BunDeploymentManifest['build']['i18n']
): BunDeploymentManifest['staticAssets'][number] | undefined {
  for (const localeCandidate of getLocalePathnameCandidates('/500', i18n)) {
    for (const lookupPathname of getLookupPathnameCandidates(
      localeCandidate,
      basePath
    )) {
      const staticAsset = staticAssetsByPathname.get(lookupPathname);
      if (staticAsset) {
        return staticAsset;
      }
    }
  }
  return undefined;
}

function pathHasPrefix(pathname: string, prefix: string): boolean {
  if (typeof pathname !== 'string' || typeof prefix !== 'string') {
    return false;
  }
  if (prefix.length === 0) {
    return false;
  }
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

function removePathPrefix(pathname: string, prefix: string): string {
  if (prefix.length === 0 || prefix === '/' || !pathHasPrefix(pathname, prefix)) {
    return pathname;
  }
  const withoutPrefix = pathname.slice(prefix.length);
  return withoutPrefix.startsWith('/') ? withoutPrefix : `/${withoutPrefix}`;
}

function trimBasePath(pathname: string, basePath: string): string {
  const normalizedBasePath =
    typeof basePath === 'string' && basePath.length > 0 ? basePath : '';
  if (!normalizedBasePath) {
    return pathname;
  }
  return removePathPrefix(pathname, normalizedBasePath);
}

function resolveNextImageSourcePathname({
  requestPathname,
  searchParams,
  basePath,
}: {
  requestPathname: string;
  searchParams: URLSearchParams;
  basePath: string;
}): string | null {
  const normalizedRequestPathname = trimBasePath(requestPathname, basePath);
  if (normalizedRequestPathname !== '/_next/image') {
    return null;
  }

  const sourceUrl = searchParams.get('url');
  if (typeof sourceUrl !== 'string' || sourceUrl.length === 0) {
    return null;
  }
  if (!sourceUrl.startsWith('/')) {
    return null;
  }

  try {
    return new URL(sourceUrl, 'http://adapter-bun.local').pathname;
  } catch {
    return sourceUrl;
  }
}

function resolveStaticAssetForPathname({
  pathname,
  basePath,
  staticAssetsByPathname,
}: {
  pathname: string;
  basePath: string;
  staticAssetsByPathname: Map<
    string,
    BunDeploymentManifest['staticAssets'][number]
  >;
}): BunDeploymentManifest['staticAssets'][number] | undefined {
  const lookupCandidates = new Set<string>([
    pathname,
    trimBasePath(pathname, basePath),
    withBasePath(pathname, basePath),
  ]);
  for (const candidate of lookupCandidates) {
    const asset = staticAssetsByPathname.get(candidate);
    if (asset) {
      return asset;
    }
  }
  return undefined;
}

function trimAssetPrefix(pathname: string, assetPrefix: unknown): string {
  if (typeof assetPrefix !== 'string' || assetPrefix.length === 0) {
    return pathname;
  }
  return removePathPrefix(pathname, assetPrefix);
}

function stripLocaleFromPathname(
  pathname: string,
  i18n: BunDeploymentManifest['build']['i18n']
): string {
  if (!i18n || !Array.isArray(i18n.locales) || i18n.locales.length === 0) {
    return pathname;
  }

  const segments = pathname.split('/');
  const localeSegment = segments[1];
  if (
    localeSegment &&
    i18n.locales.some((locale) => locale.toLowerCase() === localeSegment.toLowerCase())
  ) {
    const withoutLocale = pathname.slice(localeSegment.length + 1);
    return withoutLocale.length > 0 ? withoutLocale : '/';
  }

  return pathname;
}

function getRealRequestPathnameForNotFound({
  requestPathname,
  basePath,
  assetPrefix,
  i18n,
}: {
  requestPathname: string;
  basePath: string;
  assetPrefix: unknown;
  i18n: BunDeploymentManifest['build']['i18n'];
}): string {
  let pathname = requestPathname;
  pathname = trimBasePath(pathname, basePath);
  pathname = trimAssetPrefix(pathname, assetPrefix);
  pathname = stripLocaleFromPathname(pathname, i18n);
  return pathname;
}

function getLiteralStatusOverride({
  requestPathname,
  basePath,
  i18n,
  hasPrerenderRevalidateHeader,
}: {
  requestPathname: string;
  basePath: string;
  i18n: BunDeploymentManifest['build']['i18n'];
  hasPrerenderRevalidateHeader: boolean;
}): 404 | 500 | null {
  let pathname = normalizePathnameForFallbackMatch(requestPathname);
  pathname = normalizePathnameForFallbackMatch(trimBasePath(pathname, basePath));
  pathname = normalizePathnameForFallbackMatch(
    stripLocaleFromPathname(pathname, i18n)
  );

  if (pathname === '/404' && !hasPrerenderRevalidateHeader) {
    return 404;
  }
  if (pathname === '/500') {
    return 500;
  }

  return null;
}

function hasMalformedPathnameEncoding(pathname: string): boolean {
  try {
    decodeURIComponent(pathname);
    return false;
  } catch {
    return true;
  }
}

export async function startServer(options?: StartServerOptions): Promise<void> {
  if (typeof (globalThis as { AsyncLocalStorage?: unknown }).AsyncLocalStorage !== 'function') {
    (globalThis as { AsyncLocalStorage: typeof AsyncLocalStorage }).AsyncLocalStorage =
      AsyncLocalStorage;
  }

  const adapterDir = options?.adapterDir ?? path.join(import.meta.dirname, '..');
  const require = createRequire(import.meta.url);
  const manifestPath = path.join(adapterDir, 'deployment-manifest.json');
  const manifest = (await Bun.file(manifestPath).json()) as BunDeploymentManifest;

  const nextRoutingNamespace = require(
    path.join(adapterDir, 'runtime', 'next-routing.cjs')
  ) as Record<string, unknown>;
  const resolveRoutes = readFunctionExport<ResolveRoutesFn>(
    'resolveRoutes',
    nextRoutingNamespace
  );
  const responseToMiddlewareResult =
    readFunctionExport<ResponseToMiddlewareResultFn>(
      'responseToMiddlewareResult',
      nextRoutingNamespace
    );

  const previewProps = manifest.runtime?.previewProps;
  if (previewProps) {
    process.env.__NEXT_PREVIEW_MODE_ID ??= previewProps.previewModeId;
    process.env.__NEXT_PREVIEW_MODE_SIGNING_KEY ??= previewProps.previewModeSigningKey;
    process.env.__NEXT_PREVIEW_MODE_ENCRYPTION_KEY ??=
      previewProps.previewModeEncryptionKey;
  }

  delete process.env.NEXT_ADAPTER_PATH;
  process.env.BUN_ADAPTER_CACHE_DB_PATH = path.join(adapterDir, 'cache.db');

  const projectDir = process.env.NEXT_PROJECT_DIR || path.resolve(adapterDir, '..');
  const requestedPort = Number.parseInt(process.env.PORT || '', 10);
  const port =
    Number.isFinite(requestedPort) && requestedPort > 0
      ? requestedPort
      : manifest.server.port;
  const listenHostname = manifest.server.hostname;
  const isWildcardHostname = (value: string): boolean =>
    value === '0.0.0.0' || value === '::';
  const configuredHostname = process.env.NEXT_HOSTNAME || '';
  const appHostname =
    configuredHostname && !isWildcardHostname(configuredHostname)
      ? configuredHostname
      : !isWildcardHostname(listenHostname)
        ? listenHostname
        : 'localhost';
  const protocol = process.env.__NEXT_EXPERIMENTAL_HTTPS === '1' ? 'https' : 'http';
  process.env.__NEXT_PRIVATE_ORIGIN = `${protocol}://${appHostname}:${port}`;

  const runtimeNextConfig = await loadRuntimeNextConfig(
    adapterDir,
    manifest,
    options?.runtimeNextConfigFile
  );
  const runtimeExperimentalConfig = toJsonRecord(runtimeNextConfig.experimental);
  const validateRSCRequestHeaders =
    runtimeExperimentalConfig.validateRSCRequestHeaders === true;
  if (process.env.ADAPTER_BUN_DEBUG_ROUTING === '1') {
    console.error('[adapter-bun] runtime config', {
      validateRSCRequestHeaders,
    });
  }
  const runtimeDistDir = path.isAbsolute(runtimeNextConfig.distDir)
    ? runtimeNextConfig.distDir
    : path.join(projectDir, runtimeNextConfig.distDir);
  const relativeProjectDir = path.relative(process.cwd(), projectDir);
  const projectRequire = createRequire(path.join(projectDir, 'package.json'));

  const routeGraph = manifest.routeGraph;
  const routeOutputs = manifest.routeOutputs.map((output) =>
    normalizeRouteOutputForRuntime(output, manifest.build.basePath)
  );
  const routeOutputsById = new Map(routeOutputs.map((output) => [output.id, output]));
  const routeOutputsByPathname = new Map(
    routeOutputs.map((output) => [output.pathname, output])
  );
  const appRouteOutputs = routeOutputs.filter(isAppRouteOutput);
  const prerenderArtifactsByPathname = new Map(
    (manifest.prerenderArtifacts ?? []).map((artifact) => [artifact.pathname, artifact])
  );
  const prerenderFallbackFalseByPathname = buildPrerenderFallbackFalseByPathname(
    manifest.prerenderFallbackFalseMap
  );
  const middlewareArtifact = manifest.middleware ?? null;
  const staticAssetsByPathname = new Map(
    (manifest.staticAssets ?? []).map((asset) => [asset.pathname, asset])
  );
  const notFoundRouteOutput = resolveNotFoundRouteOutput(
    routeOutputsByPathname,
    manifest.build.basePath,
    manifest.build.i18n
  );
  const serverErrorStaticAsset = resolveServerErrorStaticAsset(
    staticAssetsByPathname,
    manifest.build.basePath,
    manifest.build.i18n
  );
  const serverErrorRouteOutput = resolveServerErrorRouteOutput(
    routeOutputsByPathname,
    manifest.build.basePath,
    manifest.build.i18n
  );

  const nodeRouteHandlerCache = new Map<string, Promise<NodeRouteHandler>>();
  const edgeRouteHandlerCache = new Map<string, Promise<EdgeRouteHandler>>();
  const edgeRuntimeExecutorCache = new Map<string, Promise<EdgeRuntimeExecutor>>();
  let middlewareHandlerPromise: Promise<EdgeRouteHandler | null> | undefined;

  function getNodeRouteHandler(routeOutput: BunRouteArtifact): Promise<NodeRouteHandler> {
    const cached = nodeRouteHandlerCache.get(routeOutput.pathname);
    if (cached) {
      return cached;
    }

    const promise = (async () => {
      const modulePath = resolveRouteOutputModulePath(runtimeDistDir, routeOutput);
      const loadedModule = await loadOutputModule(projectRequire, modulePath);
      return resolveNodeHandlerExport(loadedModule);
    })();

    nodeRouteHandlerCache.set(routeOutput.pathname, promise);
    return promise;
  }

  async function createEdgeRuntimeExecutor({
    sourcePage,
    outputId,
    modulePaths,
    assets,
    wasmAssets,
    env,
  }: {
    sourcePage: string;
    outputId: string;
    modulePaths: string[];
    assets?: Record<string, string>;
    wasmAssets?: Record<string, string>;
    env?: Record<string, string>;
  }): Promise<EdgeRuntimeExecutor> {
    if (modulePaths.length === 0) {
      throw new Error(
        `[adapter-bun] no edge module paths resolved for "${sourcePage}"`
      );
    }

    const assetsByName = new Map<string, string>();
    for (const [name, relativePath] of Object.entries(assets ?? {})) {
      const assetPath = path.isAbsolute(relativePath)
        ? relativePath
        : path.join(runtimeDistDir, relativePath);
      if (!existsSync(assetPath)) {
        continue;
      }
      assetsByName.set(name, assetPath);
      assetsByName.set(relativePath, assetPath);
    }

    const edgeProcess = {
      env: buildEdgeProcessEnv(normalizeEdgeEnv(env)),
    };
    const runtime = new EdgeRuntime({
      extend(context) {
        context.process = edgeProcess;

        Object.defineProperty(context, 'require', {
          enumerable: false,
          value: (id: string) => {
            const moduleValue = EDGE_NATIVE_MODULES.get(id);
            if (!moduleValue) {
              throw new TypeError(`Native module not found: ${id}`);
            }
            return moduleValue;
          },
        });

        const originalFetch = context.fetch.bind(context);
        context.fetch = async (input, init = {}) => {
          const assetResponse = await maybeReadInlineAssetResponse({
            input,
            assetsByName,
            context,
          });
          if (assetResponse) {
            return assetResponse;
          }
          return originalFetch(input, init);
        };

        return context;
      },
    });

    runtime.context.AsyncLocalStorage = AsyncHooksImplementation.AsyncLocalStorage;
    installEdgeCacheHandlers(runtime.context);
    if (typeof (runtime.context as { self?: unknown }).self === 'undefined') {
      (runtime.context as { self: unknown }).self = runtime.context;
    }

    for (const [name, relativePath] of Object.entries(wasmAssets ?? {})) {
      const wasmPath = path.isAbsolute(relativePath)
        ? relativePath
        : path.join(runtimeDistDir, relativePath);
      if (!existsSync(wasmPath)) {
        continue;
      }
      runtime.context[name] = await WebAssembly.compile(await readFile(wasmPath));
    }

    const beforeEntryKeys = new Set(
      Object.keys(toJsonRecord((runtime.context as Record<string, unknown>)._ENTRIES))
    );
    for (const modulePath of modulePaths) {
      const source = await readFile(modulePath, 'utf8');
      runInContext(source, runtime.context, {
        filename: modulePath,
      });
    }

    const entries = toJsonRecord((runtime.context as Record<string, unknown>)._ENTRIES);
    const entryKey = resolveEdgeEntryKey({
      entries,
      sourcePage,
      outputId,
      beforeEntryKeys,
    });
    if (!entryKey) {
      throw new Error(
        `[adapter-bun] failed to resolve edge entry for "${sourcePage}" (${outputId})`
      );
    }

    return {
      runtime,
      entryKey,
      sourcePage,
      outputId,
    };
  }

  function getEdgeRuntimeExecutor({
    cacheKey,
    sourcePage,
    outputId,
    modulePaths,
    assets,
    wasmAssets,
    env,
  }: {
    cacheKey: string;
    sourcePage: string;
    outputId: string;
    modulePaths: string[];
    assets?: Record<string, string>;
    wasmAssets?: Record<string, string>;
    env?: Record<string, string>;
  }): Promise<EdgeRuntimeExecutor> {
    const cached = edgeRuntimeExecutorCache.get(cacheKey);
    if (cached) {
      return cached;
    }

    const promise = createEdgeRuntimeExecutor({
      sourcePage,
      outputId,
      modulePaths,
      assets,
      wasmAssets,
      env,
    });
    edgeRuntimeExecutorCache.set(cacheKey, promise);
    void promise.catch(() => {
      edgeRuntimeExecutorCache.delete(cacheKey);
    });
    return promise;
  }

  function getEdgeRouteHandler(routeOutput: BunRouteArtifact): Promise<EdgeRouteHandler> {
    const cached = edgeRouteHandlerCache.get(routeOutput.pathname);
    if (cached) {
      return cached;
    }

    const promise = (async () => {
      const modulePaths = resolveEdgeArtifactModulePaths(runtimeDistDir, routeOutput);
      const executor = await getEdgeRuntimeExecutor({
        cacheKey: `route:${normalizeEdgeOutputId(routeOutput.id)}`,
        sourcePage: routeOutput.sourcePage,
        outputId: routeOutput.id,
        modulePaths,
        assets: routeOutput.assets,
        wasmAssets: routeOutput.wasmAssets,
        env: routeOutput.env,
      });
      return (request: Request, ctx: Parameters<EdgeRouteHandler>[1]) =>
        invokeEdgeEntryHandler({
          executor,
          request,
          waitUntil: ctx.waitUntil,
          requestMeta: ctx.requestMeta,
        });
    })();

    edgeRouteHandlerCache.set(routeOutput.pathname, promise);
    return promise;
  }

  function getMiddlewareHandler(): Promise<EdgeRouteHandler | null> {
    if (middlewareHandlerPromise) {
      return middlewareHandlerPromise;
    }

    middlewareHandlerPromise = (async () => {
      const middleware = manifest.middleware;
      if (!middleware) {
        return null;
      }

      if (middleware.runtime === 'edge') {
        const middlewareModulePaths = resolveEdgeArtifactModulePaths(
          runtimeDistDir,
          middleware
        );
        if (middlewareModulePaths.length === 0) {
          return null;
        }
        const executor = await getEdgeRuntimeExecutor({
          cacheKey: `middleware:${normalizeEdgeOutputId(middleware.id)}`,
          sourcePage: middleware.sourcePage,
          outputId: middleware.id,
          modulePaths: middlewareModulePaths,
          assets: middleware.assets,
          wasmAssets: middleware.wasmAssets,
          env: middleware.env,
        });
        return (request: Request, ctx: Parameters<EdgeRouteHandler>[1]) =>
          invokeEdgeEntryHandler({
            executor,
            request,
            waitUntil: ctx.waitUntil,
            requestMeta: ctx.requestMeta,
          });
      }

      if (middleware.runtime === 'nodejs') {
        const modulePath = path.isAbsolute(middleware.filePath)
          ? middleware.filePath
          : path.join(runtimeDistDir, middleware.filePath);
        if (!existsSync(modulePath)) {
          return null;
        }
        const loadedModule = await loadOutputModule(projectRequire, modulePath);
        const nodeMiddlewareHandler =
          resolveNodeMiddlewareHandlerExport(loadedModule);
        return (
          request: Request,
          ctx: Parameters<EdgeRouteHandler>[1]
        ) =>
          nodeMiddlewareHandler(request, {
            waitUntil: ctx.waitUntil,
            signal: request.signal,
            requestMeta: ctx.requestMeta,
          });
      }

      return null;
    })();

    return middlewareHandlerPromise;
  }

  function getNodeRequestUrl(req: http.IncomingMessage): URL {
    return new URL(
      req.url || '/',
      `${getSingleHeaderValue(req.headers['x-forwarded-proto']) || 'http'}://${getSingleHeaderValue(req.headers.host) || appHostname}`
    );
  }

  function buildNodeRequestMeta({
    req,
    requestUrl,
    routeOutput,
    invocationMeta,
  }: {
    req: http.IncomingMessage;
    requestUrl: URL;
    routeOutput: BunRouteArtifact;
    invocationMeta?: RouteInvocationMeta;
  }): JsonRecord {
    const requestHasNextDataHeader =
      getSingleHeaderValue(req.headers['x-nextjs-data']) === '1';
    const isNextDataReq =
      requestHasNextDataHeader || requestUrl.pathname.includes('/_next/data/');
    const initUrl = invocationMeta?.originalUrl
      ? new URL(invocationMeta.originalUrl)
      : requestUrl;
    const nextDataPagePathname = resolvePagePathnameFromNextDataPathname(
      requestUrl.pathname,
      manifest
    );
    const extractedPathParams =
      extractRouteParamsFromPathname(routeOutput.pathname, requestUrl.pathname) ??
      (nextDataPagePathname
        ? extractRouteParamsFromPathname(routeOutput.pathname, nextDataPagePathname) ??
          extractRouteParamsFromPathname(
            routeOutput.pathname,
            stripLocaleFromPathname(nextDataPagePathname, manifest.build.i18n)
          )
        : undefined);
    const extractedParams = mergeRouteParams(
      normalizeRouteParams(routeOutput.pathname, invocationMeta?.routeMatches),
      extractedPathParams
    );

    return {
      relativeProjectDir,
      distDir: runtimeDistDir,
      initURL: initUrl.toString(),
      initProtocol: initUrl.protocol.slice(0, -1),
      initQuery: searchParamsToQueryObject(initUrl.searchParams),
      query: searchParamsToQueryObject(requestUrl.searchParams),
      ...(extractedParams ? { params: extractedParams } : {}),
      ...(req.headers[routeGraph.rsc.header] === '1'
        ? { isRSCRequest: true }
        : {}),
      ...(req.headers[routeGraph.rsc.prefetchHeader] === '1'
        ? { isPrefetchRSCRequest: true }
        : {}),
      ...(isNextDataReq ? { isNextDataReq: true } : {}),
      ...(!routeOutput.pathname.includes('[') &&
      !hasInterceptionMarker(routeOutput.pathname) &&
      routeOutput.pathname !== requestUrl.pathname
        ? { rewrittenPathname: routeOutput.pathname }
        : {}),
      ...(invocationMeta?.resolvedPathname &&
      invocationMeta.resolvedPathname !== routeOutput.pathname
        ? { resolvedPathname: invocationMeta.resolvedPathname }
        : {}),
      minimalMode: false,
    };
  }

  async function invokeNodeRouteOutput({
    req,
    res,
    routeOutput,
    invocationMeta,
  }: {
    req: http.IncomingMessage;
    res: http.ServerResponse;
    routeOutput: BunRouteArtifact;
    invocationMeta?: RouteInvocationMeta;
  }): Promise<void> {
    const handler = await getNodeRouteHandler(routeOutput);
    const requestUrl = getNodeRequestUrl(req);
    const requestMeta = buildNodeRequestMeta({
      req,
      requestUrl,
      routeOutput,
      invocationMeta,
    });
    if (process.env.ADAPTER_BUN_DEBUG_ROUTING === '1') {
      console.error('[adapter-bun] node request meta', {
        outputPathname: routeOutput.pathname,
        url: requestUrl.pathname,
        params:
          typeof requestMeta.params === 'object' && requestMeta.params !== null
            ? requestMeta.params
            : null,
        query:
          typeof requestMeta.query === 'object' && requestMeta.query !== null
            ? requestMeta.query
            : null,
      });
    }

    const maybeResult = await handler(req, res, {
      waitUntil: (promise) => {
        promise.catch((error) => {
          console.error('[adapter-bun] node waitUntil errored:', error);
        });
      },
      requestMeta,
    });

    if (
      maybeResult !== undefined &&
      maybeResult !== null &&
      !res.headersSent &&
      !res.writableEnded
    ) {
      await writeResponseToNode(res, await toResponse(maybeResult));
    }
  }

  function writePlainTextStatusResponse(
    res: http.ServerResponse,
    statusCode: number,
    body: string
  ): void {
    if (!res.headersSent) {
      res.statusCode = statusCode;
      res.setHeader('content-type', 'text/plain; charset=utf-8');
    }
    if (!res.writableEnded) {
      res.end(body);
    }
  }

  async function renderNodeStatusOutput({
    req,
    res,
    statusCode,
    invocationMeta,
    currentOutputPathname,
  }: {
    req: http.IncomingMessage;
    res: http.ServerResponse;
    statusCode: 404 | 500;
    invocationMeta?: RouteInvocationMeta;
    currentOutputPathname?: string;
  }): Promise<boolean> {
    if (
      statusCode === 500 &&
      serverErrorStaticAsset &&
      serverErrorStaticAsset.pathname !== currentOutputPathname
    ) {
      try {
        const staticAssetRequest = new Request(getNodeRequestUrl(req).toString(), {
          method: req.method ?? 'GET',
          headers: toResponseHeaders(req.headers),
        });
        const staticAssetResponse = serveStaticAsset(
          staticAssetRequest,
          adapterDir,
          serverErrorStaticAsset,
          routeGraph
        );
        const statusResponse = new Response(staticAssetResponse.body, {
          status: 500,
          headers: staticAssetResponse.headers,
        });
        await writeResponseToNode(res, statusResponse);
        return true;
      } catch (error) {
        console.error(
          `[adapter-bun] failed to render ${statusCode} fallback static asset "${serverErrorStaticAsset.pathname}":`,
          error
        );
      }
    }

    const routeOutput =
      statusCode === 404 ? notFoundRouteOutput : serverErrorRouteOutput;

    if (
      !routeOutput ||
      routeOutput.runtime !== 'nodejs' ||
      routeOutput.pathname === currentOutputPathname
    ) {
      return false;
    }

    try {
      if (!res.headersSent) {
        res.statusCode = statusCode;
      }
      await invokeNodeRouteOutput({
        req,
        res,
        routeOutput,
        invocationMeta,
      });
      return true;
    } catch (error) {
      console.error(
        `[adapter-bun] failed to render ${statusCode} fallback output "${routeOutput.pathname}":`,
        error
      );
      return false;
    }
  }

  const routerServerMethodsSymbol = Symbol.for('@next/router-server-methods');
  type RouterServerRevalidateOptions = {
    unstable_onlyGenerated?: boolean;
  };
  type RouterServerRevalidateHeaders = Record<string, string | string[]>;
  type RouterServerMethods = {
    revalidate?: (config: {
      urlPath: string;
      revalidateHeaders: RouterServerRevalidateHeaders;
      opts: RouterServerRevalidateOptions;
    }) => Promise<void>;
    render404?: (
      req: http.IncomingMessage,
      res: http.ServerResponse
    ) => Promise<void>;
  };
  const routerServerContext =
    globalThis as typeof globalThis & {
      [key: symbol]: Record<string, RouterServerMethods>;
    };
  routerServerContext[routerServerMethodsSymbol] ??= {};
  const routerServerMethods: RouterServerMethods = {
    async revalidate({
      urlPath,
      revalidateHeaders,
      opts,
    }): Promise<void> {
      const revalidateUrl = new URL(urlPath, `http://127.0.0.1:${port}`);
      const headers = new Headers();
      for (const [key, value] of Object.entries(revalidateHeaders)) {
        if (Array.isArray(value)) {
          for (const item of value) {
            headers.append(key, item);
          }
        } else {
          headers.set(key, value);
        }
      }

      const response = await fetch(revalidateUrl, {
        method: 'HEAD',
        headers,
        redirect: 'manual',
      });
      const cacheHeader =
        response.headers.get('x-vercel-cache') ??
        response.headers.get('x-nextjs-cache');
      if (
        cacheHeader?.toUpperCase() !== 'REVALIDATED' &&
        response.status !== 200 &&
        !(response.status === 404 && opts.unstable_onlyGenerated)
      ) {
        throw new Error(`Invalid response ${response.status}`);
      }
    },
    async render404(req, res): Promise<void> {
      const rendered = await renderNodeStatusOutput({
        req,
        res,
        statusCode: 404,
      });
      if (!rendered) {
        writePlainTextStatusResponse(res, 404, 'This page could not be found');
      }
    },
  };
  routerServerContext[routerServerMethodsSymbol][relativeProjectDir] =
    routerServerMethods;
  if (relativeProjectDir !== '.') {
    routerServerContext[routerServerMethodsSymbol]['.'] = routerServerMethods;
  }

  const backendServer = http.createServer(async (req, res) => {
    req.headers = { ...req.headers };
    patchCacheControlHeader(req, res);

    const userAgent =
      typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'] : '';
    if (userAgent.includes('node-fetch')) {
      req.headers.connection = 'close';
      res.setHeader('connection', 'close');
    }

    if (req.headers[routeGraph.rsc.header] === '1') {
      if (!req.headers.accept || req.headers.accept === '*/*') {
        req.headers.accept = routeGraph.rsc.contentTypeHeader || 'text/x-component';
      }
      if (req.method === 'GET' && typeof req.headers['content-type'] === 'string') {
        delete req.headers['content-type'];
      }
    }

    let internalOutputPathname: string | undefined;
    let invocationMeta: RouteInvocationMeta | undefined;

    try {
      const resolvedInternalOutputPathname = getSingleHeaderValue(
        req.headers['x-bun-output-pathname']
      );
      if (
        typeof resolvedInternalOutputPathname !== 'string' ||
        resolvedInternalOutputPathname.length === 0
      ) {
        writePlainTextStatusResponse(res, 404, 'This page could not be found');
        return;
      }

      delete req.headers['x-bun-output-pathname'];
      // Preserve for fallback handling in outer error paths.
      internalOutputPathname = resolvedInternalOutputPathname;
      const routeOutput = routeOutputsByPathname.get(
        resolvedInternalOutputPathname
      );
      if (!routeOutput || routeOutput.runtime === 'edge') {
        throw new Error(
          `[adapter-bun] missing node route output for "${resolvedInternalOutputPathname}"`
        );
      }
      if (routeOutput.type === 'PAGES_API') {
        patchApiResponseDefaultContentType(res);
      }

      invocationMeta = decodeRouteInvocationMeta(
        getSingleHeaderValue(req.headers['x-bun-invoke-meta'])
      );
      delete req.headers['x-bun-invoke-meta'];

      if (process.env.ADAPTER_BUN_DEBUG_ROUTING === '1') {
        console.error('[adapter-bun] node invocation request', {
          outputPathname: resolvedInternalOutputPathname,
          url: req.url,
          rsc: req.headers[routeGraph.rsc.header] ?? null,
          nextJsData: req.headers['x-nextjs-data'] ?? null,
          middlewarePrefetch: req.headers['x-middleware-prefetch'] ?? null,
          purpose: req.headers.purpose ?? null,
          accept: req.headers.accept ?? null,
          nextRouterStateTree: req.headers['next-router-state-tree'] ?? null,
          nextRouterPrefetch: req.headers['next-router-prefetch'] ?? null,
          nextUrl: req.headers['next-url'] ?? null,
        });
      }

      await prepareActionRequestBodyForBun(req);
      if (!res.headersSent) {
        if (invocationMeta?.source === 'not-found') {
          res.statusCode = 404;
        } else if (invocationMeta?.source === 'error') {
          res.statusCode = 500;
        }
      }
      await invokeNodeRouteOutput({
        req,
        res,
        routeOutput,
        invocationMeta,
      });
    } catch (error) {
      console.error('[adapter-bun] error handling node request:', error);
      const rendered500 = await renderNodeStatusOutput({
        req,
        res,
        statusCode: 500,
        invocationMeta,
        currentOutputPathname: internalOutputPathname,
      });
      if (!rendered500) {
        writePlainTextStatusResponse(res, 500, 'Internal Server Error');
      }
    }
  });

  const backendOrigin = await new Promise<string>((resolve, reject) => {
    const handleError = (error: Error): void => {
      backendServer.off('listening', handleListening);
      reject(error);
    };

    const handleListening = (): void => {
      backendServer.off('error', handleError);
      const addr = backendServer.address();
      if (!addr || typeof addr === 'string') {
        reject(new Error('[adapter-bun] failed to resolve backend address'));
        return;
      }
      resolve(`http://127.0.0.1:${addr.port}`);
    };

    backendServer.once('error', handleError);
    backendServer.listen(0, '127.0.0.1', handleListening);
  });
  if (process.env.ADAPTER_BUN_DEBUG_ROUTING === '1') {
    console.error('[adapter-bun] backend origin', { backendOrigin });
  }

  async function proxyRequest(
    request: Request,
    bunServer: Bun.Server<unknown>,
    upstreamUrl: URL,
    sourceHeaders: Headers,
    resolution: ResolveRoutesResult,
    preserveHost: boolean,
    extraHeaders?: Headers
  ): Promise<Response> {
    bunServer.timeout(request, 0);
    const proxyHeaders = buildProxyHeaders({
      request,
      server: bunServer,
      sourceHeaders,
      upstreamUrl,
      preserveHost,
    });
    extraHeaders?.forEach((value, key) => {
      proxyHeaders.set(key, value);
    });

    let response = await fetch(upstreamUrl, {
      method: request.method,
      headers: proxyHeaders,
      body: shouldSendRequestBody(request.method) ? request.body : undefined,
      redirect: 'manual',
      signal: request.signal,
    });

    const outputPathname = extraHeaders?.get('x-bun-output-pathname') ?? null;
    const output = outputPathname
      ? routeOutputsByPathname.get(outputPathname)
      : undefined;
    if (output?.runtime === 'edge') {
      response = normalizeEdgeResponseEncoding(response);
    }
    const isApiOutput = output?.type === 'PAGES_API';
    const isDocumentNavigation =
      request.headers.get('upgrade-insecure-requests') === '1';
    const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
    if (
      isApiOutput &&
      isDocumentNavigation &&
      (contentType.length === 0 || contentType.startsWith('application/octet-stream'))
    ) {
      const normalizedHeaders = new Headers(response.headers);
      normalizedHeaders.set('content-type', 'text/plain; charset=utf-8');
      response = new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: normalizedHeaders,
      });
    }

    const resolvedResponse = applyResolutionToResponse(response, resolution);

    if (process.env.ADAPTER_BUN_DEBUG_ROUTING === '1') {
      console.error('[adapter-bun] proxy response', {
        requestPathname: new URL(request.url).pathname,
        upstreamPathname: upstreamUrl.pathname,
        status: resolvedResponse.status,
        contentType: resolvedResponse.headers.get('content-type'),
        xNextjsRewrite: resolvedResponse.headers.get('x-nextjs-rewrite'),
        xMiddlewareRewrite: resolvedResponse.headers.get('x-middleware-rewrite'),
        xNextjsMatchedPath: resolvedResponse.headers.get('x-nextjs-matched-path'),
        rscHeader: request.headers.get(routeGraph.rsc.header),
        outputPathname: extraHeaders?.get('x-bun-output-pathname') ?? null,
        outputType: output?.type ?? null,
        isDocumentNavigation,
      });
    }

    return sanitizeProxyResponse(resolvedResponse, request);
  }

  async function canResolvePathnameWithoutMiddleware({
    request,
    pathname,
  }: {
    request: Request;
    pathname: string;
  }): Promise<boolean> {
    const requestUrl = new URL(request.url);
    const candidateUrl = new URL(pathname, requestUrl.origin);
    candidateUrl.search = requestUrl.search;
    const candidateResolution = stripMiddlewareResponse(
      (await resolveRoutes({
        url: candidateUrl,
        buildId: manifest.build.buildId,
        basePath: manifest.build.basePath,
        requestBody: createEmptyBodyStream(),
        headers: new Headers([...request.headers.entries()]),
        pathnames: manifest.pathnames,
        i18n: toResolutionI18nConfig(manifest),
        routes: routeGraph,
        invokeMiddleware: async () => ({}),
      })) as unknown as JsonRecord
    ) as ResolveRoutesResult;

    return resolveResolutionPathname(candidateResolution) !== null;
  }

  const server = Bun.serve({
    port,
    hostname: listenHostname,
    idleTimeout: 0,
    async fetch(request, bunServer) {
      const rscValidationRedirectLocation = resolveRscValidationRedirectLocation({
        request,
        routeGraph,
        validateRSCRequestHeaders,
      });
      if (rscValidationRedirectLocation) {
        return sanitizeProxyResponse(
          new Response(null, {
            status: 307,
            headers: {
              location: rscValidationRedirectLocation,
            },
          }),
          request
        );
      }

      const requestUrl = new URL(request.url);
      if (hasMalformedPathnameEncoding(requestUrl.pathname)) {
        return sanitizeProxyResponse(
          new Response('Bad Request', {
            status: 400,
            headers: {
              'cache-control':
                'private, no-cache, no-store, max-age=0, must-revalidate',
              'content-type': 'text/plain; charset=utf-8',
            },
          }),
          request
        );
      }

      const requestForResolution = shouldSendRequestBody(request.method)
        ? request.clone()
        : request;
      const sanitizedRequestHeaders = sanitizeIncomingRequestHeaders(
        request.headers
      );
      let middlewareRequestHeaders: Headers | null = null;
      let middlewareRewriteUrl: string | null = null;
      let middlewareResponseHeaders: unknown = null;
      let middlewareResponsePayload: Response | null = null;

      const invokeResolutionMiddleware = async ({
        url,
        headers,
        requestBody,
      }: {
        url: URL;
        headers: Headers;
        requestBody: ReadableStream<Uint8Array>;
      }) => {
        const middlewareHandler = await getMiddlewareHandler();
        if (!middlewareHandler) {
          return {};
        }
        if (!shouldInvokeMiddlewareForRequest(middlewareArtifact, url, headers)) {
          return {};
        }

        const middlewareUrl = new URL(url.toString());
        if (
          headers.get('x-nextjs-data') === '1' &&
          manifest.build.trailingSlash &&
          middlewareUrl.pathname !== '/' &&
          !middlewareUrl.pathname.endsWith('/') &&
          !middlewareUrl.pathname.startsWith('/_next/') &&
          !path.extname(middlewareUrl.pathname)
        ) {
          middlewareUrl.pathname = `${middlewareUrl.pathname}/`;
        }

        const middlewareRequest = new Request(middlewareUrl.toString(), {
          method: request.method,
          headers: new Headers(headers),
          body: shouldSendRequestBody(request.method) ? requestBody : undefined,
          signal: request.signal,
          redirect: 'manual',
        });

        const middlewareResult = await middlewareHandler(middlewareRequest, {
          waitUntil: (promise) => {
            promise.catch((error) => {
              console.error('[adapter-bun] middleware waitUntil errored:', error);
            });
          },
          signal: request.signal,
          requestMeta: {
            source: 'middleware',
            pathname: middlewareUrl.pathname,
          },
        });

        const middlewareResponse = await toResponse(middlewareResult);
        const middlewareResolved = responseToMiddlewareResult(
          middlewareResponse,
          new Headers(headers),
          middlewareUrl
        );
        if (middlewareResolved.bodySent) {
          middlewareResponsePayload = middlewareResponse;
        }
        if (middlewareResolved.requestHeaders) {
          middlewareRequestHeaders = new Headers(middlewareResolved.requestHeaders);
        }
        if (middlewareResolved.responseHeaders) {
          middlewareResponseHeaders = new Headers(middlewareResolved.responseHeaders);
        }
        if (middlewareResolved.rewrite) {
          middlewareRewriteUrl = middlewareResolved.rewrite.toString();
        }
        return middlewareResolved;
      };

      let unresolvedResolution = await resolveRoutes({
        url: new URL(requestForResolution.url),
        buildId: manifest.build.buildId,
        basePath: manifest.build.basePath,
        requestBody: requestForResolution.body ?? createEmptyBodyStream(),
        headers: new Headers(sanitizedRequestHeaders),
        pathnames: manifest.pathnames,
        i18n: toResolutionI18nConfig(manifest),
        routes: routeGraph,
        invokeMiddleware: invokeResolutionMiddleware,
      });

      let resolution = stripMiddlewareResponse(
        unresolvedResolution as unknown as JsonRecord
      ) as ResolveRoutesResult;

      if (
        !shouldSendRequestBody(request.method) &&
        middlewareRequestHeaders === null &&
        middlewareRewriteUrl === null &&
        middlewareResponsePayload === null &&
        resolveResolutionPathname(resolution) === null &&
        !resolution.redirect &&
        !resolution.externalRewrite &&
        !resolution.middlewareResponded &&
        !isRedirectResolution(resolution)
      ) {
        const originalUrl = new URL(requestForResolution.url);
        const fallbackPathnames: string[] = [];
        const maybePushFallbackPathname = (pathname: string): void => {
          if (
            pathname.length === 0 ||
            pathname === originalUrl.pathname ||
            fallbackPathnames.includes(pathname)
          ) {
            return;
          }
          fallbackPathnames.push(pathname);
        };

        const foldedPathname = originalUrl.pathname.toLowerCase();
        if (foldedPathname !== originalUrl.pathname) {
          maybePushFallbackPathname(foldedPathname);
        }

        for (const fallbackPathname of fallbackPathnames) {
          const fallbackUrl = new URL(originalUrl);
          fallbackUrl.pathname = fallbackPathname;
          const fallbackUnresolvedResolution = await resolveRoutes({
            url: fallbackUrl,
            buildId: manifest.build.buildId,
            basePath: manifest.build.basePath,
            requestBody: createEmptyBodyStream(),
            headers: new Headers(sanitizedRequestHeaders),
            pathnames: manifest.pathnames,
            i18n: toResolutionI18nConfig(manifest),
            routes: routeGraph,
            invokeMiddleware: invokeResolutionMiddleware,
          });
          const fallbackResolution = stripMiddlewareResponse(
            fallbackUnresolvedResolution as unknown as JsonRecord
          ) as ResolveRoutesResult;
          if (
            resolveResolutionPathname(fallbackResolution) !== null ||
            fallbackResolution.redirect ||
            fallbackResolution.externalRewrite ||
            fallbackResolution.middlewareResponded ||
            isRedirectResolution(fallbackResolution)
          ) {
            unresolvedResolution = fallbackUnresolvedResolution;
            resolution = fallbackResolution;
            break;
          }
        }
      }

      const resolutionI18nConfig = toResolutionI18nConfig(manifest);
      if (
        !shouldSendRequestBody(request.method) &&
        resolution.redirect &&
        resolutionI18nConfig &&
        resolutionI18nConfig.localeDetection !== false &&
        !isI18nRootPathname(
          new URL(requestForResolution.url).pathname,
          manifest.build.basePath
        )
      ) {
        const localeStableUnresolvedResolution = await resolveRoutes({
          url: new URL(requestForResolution.url),
          buildId: manifest.build.buildId,
          basePath: manifest.build.basePath,
          requestBody: createEmptyBodyStream(),
          headers: new Headers(sanitizedRequestHeaders),
          pathnames: manifest.pathnames,
          i18n: {
            ...resolutionI18nConfig,
            localeDetection: false,
          },
          routes: routeGraph,
          invokeMiddleware: invokeResolutionMiddleware,
        });
        const localeStableResolution = stripMiddlewareResponse(
          localeStableUnresolvedResolution as unknown as JsonRecord
        ) as ResolveRoutesResult;
        if (
          resolveResolutionPathname(localeStableResolution) !== null ||
          localeStableResolution.externalRewrite ||
          localeStableResolution.middlewareResponded ||
          isRedirectResolution(localeStableResolution) ||
          !localeStableResolution.redirect
        ) {
          unresolvedResolution = localeStableUnresolvedResolution;
          resolution = localeStableResolution;
        }
      }

      if (middlewareResponseHeaders instanceof Headers) {
        const mergedResolvedHeaders = new Headers(
          resolution.resolvedHeaders ?? undefined
        );
        middlewareResponseHeaders.forEach((value, key) => {
          if (key.toLowerCase() === 'x-middleware-set-cookie') {
            mergedResolvedHeaders.append(key, value);
          } else {
            mergedResolvedHeaders.set(key, value);
          }
        });
        resolution = {
          ...resolution,
          resolvedHeaders: mergedResolvedHeaders,
        };
      }

      const requestForResolutionUrl = new URL(requestForResolution.url);
      const canonicalNextDataRedirectUrl =
        resolveCanonicalNextDataToPageRedirectUrl({
          requestPathname: requestForResolutionUrl.pathname,
          resolution,
          requestUrl: requestForResolutionUrl,
          manifest,
        });
      if (canonicalNextDataRedirectUrl) {
        middlewareRequestHeaders = null;
        middlewareRewriteUrl = null;
        middlewareResponseHeaders = null;
        middlewareResponsePayload = null;
        unresolvedResolution = await resolveRoutes({
          url: canonicalNextDataRedirectUrl,
          buildId: manifest.build.buildId,
          basePath: manifest.build.basePath,
          requestBody: createEmptyBodyStream(),
          headers: new Headers(sanitizedRequestHeaders),
          pathnames: manifest.pathnames,
          i18n: toResolutionI18nConfig(manifest),
          routes: routeGraph,
          invokeMiddleware: invokeResolutionMiddleware,
        });
        resolution = stripMiddlewareResponse(
          unresolvedResolution as unknown as JsonRecord
        ) as ResolveRoutesResult;
      }

      if (resolution.redirect) {
        const requestForRedirect = new URL(requestForResolution.url);
        const redirectLocation = resolveRedirectLocationWithPreservedSearch({
          location: resolution.redirect.url.toString(),
          requestUrl: requestForRedirect,
        });
        const response = new Response(null, {
          status: resolution.redirect.status,
          headers: {
            location: redirectLocation,
          },
        });
        return sanitizeProxyResponse(
          applyResolutionToResponse(
            response,
            resolution,
            resolution.redirect.status
          ),
          request
        );
      }

      if (isRedirectResolution(resolution)) {
        const redirectHeaders = new Headers(resolution.resolvedHeaders ?? undefined);
        const requestForRedirect = new URL(requestForResolution.url);
        const existingLocation = redirectHeaders.get('location');
        if (existingLocation) {
          redirectHeaders.set(
            'location',
            resolveRedirectLocationWithPreservedSearch({
              location: existingLocation,
              requestUrl: requestForRedirect,
            })
          );
        }
        const response = new Response(null, {
          status: resolution.status,
          headers: redirectHeaders,
        });
        return sanitizeProxyResponse(
          applyResolutionToResponse(response, resolution, resolution.status),
          request
        );
      }

      if (resolution.externalRewrite) {
        return proxyRequest(
          request,
          bunServer,
          new URL(resolution.externalRewrite.toString()),
          new Headers(middlewareRequestHeaders ?? sanitizedRequestHeaders),
          resolution,
          false
        );
      }

      if (resolution.middlewareResponded) {
        if (middlewareResponsePayload) {
          return sanitizeProxyResponse(
            applyResolutionToResponse(middlewareResponsePayload, resolution),
            request
          );
        }
        return sanitizeProxyResponse(
          applyResolutionToResponse(
            new Response('Middleware response payload was not provided', {
              status: 500,
              headers: {
                'content-type': 'text/plain; charset=utf-8',
              },
            }),
            resolution,
            500
          ),
          request
        );
      }

      const upstreamRequestUrl = new URL(request.url);
      const literalStatusOverride = getLiteralStatusOverride({
        requestPathname: upstreamRequestUrl.pathname,
        basePath: manifest.build.basePath,
        i18n: manifest.build.i18n,
        hasPrerenderRevalidateHeader: sanitizedRequestHeaders.has(
          'x-prerender-revalidate'
        ),
      });
      const nextImageSourcePathname = resolveNextImageSourcePathname({
        requestPathname: upstreamRequestUrl.pathname,
        searchParams: upstreamRequestUrl.searchParams,
        basePath: manifest.build.basePath,
      });
      const hasNextImageRouteOutput = getLookupPathnameCandidates(
        '/_next/image',
        manifest.build.basePath
      ).some((candidatePathname) => routeOutputsByPathname.has(candidatePathname));
      if (nextImageSourcePathname && !hasNextImageRouteOutput) {
        const nextImageSourceAsset = resolveStaticAssetForPathname({
          pathname: nextImageSourcePathname,
          basePath: manifest.build.basePath,
          staticAssetsByPathname,
        });
        if (
          nextImageSourceAsset &&
          canServeStaticAssetDirectly(nextImageSourceAsset, routeGraph)
        ) {
          const nextImageFallbackResponse = serveStaticAsset(
            request,
            adapterDir,
            nextImageSourceAsset,
            routeGraph
          );
          const nextImageFallbackResolution =
            literalStatusOverride !== null
              ? ({
                  ...resolution,
                  status: literalStatusOverride,
                } satisfies ResolveRoutesResult)
              : resolution;
          return sanitizeProxyResponse(
            applyResolutionToResponse(
              nextImageFallbackResponse,
              nextImageFallbackResolution,
              literalStatusOverride ?? undefined
            ),
            request
          );
        }
      }

      const resolvedResolutionPathname = resolveResolutionPathname(resolution);
      const concreteResolvedPathname = resolveConcretePathnameFromRouteMatches(
        resolvedResolutionPathname,
        resolution.routeMatches
      );
      const hasConcreteResolvedPathname =
        typeof concreteResolvedPathname === 'string' &&
        (routeOutputsByPathname.has(concreteResolvedPathname) ||
          staticAssetsByPathname.has(concreteResolvedPathname) ||
          prerenderArtifactsByPathname.has(concreteResolvedPathname));
      let routeGraphDestinationPathname =
        !hasConcreteResolvedPathname && !resolvedResolutionPathname
          ? extractRouteGraphDestinationPathname({
              requestUrl: upstreamRequestUrl,
              requestHeaders: middlewareRequestHeaders ?? sanitizedRequestHeaders,
              routeGraph,
              routeOutputsByPathname,
              staticAssetsByPathname,
              prerenderArtifactsByPathname,
              basePath: manifest.build.basePath,
            })
          : null;
      if (
        !routeGraphDestinationPathname &&
        !hasConcreteResolvedPathname &&
        !resolvedResolutionPathname
      ) {
        const localePrefixedPathname = maybePrefixDefaultLocalePathname({
          pathname: upstreamRequestUrl.pathname,
          basePath: manifest.build.basePath,
          i18n: manifest.build.i18n,
        });
        if (localePrefixedPathname) {
          const localePrefixedRequestUrl = new URL(upstreamRequestUrl.toString());
          localePrefixedRequestUrl.pathname = localePrefixedPathname;
          routeGraphDestinationPathname = extractRouteGraphDestinationPathname({
            requestUrl: localePrefixedRequestUrl,
            requestHeaders: middlewareRequestHeaders ?? sanitizedRequestHeaders,
            routeGraph,
            routeOutputsByPathname,
            staticAssetsByPathname,
            prerenderArtifactsByPathname,
            basePath: manifest.build.basePath,
          });
        }
      }
      const resolutionPathnameForRouting =
        hasConcreteResolvedPathname
          ? concreteResolvedPathname
          : resolvedResolutionPathname ?? routeGraphDestinationPathname;
      const requestedResolutionPathname = normalizeIndexPathnameAlias(
        resolutionPathnameForRouting,
        routeOutputsByPathname,
        staticAssetsByPathname,
        prerenderArtifactsByPathname
      );
      const isNextDataRequest = isNextDataRequestPath({
        request,
        manifest,
      });
      const isNextDataPathRequest = isNextDataPathname(
        upstreamRequestUrl.pathname,
        manifest
      );
      const nextDataMatchedPathname =
        !requestedResolutionPathname && isNextDataRequest
          ? normalizeIndexPathnameAlias(
              maybeResolveNextDataMatchedPathname({
                request,
                manifest,
                routeOutputsByPathname,
                staticAssetsByPathname,
              }),
              routeOutputsByPathname,
              staticAssetsByPathname,
              prerenderArtifactsByPathname
            )
          : null;
      if (isNextDataRequest && !requestedResolutionPathname && nextDataMatchedPathname) {
        const normalizedDataRewritePathname = resolveNextDataPathnameFromPagePathname(
          nextDataMatchedPathname,
          manifest
        );
        const normalizedResolvedHeaders = new Headers(
          resolution.resolvedHeaders ?? undefined
        );
        normalizedResolvedHeaders.set(
          'x-middleware-rewrite',
          normalizedDataRewritePathname
        );
        normalizedResolvedHeaders.set(
          'x-nextjs-rewrite',
          normalizedDataRewritePathname
        );
        resolution = {
          ...resolution,
          resolvedHeaders: normalizedResolvedHeaders,
        };
        middlewareRewriteUrl = new URL(
          normalizedDataRewritePathname,
          upstreamRequestUrl
        ).toString();
      }
      const effectiveMatchedPathname =
        nextDataMatchedPathname ||
        (requestedResolutionPathname
          ? maybeResolveRscMatchedPathname({
              request,
              matchedPathname: requestedResolutionPathname,
              routeGraph,
              routeOutputsByPathname,
              staticAssetsByPathname,
            })
          : null);
      const normalizedEffectiveMatchedPathname = normalizeIndexPathnameAlias(
        effectiveMatchedPathname,
        routeOutputsByPathname,
        staticAssetsByPathname,
        prerenderArtifactsByPathname
      );
      const decodedRequestPathnameForStaticLookup = (() => {
        const decodedPathname = decodePathnameSegmentsPreservingEncodedSlashes(
          upstreamRequestUrl.pathname
        );
        return decodedPathname === upstreamRequestUrl.pathname
          ? null
          : decodedPathname;
      })();
      const hasEncodedSlashInRequestPathname = /%2f/i.test(
        upstreamRequestUrl.pathname
      );

      const matchedStaticAsset = normalizedEffectiveMatchedPathname
        ? staticAssetsByPathname.get(normalizedEffectiveMatchedPathname) ??
          (decodedRequestPathnameForStaticLookup
            ? staticAssetsByPathname.get(decodedRequestPathnameForStaticLookup)
            : undefined)
        : decodedRequestPathnameForStaticLookup
          ? staticAssetsByPathname.get(decodedRequestPathnameForStaticLookup)
          : undefined;
      const hasMatchedRouteOutput = normalizedEffectiveMatchedPathname
        ? routeOutputsByPathname.has(normalizedEffectiveMatchedPathname)
        : false;
      const shouldPreferPrerenderRscStaticAsset =
        !!matchedStaticAsset &&
        matchedStaticAsset.sourceType === 'prerender' &&
        isRscStaticAssetPath(matchedStaticAsset.pathname, routeGraph) &&
        hasInterceptionMarker(matchedStaticAsset.pathname);
      const isPrerenderRevalidateRequest = request.headers.has(
        'x-prerender-revalidate'
      );
      const shouldServePrerenderNextDataStaticAsset =
        !!matchedStaticAsset &&
        isNextDataPathRequest &&
        request.method === 'GET' &&
        !isPrerenderRevalidateRequest &&
        matchedStaticAsset.sourceType === 'prerender';
      const shouldServeDecodedPrerenderStaticAsset =
        !!matchedStaticAsset &&
        !!decodedRequestPathnameForStaticLookup &&
        (request.method === 'GET' || request.method === 'HEAD') &&
        matchedStaticAsset.sourceType === 'prerender';
      const prerenderArtifact = normalizedEffectiveMatchedPathname
        ? prerenderArtifactsByPathname.get(normalizedEffectiveMatchedPathname)
        : undefined;
      const shouldServeConcretePrerenderStaticAsset =
        !!matchedStaticAsset &&
        matchedStaticAsset.sourceType === 'prerender' &&
        !!prerenderArtifact &&
        prerenderArtifact.parentOutputId !== prerenderArtifact.pathname &&
        (request.method === 'GET' || request.method === 'HEAD');
      if (process.env.ADAPTER_BUN_DEBUG_ROUTING === '1' && isNextDataRequest) {
        console.error('[adapter-bun] next-data static candidate', {
          requestPathname: upstreamRequestUrl.pathname,
          normalizedEffectiveMatchedPathname,
          matchedStaticAssetPathname: matchedStaticAsset?.pathname ?? null,
          matchedStaticAssetSourceType: matchedStaticAsset?.sourceType ?? null,
          hasMatchedRouteOutput,
          shouldServePrerenderNextDataStaticAsset,
        });
      }
      if (
        matchedStaticAsset &&
        (canServeStaticAssetDirectly(matchedStaticAsset, routeGraph) ||
          shouldServePrerenderNextDataStaticAsset ||
          shouldServeDecodedPrerenderStaticAsset ||
          shouldServeConcretePrerenderStaticAsset) &&
        !(hasEncodedSlashInRequestPathname && matchedStaticAsset.sourceType === 'prerender') &&
        !(isPrerenderRevalidateRequest && matchedStaticAsset.sourceType === 'prerender') &&
        (!hasMatchedRouteOutput ||
          shouldPreferPrerenderRscStaticAsset)
      ) {
        const response = serveStaticAsset(
          request,
          adapterDir,
          matchedStaticAsset,
          routeGraph
        );
        if (
          shouldServePrerenderNextDataStaticAsset &&
          !response.headers.has('cache-control')
        ) {
          response.headers.set(
            'cache-control',
            'public, max-age=0, must-revalidate'
          );
        }
        const staticAssetResolution =
          literalStatusOverride !== null
            ? ({
                ...resolution,
                status: literalStatusOverride,
              } satisfies ResolveRoutesResult)
            : resolution;
        return sanitizeProxyResponse(
          applyResolutionToResponse(
            response,
            staticAssetResolution,
            literalStatusOverride ?? undefined
          ),
          request
        );
      }

      const hasExplicitRouteMatch = resolvedResolutionPathname !== null;
      let canUseDynamicRouteFallback = hasExplicitRouteMatch;
      if (!canUseDynamicRouteFallback && nextDataMatchedPathname) {
        const nextDataCandidatePathname = normalizeIndexPathnameAlias(
          nextDataMatchedPathname,
          routeOutputsByPathname,
          staticAssetsByPathname,
          prerenderArtifactsByPathname
        );
        if (nextDataCandidatePathname) {
          canUseDynamicRouteFallback = await canResolvePathnameWithoutMiddleware({
            request,
            pathname: nextDataCandidatePathname,
          });
        }
      }
      if (!canUseDynamicRouteFallback && isNextDataRequest) {
        const nextDataCandidatePathname = normalizeIndexPathnameAlias(
          resolvePagePathnameFromNextDataPathname(
            upstreamRequestUrl.pathname,
            manifest
          ),
          routeOutputsByPathname,
          staticAssetsByPathname,
          prerenderArtifactsByPathname
        );
        if (nextDataCandidatePathname) {
          let dynamicOutput = findDynamicOutputForPathname(
            routeOutputs,
            nextDataCandidatePathname,
            prerenderFallbackFalseByPathname
          );
          if (!dynamicOutput) {
            const localeStrippedNextDataPathname = stripLocaleFromPathname(
              nextDataCandidatePathname,
              manifest.build.i18n
            );
            if (localeStrippedNextDataPathname !== nextDataCandidatePathname) {
              dynamicOutput = findDynamicOutputForPathname(
                routeOutputs,
                localeStrippedNextDataPathname,
                prerenderFallbackFalseByPathname
              );
            }
          }
          canUseDynamicRouteFallback = Boolean(dynamicOutput);
        }
      }

      let routeOutput =
        (normalizedEffectiveMatchedPathname
          ? routeOutputsByPathname.get(normalizedEffectiveMatchedPathname)
          : undefined) ??
        (prerenderArtifact
          ? routeOutputsById.get(prerenderArtifact.parentOutputId)
          : undefined);
      const isApiRequestPath =
        upstreamRequestUrl.pathname === '/api' ||
        upstreamRequestUrl.pathname.startsWith('/api/');
      if (!routeOutput && !hasExplicitRouteMatch && isApiRequestPath) {
        routeOutput = findDynamicOutputForPathname(
          routeOutputs,
          upstreamRequestUrl.pathname,
          prerenderFallbackFalseByPathname
        );
      }

      if (!routeOutput && canUseDynamicRouteFallback && isNextDataRequest) {
        const nextDataDynamicOutputCandidatePathname =
          (normalizedEffectiveMatchedPathname
            ? resolvePagePathnameFromNextDataPathname(
                normalizedEffectiveMatchedPathname,
                manifest
              )
            : null) ??
          resolvePagePathnameFromNextDataPathname(
            upstreamRequestUrl.pathname,
            manifest
          );
        if (nextDataDynamicOutputCandidatePathname) {
          routeOutput = findDynamicOutputForPathname(
            routeOutputs,
            nextDataDynamicOutputCandidatePathname,
            prerenderFallbackFalseByPathname
          );
          if (!routeOutput) {
            const localeStrippedNextDataPagePathname = stripLocaleFromPathname(
              nextDataDynamicOutputCandidatePathname,
              manifest.build.i18n
            );
            if (
              localeStrippedNextDataPagePathname !==
              nextDataDynamicOutputCandidatePathname
            ) {
              routeOutput = findDynamicOutputForPathname(
                routeOutputs,
                localeStrippedNextDataPagePathname,
                prerenderFallbackFalseByPathname
              );
            }
          }
        }
      }

      if (
        !routeOutput &&
        canUseDynamicRouteFallback &&
        normalizedEffectiveMatchedPathname
      ) {
        routeOutput = findDynamicOutputForPathname(
          routeOutputs,
          normalizedEffectiveMatchedPathname,
          prerenderFallbackFalseByPathname
        );
      }

      if (
        !routeOutput &&
        canUseDynamicRouteFallback &&
        requestedResolutionPathname
      ) {
        routeOutput = findDynamicOutputForPathname(
          routeOutputs,
          requestedResolutionPathname,
          prerenderFallbackFalseByPathname
        );
      }

      if (
        routeOutput?.type === 'PAGES' &&
        !hasLocalePrefix(upstreamRequestUrl.pathname, manifest.build.i18n)
      ) {
        const preferredAppRouteOutput = findAppRouteOutputForRequestPathname({
          requestPathname: upstreamRequestUrl.pathname,
          routeOutputsByPathname,
          appRouteOutputs,
          prerenderFallbackFalseByPathname,
        });
        if (preferredAppRouteOutput) {
          routeOutput = preferredAppRouteOutput;
        }
      }

      const isPrerenderPageMethodNotAllowed =
        !isNextDataRequest &&
        request.method !== 'GET' &&
        request.method !== 'HEAD' &&
        routeOutput?.type === 'PAGES' &&
        ((normalizedEffectiveMatchedPathname &&
          (prerenderArtifactsByPathname.has(normalizedEffectiveMatchedPathname) ||
            staticAssetsByPathname.get(normalizedEffectiveMatchedPathname)
              ?.sourceType === 'prerender')) ||
          false);
      if (isPrerenderPageMethodNotAllowed) {
        const methodNotAllowedResponse = new Response('Method Not Allowed', {
          status: 405,
          headers: {
            allow: 'GET, HEAD',
            'content-type': 'text/plain; charset=utf-8',
          },
        });
        return sanitizeProxyResponse(
          applyResolutionToResponse(methodNotAllowedResponse, resolution, 405),
          request
        );
      }

      const shouldBailMiddlewarePrefetch =
        isNextDataRequest &&
        request.headers.get('x-middleware-prefetch') === '1' &&
        routeOutput?.type === 'PAGES' &&
        !prerenderArtifact;
      if (shouldBailMiddlewarePrefetch && routeOutput) {
        const middlewarePrefetchHeaders = new Headers(
          resolution.resolvedHeaders ?? undefined
        );
        middlewarePrefetchHeaders.set('x-nextjs-matched-path', routeOutput.pathname);
        middlewarePrefetchHeaders.set('x-middleware-skip', '1');
        middlewarePrefetchHeaders.set(
          'cache-control',
          'private, no-cache, no-store, max-age=0, must-revalidate'
        );
        middlewarePrefetchHeaders.set(
          'content-type',
          'application/json; charset=utf-8'
        );
        return sanitizeProxyResponse(
          new Response('{}', {
            status: 200,
            headers: middlewarePrefetchHeaders,
          }),
          request
        );
      }

      const resolutionQuery = extractResolutionQuery(resolution);
      let mergedSearchParams = new URLSearchParams(upstreamRequestUrl.searchParams);
      appendQueryObject(mergedSearchParams, resolutionQuery);
      appendQueryObject(
        mergedSearchParams,
        extractRouteGraphDestinationQuery({
          requestUrl: upstreamRequestUrl,
          requestHeaders: middlewareRequestHeaders ?? request.headers,
          routeGraph,
        })
      );
      if (
        routeOutput?.type === 'PAGES_API' &&
        routeOutput.pathname.includes('[')
      ) {
        overwriteQueryObject(
          mergedSearchParams,
          routeMatchesToQueryObject(resolution.routeMatches)
        );
      }
      if (middlewareRewriteUrl) {
        const middlewareRewriteSearchParams = new URL(
          middlewareRewriteUrl,
          upstreamRequestUrl
        ).searchParams;
        // Middleware rewrites provide the authoritative query string.
        mergedSearchParams = new URLSearchParams(middlewareRewriteSearchParams);
      }
      let invocationPathname = resolveInvocationPathname({
        requestPathname: upstreamRequestUrl.pathname,
        matchedPathname: normalizedEffectiveMatchedPathname,
        resolvedPathname: requestedResolutionPathname,
      });
      if (
        requestedResolutionPathname?.includes('[') &&
        middlewareRewriteUrl
      ) {
        invocationPathname = new URL(
          middlewareRewriteUrl,
          upstreamRequestUrl
        ).pathname;
      }
      if (
        !middlewareRewriteUrl &&
        requestedResolutionPathname &&
        requestedResolutionPathname !== upstreamRequestUrl.pathname
      ) {
        invocationPathname = upstreamRequestUrl.pathname;
      }
      if (isNextDataRequest) {
        if (routeOutput?.type === 'APP_PAGE' || routeOutput?.type === 'APP_ROUTE') {
          invocationPathname = routeOutput.pathname;
        } else {
          invocationPathname = resolveNextDataInvocationPathname({
            requestPathname: upstreamRequestUrl.pathname,
            middlewareRewriteUrl,
            requestedResolutionPathname,
            upstreamRequestUrl,
            manifest,
          });
        }
      }
      if (
        routeOutput &&
        routeOutput.pathname.includes('[') &&
        decodedRequestPathnameForStaticLookup &&
        invocationPathname === upstreamRequestUrl.pathname
      ) {
        invocationPathname = decodedRequestPathnameForStaticLookup;
      }
      if (!routeOutput) {
        const invocationAliasPathname = normalizeIndexPathnameAlias(
          invocationPathname,
          routeOutputsByPathname,
          staticAssetsByPathname,
          prerenderArtifactsByPathname
        );
        if (invocationAliasPathname) {
          routeOutput =
            routeOutputsByPathname.get(invocationAliasPathname) ??
            (canUseDynamicRouteFallback
              ? findDynamicOutputForPathname(
                  routeOutputs,
                  invocationAliasPathname,
                  prerenderFallbackFalseByPathname
                )
              : undefined);
        }
      }
      if (isNextDataRequest && routeOutput?.type === 'PAGES_API') {
        routeOutput = undefined;
      }
      if (!routeOutput) {
        const invocationStaticPathname = normalizeIndexPathnameAlias(
          invocationPathname,
          routeOutputsByPathname,
          staticAssetsByPathname,
          prerenderArtifactsByPathname
        );
        const invocationStaticAsset = invocationStaticPathname
          ? staticAssetsByPathname.get(invocationStaticPathname)
          : undefined;
        if (
          invocationStaticAsset &&
          canServeStaticAssetDirectly(invocationStaticAsset, routeGraph) &&
          !(
            /%2f/i.test(invocationPathname) &&
            invocationStaticAsset.sourceType === 'prerender'
          ) &&
          !(invocationStaticPathname && routeOutputsByPathname.has(invocationStaticPathname))
        ) {
          const response = serveStaticAsset(
            request,
            adapterDir,
            invocationStaticAsset,
            routeGraph
          );
          const staticAssetResolution =
            literalStatusOverride !== null
              ? ({
                  ...resolution,
                  status: literalStatusOverride,
                } satisfies ResolveRoutesResult)
              : resolution;
          return sanitizeProxyResponse(
            applyResolutionToResponse(
              response,
              staticAssetResolution,
              literalStatusOverride ?? undefined
            ),
            request
          );
        }
      }
      const realRequestPathname = getRealRequestPathnameForNotFound({
        requestPathname: upstreamRequestUrl.pathname,
        basePath: manifest.build.basePath,
        assetPrefix: runtimeNextConfig.assetPrefix,
        i18n: manifest.build.i18n,
      });
      if (
        !routeOutput &&
        realRequestPathname.startsWith('/_next/static/')
      ) {
        const staticAssetNotFoundResolution = ({
          ...resolution,
          status: 404,
        } satisfies ResolveRoutesResult);
        const staticAssetNotFoundResponse = new Response('Not Found', {
          status: 404,
          headers: {
            'cache-control':
              'private, no-cache, no-store, max-age=0, must-revalidate',
            'content-type': 'text/plain; charset=utf-8',
          },
        });
        return sanitizeProxyResponse(
          applyResolutionToResponse(
            staticAssetNotFoundResponse,
            staticAssetNotFoundResolution,
            404
          ),
          request
        );
      }
      if (
        isNextDataRequest &&
        routeOutput &&
        (routeOutput.type === 'PAGES' || routeOutput.type === 'PAGES_API') &&
        routeOutput.pathname.includes('[')
      ) {
        const invocationParamPathnameCandidates: string[] = [];
        const nextDataInvocationPagePathname = resolvePagePathnameFromNextDataPathname(
          invocationPathname,
          manifest
        );
        if (nextDataInvocationPagePathname) {
          invocationParamPathnameCandidates.push(nextDataInvocationPagePathname);
          const localeStrippedPathname = stripLocaleFromPathname(
            nextDataInvocationPagePathname,
            manifest.build.i18n
          );
          if (localeStrippedPathname !== nextDataInvocationPagePathname) {
            invocationParamPathnameCandidates.push(localeStrippedPathname);
          }
        } else {
          invocationParamPathnameCandidates.push(invocationPathname);
        }

        for (const candidatePathname of invocationParamPathnameCandidates) {
          const invocationPathParams = extractRouteParamsFromPathname(
            routeOutput.pathname,
            candidatePathname
          );
          if (!invocationPathParams) {
            continue;
          }
          overwriteQueryObject(
            mergedSearchParams,
            routeParamsToQueryObject(invocationPathParams)
          );
          break;
        }
      }
      const mergedSearch = mergedSearchParams.toString();
      const invocationSourceHeaders = middlewareRequestHeaders
        ? new Headers(middlewareRequestHeaders)
        : new Headers(sanitizedRequestHeaders);
      const isErrorFallback =
        !routeOutput &&
        literalStatusOverride === 500 &&
        typeof serverErrorRouteOutput !== 'undefined';
      if (!routeOutput && literalStatusOverride === 500 && serverErrorRouteOutput) {
        routeOutput = serverErrorRouteOutput;
      }
      const isNotFoundFallback =
        !routeOutput && typeof notFoundRouteOutput !== 'undefined';
      if (!routeOutput && notFoundRouteOutput) {
        routeOutput = notFoundRouteOutput;
      }
      const fallbackStatusOverride =
        literalStatusOverride ??
        (isErrorFallback ? 500 : isNotFoundFallback ? 404 : null);
      let invocationResolution =
        fallbackStatusOverride !== null
          ? ({
              ...resolution,
              status: fallbackStatusOverride,
            } satisfies ResolveRoutesResult)
          : resolution;
      if (isNextDataRequest && middlewareRewriteUrl) {
        try {
          const rewriteUrl = new URL(middlewareRewriteUrl, upstreamRequestUrl);
          const rewrittenPagePathname =
            resolvePagePathnameFromNextDataPathname(
              rewriteUrl.pathname,
              manifest
            ) ?? rewriteUrl.pathname;
          const rewriteValue = `${rewrittenPagePathname}${rewriteUrl.search}`;
          const resolvedHeaders = new Headers(
            invocationResolution.resolvedHeaders ?? undefined
          );
          if (
            routeOutput &&
            (routeOutput.type === 'APP_PAGE' || routeOutput.type === 'APP_ROUTE')
          ) {
            resolvedHeaders.set('x-nextjs-redirect', rewriteValue);
            resolvedHeaders.delete('x-nextjs-rewrite');
            resolvedHeaders.delete('x-middleware-rewrite');
          } else if (!resolvedHeaders.has('x-nextjs-rewrite')) {
            resolvedHeaders.set('x-nextjs-rewrite', rewriteValue);
          }
          invocationResolution = {
            ...invocationResolution,
            resolvedHeaders,
          };
        } catch {
          // Ignore malformed middleware rewrite URLs and continue with
          // unmodified resolution headers.
        }
      }
      if (!routeOutput && literalStatusOverride !== 500) {
        const notFoundStaticAsset = resolveNotFoundStaticAsset(
          staticAssetsByPathname,
          manifest.build.basePath,
          manifest.build.i18n
        );
        if (
          notFoundStaticAsset &&
          canServeStaticAssetDirectly(notFoundStaticAsset, routeGraph)
        ) {
          const response = serveStaticAsset(
            request,
            adapterDir,
            notFoundStaticAsset,
            routeGraph
          );
          return sanitizeProxyResponse(
            applyResolutionToResponse(response, invocationResolution, 404),
            request
          );
        }
      }
      let effectiveInvocationPathname =
        (isErrorFallback || isNotFoundFallback) && routeOutput
          ? routeOutput.pathname
          : invocationPathname;
      const isRscRequest =
        request.headers.get(routeGraph.rsc.header) === '1';
      if (
        routeOutput &&
        isRscRequest &&
        routeOutput.pathname.endsWith(routeGraph.rsc.suffix) &&
        !routeOutput.pathname.includes('[') &&
        !hasInterceptionMarker(routeOutput.pathname)
      ) {
        effectiveInvocationPathname = routeOutput.pathname;
      }
      const invocationRouteMatches =
        routeOutput && routeOutput.pathname.includes('[')
          ? resolution.routeMatches
          : undefined;
      const normalizedInvocationRouteMatches =
        normalizeResolutionRouteMatches(invocationRouteMatches);
      const edgeInvocationParams =
        routeOutput && routeOutput.pathname.includes('[')
          ? mergeRouteParams(
              normalizeRouteParams(
                routeOutput.pathname,
                invocationRouteMatches
              ),
              extractRouteParamsFromPathname(
                routeOutput.pathname,
                effectiveInvocationPathname
              )
            )
          : undefined;

      if (process.env.ADAPTER_BUN_DEBUG_ROUTING === '1') {
        console.error('[adapter-bun] routing resolution', {
          requestPathname: upstreamRequestUrl.pathname,
          isNextDataRequest,
          requestedResolutionPathname,
          normalizedEffectiveMatchedPathname,
          invocationPathname: effectiveInvocationPathname,
          routeOutputPathname: routeOutput?.pathname,
          routeOutputType: routeOutput?.type,
          routeOutputRuntime: routeOutput?.runtime,
          resolutionRouteMatches: invocationRouteMatches ?? null,
          resolutionStatus: resolution.status ?? null,
          middlewareRewriteUrl,
        });
      }

      if (routeOutput?.runtime === 'edge') {
        const edgeHandler = await getEdgeRouteHandler(routeOutput);
        const invocationUrl = new URL(
          effectiveInvocationPathname,
          upstreamRequestUrl.origin
        );
        const edgeInvocationSearchParams = new URLSearchParams(mergedSearchParams);
        if (routeOutput.pathname.includes('[')) {
          overwriteQueryObject(
            edgeInvocationSearchParams,
            routeMatchesToQueryObject(invocationRouteMatches)
          );
          overwriteQueryObject(
            edgeInvocationSearchParams,
            routeParamsToQueryObject(edgeInvocationParams)
          );
        }
        const edgeInvocationSearch = edgeInvocationSearchParams.toString();
        invocationUrl.search =
          edgeInvocationSearch.length > 0 ? `?${edgeInvocationSearch}` : '';

        const edgeRequestHeaders = new Headers(invocationSourceHeaders);
        const requestHostHeader = invocationSourceHeaders.get('host');
        if (requestHostHeader && !edgeRequestHeaders.has('x-forwarded-host')) {
          edgeRequestHeaders.set('x-forwarded-host', requestHostHeader);
        }
        if (!edgeRequestHeaders.has('x-forwarded-proto')) {
          edgeRequestHeaders.set('x-forwarded-proto', upstreamRequestUrl.protocol.slice(0, -1));
        }
        if (!edgeRequestHeaders.has('x-forwarded-port')) {
          edgeRequestHeaders.set('x-forwarded-port', getForwardedPort(upstreamRequestUrl));
        }

        const edgeRequest = new Request(invocationUrl.toString(), {
          method: request.method,
          headers: edgeRequestHeaders,
          body: shouldSendRequestBody(request.method) ? request.body : undefined,
          signal: request.signal,
          redirect: 'manual',
        });

        const edgeResponseValue = await edgeHandler(edgeRequest, {
          waitUntil: (promise) => {
            promise.catch((error) => {
              console.error('[adapter-bun] edge waitUntil errored:', error);
            });
          },
          signal: request.signal,
          requestMeta: {
            outputId: routeOutput.id,
            source: isNotFoundFallback
              ? 'not-found'
              : isErrorFallback
                ? 'error'
              : prerenderArtifact
                ? 'prerender-parent'
                : 'function',
            matchedPathname: normalizedEffectiveMatchedPathname ?? undefined,
            routeMatches: invocationRouteMatches ?? undefined,
            ...(edgeInvocationParams ? { params: edgeInvocationParams } : {}),
            query: searchParamsToQueryObject(edgeInvocationSearchParams),
            resolvedPathname: requestedResolutionPathname ?? undefined,
          },
        });

        let edgeResponse = normalizeEdgeResponseEncoding(
          await toResponse(edgeResponseValue)
        );
        if (
          shouldBufferEdgeResponseForCrawler(request) &&
          edgeResponse.body !== null
        ) {
          const bufferedBody = await edgeResponse.arrayBuffer();
          const bufferedHeaders = new Headers(edgeResponse.headers);
          bufferedHeaders.set('content-length', String(bufferedBody.byteLength));
          edgeResponse = new Response(bufferedBody, {
            status: edgeResponse.status,
            statusText: edgeResponse.statusText,
            headers: bufferedHeaders,
          });
        }
        return sanitizeProxyResponse(
          applyResolutionToResponse(edgeResponse, invocationResolution),
          request
        );
      }

      if (routeOutput) {
        const extraHeaders = new Headers();
        extraHeaders.set('x-bun-output-pathname', routeOutput.pathname);
        extraHeaders.set(
          'x-bun-invoke-meta',
          encodeRouteInvocationMeta({
            originalUrl: upstreamRequestUrl.toString(),
            resolvedPathname: requestedResolutionPathname ?? undefined,
            routeMatches: invocationRouteMatches,
            source: isNotFoundFallback
              ? 'not-found'
              : isErrorFallback
                ? 'error'
                : undefined,
          })
        );

        const internalUrl = new URL(effectiveInvocationPathname, backendOrigin);
        internalUrl.search = mergedSearch.length > 0 ? `?${mergedSearch}` : '';
        const response = await proxyRequest(
          request,
          bunServer,
          internalUrl,
          invocationSourceHeaders,
          invocationResolution,
          true,
          extraHeaders
        );
        if (
          response.status === 404 &&
          (request.method === 'GET' || request.method === 'HEAD') &&
          matchedStaticAsset &&
          matchedStaticAsset.sourceType === 'prerender'
        ) {
          const prerenderFallbackResponse = serveStaticAsset(
            request,
            adapterDir,
            matchedStaticAsset,
            routeGraph
          );
          return sanitizeProxyResponse(
            applyResolutionToResponse(prerenderFallbackResponse, invocationResolution),
            request
          );
        }
        const shouldRenderNotFoundFallback =
          routeOutput.type === 'PAGES' &&
          notFoundRouteOutput?.runtime === 'nodejs' &&
          notFoundRouteOutput.pathname !== routeOutput.pathname &&
          response.status === 404 &&
          response.headers
            .get('content-type')
            ?.toLowerCase()
            .startsWith('text/plain') === true &&
          isDocumentNavigationRequest(request);
        if (shouldRenderNotFoundFallback && notFoundRouteOutput) {
          const notFoundHeaders = new Headers();
          notFoundHeaders.set('x-bun-output-pathname', notFoundRouteOutput.pathname);
          notFoundHeaders.set(
            'x-bun-invoke-meta',
            encodeRouteInvocationMeta({
              originalUrl: upstreamRequestUrl.toString(),
              resolvedPathname: requestedResolutionPathname ?? undefined,
              source: 'not-found',
            })
          );
          const notFoundInternalUrl = new URL(
            notFoundRouteOutput.pathname,
            backendOrigin
          );
          notFoundInternalUrl.search = mergedSearch.length > 0 ? `?${mergedSearch}` : '';
          return proxyRequest(
            request,
            bunServer,
            notFoundInternalUrl,
            invocationSourceHeaders,
            invocationResolution,
            true,
            notFoundHeaders
          );
        }

        return response;
      }

      if (
        hasOutputPathname(routeOutputsByPathname, '/') &&
        effectiveInvocationPathname === '/' &&
        !routeOutputsByPathname.has('/index')
      ) {
        const rootOutput = routeOutputsByPathname.get('/');
        if (rootOutput) {
          const extraHeaders = new Headers();
          extraHeaders.set('x-bun-output-pathname', rootOutput.pathname);
          extraHeaders.set(
            'x-bun-invoke-meta',
            encodeRouteInvocationMeta({
              originalUrl: upstreamRequestUrl.toString(),
              resolvedPathname: requestedResolutionPathname ?? undefined,
              routeMatches: rootOutput.pathname.includes('[')
                ? resolution.routeMatches
                : undefined,
              source: isNotFoundFallback
                ? 'not-found'
                : isErrorFallback
                  ? 'error'
                  : undefined,
            })
          );
          const internalUrl = new URL('/', backendOrigin);
          internalUrl.search = mergedSearch.length > 0 ? `?${mergedSearch}` : '';
          return proxyRequest(
            request,
            bunServer,
            internalUrl,
            invocationSourceHeaders,
            resolution,
            true,
            extraHeaders
          );
        }
      }

      const notFoundResponse = new Response('This page could not be found', {
        status: fallbackStatusOverride ?? resolution.status ?? 404,
        headers: {
          'content-type': 'text/plain; charset=utf-8',
        },
      });
      return sanitizeProxyResponse(
        applyResolutionToResponse(
          notFoundResponse,
          invocationResolution,
          fallbackStatusOverride ?? resolution.status ?? 404
        ),
        request
      );
    },
    error(error) {
      console.error('[adapter-bun] error handling request:', error);
      return new Response('Internal Server Error', {
        status: 500,
        headers: {
          'content-type': 'text/plain; charset=utf-8',
        },
      });
    },
  });

  void server;
  console.log(
    `\n  Next.js (\x1b[36m${manifest.build.nextVersion}\x1b[0m) \x1b[2m|\x1b[0m adapter-bun\n` +
      `  Listening on http://${listenHostname}:${port}\n` +
      `  Build ID: ${manifest.build.buildId}\n`
  );
}
