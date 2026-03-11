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
};
type EdgeGlobalCacheHandlers = {
  FetchCache?: unknown;
  DefaultCache?: unknown;
  RemoteCache?: unknown;
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
      headers.set(key, value);
    }
  }

  return new Response(response.body, {
    status: nextStatus,
    statusText: response.statusText,
    headers,
  });
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
  const candidatePaths: string[] = [];

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
  const pushPath = (moduleRelativePath: string | undefined): void => {
    if (!moduleRelativePath || moduleRelativePath.length === 0) {
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
    pushPath(moduleRelativePath);
  }
  for (const moduleRelativePath of wrapperAssetPaths) {
    pushPath(moduleRelativePath);
  }
  pushPath(artifact.filePath);

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
  const basePath =
    manifest.build.basePath && manifest.build.basePath !== '/'
      ? manifest.build.basePath
      : '';
  const dataPrefix = `${basePath}/_next/data/${manifest.build.buildId}/`;

  if (
    !requestUrl.pathname.startsWith(dataPrefix) ||
    !requestUrl.pathname.endsWith('.json')
  ) {
    return null;
  }

  let pathname = requestUrl.pathname.slice(dataPrefix.length, -'.json'.length);
  pathname = pathname === 'index' ? '' : pathname.replace(/\/index$/, '');

  const resolvedPathname =
    `${basePath}/${pathname}`.replace(/\/+/g, '/').replace(/\/$/, '') || '/';
  if (
    routeOutputsByPathname.has(resolvedPathname) ||
    staticAssetsByPathname.has(resolvedPathname)
  ) {
    return resolvedPathname;
  }

  return null;
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

  const hasRootPathname =
    routeOutputsByPathname.has('/') ||
    staticAssetsByPathname.has('/') ||
    prerenderArtifactsByPathname.has('/');
  const hasIndexPathname =
    routeOutputsByPathname.has('/index') ||
    staticAssetsByPathname.has('/index') ||
    prerenderArtifactsByPathname.has('/index');

  if (pathname === '/index' && hasRootPathname) {
    return '/';
  }

  if (pathname === '/' && !hasRootPathname && hasIndexPathname) {
    return '/index';
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

function appendSearchParams(
  target: URLSearchParams,
  source: URLSearchParams
): void {
  for (const [key, value] of source.entries()) {
    target.append(key, value);
  }
}

function extractRouteGraphDestinationQuery({
  requestUrl,
  routeGraph,
}: {
  requestUrl: URL;
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
        continue;
      }
      if (
        Array.isArray((route as { missing?: unknown[] }).missing) &&
        ((route as { missing?: unknown[] }).missing?.length ?? 0) > 0
      ) {
        continue;
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

  if (candidate.includes('[')) {
    return requestPathname;
  }

  if (candidate === '/index' && requestPathname === '/') {
    return '/';
  }

  return candidate;
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
    const key = rawKey.startsWith('nxtP') ? rawKey.slice('nxtP'.length) : rawKey;
    const catchAllPattern = `[...${key}]`;
    const optionalCatchAllPattern = `[[...${key}]]`;
    if (
      pathnameTemplate.includes(optionalCatchAllPattern) ||
      pathnameTemplate.includes(catchAllPattern)
    ) {
      normalized[key] = value.length > 0 ? value.split('/') : [];
    } else {
      normalized[key] = value;
    }
  }

  return Object.keys(normalized).length > 0 ? normalized : undefined;
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
    const concreteSegment = concreteSegments[concreteIndex];

    if (
      templateSegment.startsWith('[[...') &&
      templateSegment.endsWith(']]')
    ) {
      const key = templateSegment.slice('[[...'.length, -']]'.length);
      params[key] = concreteSegments.slice(concreteIndex);
      concreteIndex = concreteSegments.length;
      break;
    }

    if (templateSegment.startsWith('[...') && templateSegment.endsWith(']')) {
      const key = templateSegment.slice('[...'.length, -']'.length);
      if (concreteIndex >= concreteSegments.length) {
        return undefined;
      }
      params[key] = concreteSegments.slice(concreteIndex);
      concreteIndex = concreteSegments.length;
      break;
    }

    if (templateSegment.startsWith('[') && templateSegment.endsWith(']')) {
      if (concreteSegment === undefined) {
        return undefined;
      }
      const key = templateSegment.slice(1, -1);
      params[key] = concreteSegment;
      concreteIndex += 1;
      continue;
    }

    if (templateSegment !== concreteSegment) {
      return undefined;
    }
    concreteIndex += 1;
  }

  if (concreteIndex !== concreteSegments.length) {
    return undefined;
  }

  return Object.keys(params).length > 0 ? params : undefined;
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
  return getRequestUserAgent(request).includes('node-fetch');
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

function sanitizeProxyResponse(response: Response, request: Request): Response {
  const headers = new Headers(response.headers);
  headers.delete('connection');
  headers.delete('keep-alive');
  headers.delete('transfer-encoding');
  headers.delete('x-next-cache-tags');

  if (shouldForceConnectionClose(request)) {
    headers.set('connection', 'close');
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function buildStaticAssetHeaders(
  file: Bun.BunFile,
  asset: BunDeploymentManifest['staticAssets'][number]
): Headers {
  const headers = new Headers(asset.headers);
  if (asset.cacheControl) {
    headers.set('cache-control', asset.cacheControl);
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

function serveStaticAsset(
  request: Request,
  adapterDir: string,
  asset: BunDeploymentManifest['staticAssets'][number],
  routeGraph: BunDeploymentManifest['routeGraph']
): Response {
  const file = Bun.file(path.join(adapterDir, asset.stagedPath));
  const headers = buildStaticAssetHeaders(file, asset);

  if (isRscStaticAssetPath(asset.pathname, routeGraph)) {
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

function hasOutputPathname(
  routeOutputsByPathname: Map<string, BunRouteArtifact>,
  pathname: string
): boolean {
  return routeOutputsByPathname.has(pathname);
}

function normalizePathnameForFallbackMatch(pathname: string): string {
  if (pathname === '/') {
    return pathname;
  }
  return pathname.endsWith('/') ? pathname.slice(0, -1) : pathname;
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

function resolveNotFoundRouteOutput(
  routeOutputsByPathname: Map<string, BunRouteArtifact>
): BunRouteArtifact | undefined {
  return (
    routeOutputsByPathname.get('/_not-found') ??
    routeOutputsByPathname.get('/404') ??
    routeOutputsByPathname.get('/_error')
  );
}

function resolveServerErrorRouteOutput(
  routeOutputsByPathname: Map<string, BunRouteArtifact>
): BunRouteArtifact | undefined {
  return (
    routeOutputsByPathname.get('/500') ??
    routeOutputsByPathname.get('/_error')
  );
}

function trimBasePath(pathname: string, basePath: string): string {
  const normalizedBasePath =
    typeof basePath === 'string' && basePath !== '/' ? basePath : '';
  if (!normalizedBasePath || !pathname.startsWith(normalizedBasePath)) {
    return pathname;
  }
  const withoutBasePath = pathname.slice(normalizedBasePath.length);
  return withoutBasePath.length > 0 ? withoutBasePath : '/';
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
  const runtimeDistDir = path.isAbsolute(runtimeNextConfig.distDir)
    ? runtimeNextConfig.distDir
    : path.join(projectDir, runtimeNextConfig.distDir);
  const relativeProjectDir = path.relative(process.cwd(), projectDir);
  const projectRequire = createRequire(path.join(projectDir, 'package.json'));

  const routeGraph = manifest.routeGraph;
  const routeOutputsById = new Map(manifest.routeOutputs.map((output) => [output.id, output]));
  const routeOutputsByPathname = new Map(
    manifest.routeOutputs.map((output) => [output.pathname, output])
  );
  const prerenderArtifactsByPathname = new Map(
    (manifest.prerenderArtifacts ?? []).map((artifact) => [artifact.pathname, artifact])
  );
  const prerenderFallbackFalseByPathname = buildPrerenderFallbackFalseByPathname(
    manifest.prerenderFallbackFalseMap
  );
  const staticAssetsByPathname = new Map(
    (manifest.staticAssets ?? []).map((asset) => [asset.pathname, asset])
  );
  const notFoundRouteOutput = resolveNotFoundRouteOutput(routeOutputsByPathname);
  const serverErrorRouteOutput = resolveServerErrorRouteOutput(
    routeOutputsByPathname
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
      if (!middleware || middleware.runtime !== 'edge') {
        return null;
      }

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
    const initUrl = invocationMeta?.originalUrl
      ? new URL(invocationMeta.originalUrl)
      : requestUrl;
    const extractedParams =
      normalizeRouteParams(routeOutput.pathname, invocationMeta?.routeMatches) ??
      extractRouteParamsFromPathname(routeOutput.pathname, requestUrl.pathname);

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
      ...(requestUrl.pathname.includes('/_next/data/')
        ? { isNextDataReq: true }
        : {}),
      ...(!routeOutput.pathname.includes('[') &&
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
  const routerServerContext =
    globalThis as typeof globalThis & {
      [key: symbol]: Record<
        string,
        {
          render404?: (
            req: http.IncomingMessage,
            res: http.ServerResponse
          ) => Promise<void>;
        }
      >;
    };
  routerServerContext[routerServerMethodsSymbol] ??= {};
  routerServerContext[routerServerMethodsSymbol]['.'] = {
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

      invocationMeta = decodeRouteInvocationMeta(
        getSingleHeaderValue(req.headers['x-bun-invoke-meta'])
      );
      delete req.headers['x-bun-invoke-meta'];

      await prepareActionRequestBodyForBun(req);
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

    const response = await fetch(upstreamUrl, {
      method: request.method,
      headers: proxyHeaders,
      body: shouldSendRequestBody(request.method) ? request.body : undefined,
      redirect: 'manual',
      signal: request.signal,
    });

    return sanitizeProxyResponse(
      applyResolutionToResponse(response, resolution),
      request
    );
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
      const requestForResolution = shouldSendRequestBody(request.method)
        ? request.clone()
        : request;
      let middlewareRequestHeaders: Headers | null = null;
      let middlewareRewriteUrl: string | null = null;
      let middlewareResponsePayload: Response | null = null;

      const unresolvedResolution = await resolveRoutes({
        url: new URL(requestForResolution.url),
        buildId: manifest.build.buildId,
        basePath: manifest.build.basePath,
        requestBody: requestForResolution.body ?? createEmptyBodyStream(),
        headers: new Headers([...requestForResolution.headers.entries()]),
        pathnames: manifest.pathnames,
        i18n: toResolutionI18nConfig(manifest),
        routes: routeGraph,
        invokeMiddleware: async ({ url, headers, requestBody }) => {
          const middlewareHandler = await getMiddlewareHandler();
          if (!middlewareHandler) {
            return {};
          }

          const middlewareRequest = new Request(url.toString(), {
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
              pathname: url.pathname,
            },
          });

          const middlewareResponse = await toResponse(middlewareResult);
          const middlewareResolved = responseToMiddlewareResult(
            middlewareResponse,
            new Headers(headers),
            url
          );
          if (middlewareResolved.bodySent) {
            middlewareResponsePayload = middlewareResponse;
          }
          if (middlewareResolved.requestHeaders) {
            middlewareRequestHeaders = new Headers(
              middlewareResolved.requestHeaders
            );
          }
          if (middlewareResolved.rewrite) {
            middlewareRewriteUrl = middlewareResolved.rewrite.toString();
          }
          return middlewareResolved;
        },
      });

      const resolution = stripMiddlewareResponse(
        unresolvedResolution as unknown as JsonRecord
      ) as ResolveRoutesResult;

      if (resolution.redirect) {
        const response = new Response(null, {
          status: resolution.redirect.status,
          headers: {
            location: resolution.redirect.url.toString(),
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
        const response = new Response(null, {
          status: resolution.status,
          headers: resolution.resolvedHeaders ?? undefined,
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
          new Headers(request.headers),
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
        hasPrerenderRevalidateHeader: request.headers.has(
          'x-prerender-revalidate'
        ),
      });

      const resolvedResolutionPathname = resolveResolutionPathname(resolution);
      const requestedResolutionPathname = normalizeIndexPathnameAlias(
        resolvedResolutionPathname,
        routeOutputsByPathname,
        staticAssetsByPathname,
        prerenderArtifactsByPathname
      );
      const nextDataMatchedPathname =
        !requestedResolutionPathname
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

      const matchedStaticAsset = normalizedEffectiveMatchedPathname
        ? staticAssetsByPathname.get(normalizedEffectiveMatchedPathname)
        : undefined;
      const hasMatchedRouteOutput = normalizedEffectiveMatchedPathname
        ? routeOutputsByPathname.has(normalizedEffectiveMatchedPathname)
        : false;
      if (
        matchedStaticAsset &&
        canServeStaticAssetDirectly(matchedStaticAsset, routeGraph) &&
        !hasMatchedRouteOutput
      ) {
        const response = serveStaticAsset(
          request,
          adapterDir,
          matchedStaticAsset,
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

      const prerenderArtifact = normalizedEffectiveMatchedPathname
        ? prerenderArtifactsByPathname.get(normalizedEffectiveMatchedPathname)
        : undefined;
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

      let routeOutput =
        (normalizedEffectiveMatchedPathname
          ? routeOutputsByPathname.get(normalizedEffectiveMatchedPathname)
          : undefined) ??
        (prerenderArtifact
          ? routeOutputsById.get(prerenderArtifact.parentOutputId)
          : undefined);

      if (
        !routeOutput &&
        canUseDynamicRouteFallback &&
        normalizedEffectiveMatchedPathname
      ) {
        routeOutput = findDynamicOutputForPathname(
          manifest.routeOutputs,
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
          manifest.routeOutputs,
          requestedResolutionPathname,
          prerenderFallbackFalseByPathname
        );
      }

      const resolutionQuery = extractResolutionQuery(resolution);
      const mergedSearchParams = new URLSearchParams(upstreamRequestUrl.searchParams);
      appendQueryObject(mergedSearchParams, resolutionQuery);
      appendQueryObject(
        mergedSearchParams,
        extractRouteGraphDestinationQuery({
          requestUrl: upstreamRequestUrl,
          routeGraph,
        })
      );
      if (middlewareRewriteUrl) {
        const middlewareRewriteSearchParams = new URL(
          middlewareRewriteUrl,
          upstreamRequestUrl
        ).searchParams;
        appendSearchParams(mergedSearchParams, middlewareRewriteSearchParams);
      }
      const invocationPathname = resolveInvocationPathname({
        requestPathname: upstreamRequestUrl.pathname,
        matchedPathname: normalizedEffectiveMatchedPathname,
        resolvedPathname: requestedResolutionPathname,
      });
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
                  manifest.routeOutputs,
                  invocationAliasPathname,
                  prerenderFallbackFalseByPathname
                )
              : undefined);
        }
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
      const mergedSearch = mergedSearchParams.toString();
      const invocationSourceHeaders = middlewareRequestHeaders
        ? new Headers(middlewareRequestHeaders)
        : new Headers(request.headers);
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
      const invocationResolution =
        fallbackStatusOverride !== null
          ? ({
              ...resolution,
              status: fallbackStatusOverride,
            } satisfies ResolveRoutesResult)
          : resolution;

      if (routeOutput?.runtime === 'edge') {
        const edgeHandler = await getEdgeRouteHandler(routeOutput);
        const invocationUrl = new URL(invocationPathname, upstreamRequestUrl.origin);
        invocationUrl.search = mergedSearch.length > 0 ? `?${mergedSearch}` : '';

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
            routeMatches: resolution.routeMatches ?? null,
            query: searchParamsToQueryObject(mergedSearchParams),
            resolvedPathname: requestedResolutionPathname ?? undefined,
          },
        });

        return sanitizeProxyResponse(
          applyResolutionToResponse(
            await toResponse(edgeResponseValue),
            invocationResolution
          ),
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
            routeMatches: resolution.routeMatches,
          })
        );

        const internalUrl = new URL(invocationPathname, backendOrigin);
        internalUrl.search = mergedSearch.length > 0 ? `?${mergedSearch}` : '';

        return proxyRequest(
          request,
          bunServer,
          internalUrl,
          invocationSourceHeaders,
          invocationResolution,
          true,
          extraHeaders
        );
      }

      if (
        hasOutputPathname(routeOutputsByPathname, '/') &&
        invocationPathname === '/' &&
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
              routeMatches: resolution.routeMatches,
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
