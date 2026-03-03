import type { MiddlewareResult } from '@next/routing';
import { resolveRoutes } from './next-routing.ts';
import type {
  BunDeploymentManifest,
  BunFunctionArtifact,
  BunPrerenderSeed,
  BunStaticAsset,
} from '../types.ts';
import {
  createImageCacheKey,
  defaultShouldCacheImageResponse,
  evaluateImageCacheEntry,
  imageCacheEntryToResponse,
  isImageOptimizationPath,
  responseToImageCacheEntry,
  shouldBypassImageCache,
  toImageRoutePath,
} from './image.ts';
import {
  NEXT_CACHE_TAGS_HEADER,
  applyPrerenderResumeHeaders,
  createPrerenderCacheKey,
  evaluatePrerenderTagManifestState,
  evaluatePrerenderCacheEntry,
  isPrerenderResumeRequest,
  filterPrerenderRequestByAllowLists,
  parseCacheTagsHeader,
  prerenderCacheEntryToResponse,
  responseToPrerenderCacheEntry,
  resolvePrerenderResumePath,
  shouldBypassPrerenderCache,
  toImplicitPathTags,
  type PrerenderCacheState,
  type PrerenderRevalidateReason,
  type PrerenderRevalidateTask,
  type PrerenderRevalidateTarget,
} from './isr.ts';
import type {
  RouterRouteKind,
  RouterRuntime,
  RouterRuntimeOptions,
  RouteResolutionResult,
  RouterMiddlewareResult,
} from './types.ts';

const IMPLICIT_IMMUTABLE_CACHE_CONTROL = 'public,max-age=31536000,immutable';
const DOCUMENT_RESPONSE_CACHE_CONTROL = 'public, max-age=0, must-revalidate';
const DEFAULT_RSC_VARY_HEADER =
  'rsc, next-router-state-tree, next-router-prefetch, next-router-segment-prefetch';
const INTERNAL_MIDDLEWARE_REQUEST_HEADERS = new Set([
  'rsc',
  'next-router-state-tree',
  'next-router-prefetch',
  'next-hmr-refresh',
  'next-router-segment-prefetch',
]);
const UNTRUSTED_MIDDLEWARE_REQUEST_HEADERS = new Set([
  'x-middleware-set-cookie',
  'x-middleware-override-headers',
  'x-middleware-rewrite',
  'x-middleware-next',
  'x-middleware-redirect',
  'x-middleware-refresh',
]);
const UNTRUSTED_MIDDLEWARE_REQUEST_HEADER_PREFIXES = ['x-middleware-request-'];
const STATIC_FILE_EXTENSION_PATTERN =
  /\.(?:avif|bmp|css|gif|ico|jpe?g|js|json|map|mjs|png|svg|txt|webmanifest|webp|woff2?|xml)$/i;
const SERVER_CLIENT_MODULE_EXTENSION_PATTERN = /\.(?:server|client)\.(?:mjs|js)$/i;

function normalizeCacheControlValue(value: string): string {
  return value.replace(/\s+/g, '').toLowerCase();
}

function normalizeContentType(value: string | null): string {
  if (typeof value !== 'string' || value.length === 0) {
    return '';
  }
  return value.split(';', 1)[0]?.trim().toLowerCase() ?? '';
}

function splitSetCookieHeaderValue(value: string): string[] {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return [];
  }
  if (!trimmed.includes(',')) {
    return [trimmed];
  }

  const cookies: string[] = [];
  let segmentStart = 0;
  let inExpiresAttribute = false;

  for (let index = 0; index < trimmed.length; index += 1) {
    const char = trimmed[index];
    if (char === ',') {
      if (!inExpiresAttribute) {
        const cookie = trimmed.slice(segmentStart, index).trim();
        if (cookie.length > 0) {
          cookies.push(cookie);
        }
        segmentStart = index + 1;
      }
      continue;
    }

    if (char === ';') {
      inExpiresAttribute = false;
      continue;
    }

    if (
      (char === 'e' || char === 'E') &&
      trimmed.slice(index, index + 8).toLowerCase() === 'expires='
    ) {
      inExpiresAttribute = true;
    }
  }

  const tail = trimmed.slice(segmentStart).trim();
  if (tail.length > 0) {
    cookies.push(tail);
  }

  return cookies;
}

function withDefaultRscVaryHeader(existingValue: string | null): string {
  const requiredValues = DEFAULT_RSC_VARY_HEADER
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);

  if (!existingValue || existingValue.length === 0) {
    return requiredValues.join(', ');
  }

  const existingValues = existingValue
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  const existingLowercase = new Set(existingValues.map((item) => item.toLowerCase()));

  const mergedValues = [...existingValues];
  for (const required of requiredValues) {
    const normalizedRequired = required.toLowerCase();
    if (existingLowercase.has(normalizedRequired)) {
      continue;
    }
    mergedValues.push(required);
    existingLowercase.add(normalizedRequired);
  }

  return mergedValues.join(', ');
}

function isRscPathname(value: string): boolean {
  return value.endsWith('.rsc') || value.endsWith('.segment.rsc');
}

function isNextDataPathname(value: string): boolean {
  return value.startsWith('/_next/data/') && value.endsWith('.json');
}

function maybeResolveNextDataFallbackPathname({
  requestPathname,
  basePath,
  buildId,
  indexes,
}: {
  requestPathname: string;
  basePath: string;
  buildId: string;
  indexes: ReturnType<typeof buildRouteIndexes>;
}): string | null {
  const pathnameWithoutBasePath =
    basePath && requestPathname.startsWith(`${basePath}/`)
      ? requestPathname.slice(basePath.length)
      : requestPathname;
  const prefix = `/_next/data/${buildId}/`;
  if (
    !pathnameWithoutBasePath.startsWith(prefix) ||
    !pathnameWithoutBasePath.endsWith('.json')
  ) {
    return null;
  }

  const encodedPath = pathnameWithoutBasePath
    .slice(prefix.length, -'.json'.length)
    .replace(/\/+/g, '/')
    .replace(/^\/+/, '');
  const normalizedPath = encodedPath.length > 0 ? `/${encodedPath}` : '/';
  const candidatePathnames = new Set<string>([normalizedPath]);

  if (normalizedPath !== '/' && normalizedPath.endsWith('/index')) {
    const withoutIndex = normalizedPath.slice(0, -'/index'.length);
    candidatePathnames.add(withoutIndex.length > 0 ? withoutIndex : '/');
  }
  if (normalizedPath === '/') {
    candidatePathnames.add('/index');
  }

  for (const candidatePathname of candidatePathnames) {
    if (candidatePathname === '/api' || candidatePathname.startsWith('/api/')) {
      continue;
    }
    if (
      indexes.functionByPathname.has(candidatePathname) ||
      indexes.prerenderByPathname.has(candidatePathname) ||
      indexes.staticByPathname.has(candidatePathname)
    ) {
      return candidatePathname;
    }
  }

  return null;
}

function maybeResolveDirectPathnameFallback({
  requestPathname,
  indexes,
}: {
  requestPathname: string;
  indexes: ReturnType<typeof buildRouteIndexes>;
}): string | null {
  const candidatePathnames = new Set<string>([requestPathname]);
  if (requestPathname !== '/' && requestPathname.endsWith('/')) {
    const withoutTrailingSlash = requestPathname.slice(0, -1) || '/';
    candidatePathnames.add(withoutTrailingSlash);
  }
  if (requestPathname === '/') {
    candidatePathnames.add('/index');
  }

  for (const candidatePathname of candidatePathnames) {
    if (
      indexes.staticByPathname.has(candidatePathname) ||
      indexes.prerenderByPathname.has(candidatePathname) ||
      indexes.functionByPathname.has(candidatePathname)
    ) {
      return candidatePathname;
    }
  }

  return null;
}

function resolveRequestPathnameWithoutBasePath({
  requestPathname,
  basePath,
}: {
  requestPathname: string;
  basePath: string;
}): string {
  if (basePath && requestPathname.startsWith(`${basePath}/`)) {
    return requestPathname.slice(basePath.length) || '/';
  }
  if (basePath && requestPathname === basePath) {
    return '/';
  }
  return requestPathname;
}

function shouldForceDocumentResponseCacheControl({
  response,
  route,
}: {
  response: Response;
  route: {
    kind: RouterRouteKind;
    id?: string;
  };
}): boolean {
  if (route.kind === 'prerender') {
    return true;
  }

  if (route.kind === 'not-found') {
    return true;
  }

  if (route.kind === 'function') {
    return true;
  }

  if (typeof route.id === 'string' && route.id.length > 0) {
    if (isRscPathname(route.id) || isNextDataPathname(route.id)) {
      return true;
    }
  }

  const contentType = normalizeContentType(response.headers.get('content-type'));
  return contentType === 'text/html' || contentType === 'text/x-component';
}

function createEmptyBodyStream(): ReadableStream {
  return new ReadableStream({
    start(controller) {
      controller.close();
    },
  });
}

function toResolveRoutesRequestBody(request: Request): ReadableStream {
  const method = request.method.toUpperCase();
  if (method === 'GET' || method === 'HEAD') {
    return createEmptyBodyStream();
  }

  try {
    return request.clone().body ?? createEmptyBodyStream();
  } catch {
    return request.body ?? createEmptyBodyStream();
  }
}

function withMiddlewareRequestMutations({
  request,
  rewriteUrl,
  requestHeaders,
  basePath,
  buildId,
}: {
  request: Request;
  rewriteUrl: URL | null;
  requestHeaders: Headers | null;
  basePath: string;
  buildId: string;
}): Request {
  if (!rewriteUrl && !requestHeaders) {
    return request;
  }

  const requestUrl = new URL(request.url);
  const pathnameWithoutBasePath = resolveRequestPathnameWithoutBasePath({
    requestPathname: requestUrl.pathname,
    basePath,
  });
  const isNextDataRequest =
    request.headers.get('x-nextjs-data') === '1' ||
    (pathnameWithoutBasePath.startsWith(`/_next/data/${buildId}/`) &&
      pathnameWithoutBasePath.endsWith('.json'));
  let targetUrl = rewriteUrl ?? requestUrl;
  if (rewriteUrl && isNextDataRequest) {
    const rewrittenNextDataPath = resolveNextDataRewriteHeader({
      request,
      rewriteUrl,
      basePath,
      buildId,
    });
    if (rewrittenNextDataPath) {
      targetUrl = new URL(rewrittenNextDataPath, requestUrl.origin);
    } else {
      targetUrl = requestUrl;
    }
  } else if (!rewriteUrl) {
    targetUrl = requestUrl;
  }

  const method = request.method.toUpperCase();
  const body =
    method === 'GET' || method === 'HEAD' ? undefined : request.clone().body;

  return new Request(targetUrl.toString(), {
    method: request.method,
    headers: requestHeaders ?? request.headers,
    body,
  });
}

function resolveNextDataRewriteHeader({
  request,
  rewriteUrl,
  basePath,
  buildId,
}: {
  request: Request;
  rewriteUrl: URL | null;
  basePath: string;
  buildId: string;
}): string | null {
  if (!rewriteUrl) {
    return null;
  }

  const requestUrl = new URL(request.url);
  const requestPathnameWithoutBasePath =
    basePath && requestUrl.pathname.startsWith(`${basePath}/`)
      ? requestUrl.pathname.slice(basePath.length)
      : requestUrl.pathname;
  const nextDataPrefix = `/_next/data/${buildId}/`;
  if (
    !requestPathnameWithoutBasePath.startsWith(nextDataPrefix) ||
    !requestPathnameWithoutBasePath.endsWith('.json')
  ) {
    return null;
  }

  if (rewriteUrl.origin !== requestUrl.origin) {
    return null;
  }

  let rewritePathname = rewriteUrl.pathname;
  if (basePath && rewritePathname.startsWith(`${basePath}/`)) {
    rewritePathname = rewritePathname.slice(basePath.length);
  }

  if (rewritePathname.startsWith(`/_next/data/${buildId}/`)) {
    return `${rewritePathname}${rewriteUrl.search}`;
  }

  if (!rewritePathname.startsWith('/')) {
    rewritePathname = `/${rewritePathname}`;
  }

  const normalizedPathname = rewritePathname === '/' ? '/index' : rewritePathname;
  const rewrittenNextDataPathname = `${nextDataPrefix}${normalizedPathname.slice(1)}.json`;
  const nextDataPathnameWithBasePath = basePath
    ? `${basePath}${rewrittenNextDataPathname}`
    : rewrittenNextDataPathname;
  return `${nextDataPathnameWithBasePath}${rewriteUrl.search}`;
}

function normalizeMiddlewareInvocationUrl({
  url,
  basePath,
  buildId,
  trailingSlash,
  sourceRequestUrl,
  i18n,
}: {
  url: URL;
  basePath: string;
  buildId: string;
  trailingSlash: boolean;
  sourceRequestUrl: URL;
  i18n: BunDeploymentManifest['build']['i18n'];
}): URL {
  const pathnameWithoutBasePath =
    basePath && url.pathname.startsWith(`${basePath}/`)
      ? url.pathname.slice(basePath.length)
      : url.pathname;
  const nextDataPrefix = `/_next/data/${buildId}/`;
  if (
    !pathnameWithoutBasePath.startsWith(nextDataPrefix) ||
    !pathnameWithoutBasePath.endsWith('.json')
  ) {
    return url;
  }

  const encodedPath = pathnameWithoutBasePath
    .slice(nextDataPrefix.length, -'.json'.length)
    .replace(/\/+/g, '/')
    .replace(/^\/+/, '');
  let normalizedPath = encodedPath;
  if (normalizedPath === 'index') {
    normalizedPath = '';
  } else if (normalizedPath.endsWith('/index')) {
    normalizedPath = normalizedPath.slice(0, -'/index'.length);
  }

  let nextPathname = normalizedPath.length > 0 ? `/${normalizedPath}` : '/';
  const sourceLocale = resolveNextDataRequestLocale({
    requestUrl: sourceRequestUrl,
    basePath,
    buildId,
    i18n,
  });
  if (sourceLocale) {
    const firstSegment = nextPathname
      .split('/')
      .find((segment) => segment.length > 0);
    const hasLocalePrefix =
      !!firstSegment &&
      i18n?.locales.some(
        (locale) => locale.toLowerCase() === firstSegment.toLowerCase()
      );
    if (!hasLocalePrefix) {
      nextPathname =
        nextPathname === '/' ? `/${sourceLocale}` : `/${sourceLocale}${nextPathname}`;
    }
  }
  const normalizedUrl = new URL(url.toString());
  const normalizedWithTrailingSlash =
    trailingSlash &&
    nextPathname !== '/' &&
    !nextPathname.endsWith('/') &&
    !STATIC_FILE_EXTENSION_PATTERN.test(nextPathname.split('/').pop() ?? '')
      ? `${nextPathname}/`
      : nextPathname;
  normalizedUrl.pathname = basePath
    ? `${basePath}${normalizedWithTrailingSlash}`
    : normalizedWithTrailingSlash;
  return normalizedUrl;
}

function withResolvedHeader(
  resolution: RouteResolutionResult,
  key: string,
  value: string
): RouteResolutionResult {
  const headers = new Headers(resolution.resolvedHeaders);
  headers.set(key, value);
  return {
    ...resolution,
    resolvedHeaders: headers,
  };
}

function shouldAttemptAppNotFoundFunction({
  requestPathname,
  basePath,
}: {
  requestPathname: string;
  basePath: string;
}): boolean {
  const requestInfo = analyzeNotFoundRequest({
    requestPathname,
    basePath,
  });

  if (requestInfo.isNextInternalPath || requestInfo.isApiPath) {
    return false;
  }

  // Skip the app not-found handler for asset-like paths under _next/ to
  // avoid returning HTML for JS/CSS chunk requests. For other asset-like
  // paths (e.g. /favicon.ico), allow the app not-found handler since
  // Next.js renders a proper HTML 404 page for non-existent assets.
  if (requestInfo.isAssetPath && requestInfo.pathnameWithoutBasePath.startsWith('/_next/')) {
    return false;
  }

  return true;
}

type NotFoundRequestInfo = {
  isWithinBasePath: boolean;
  startsWithBasePathPrefix: boolean;
  pathnameWithoutBasePath: string;
  isNextInternalPath: boolean;
  isApiPath: boolean;
  isAssetPath: boolean;
};

function analyzeNotFoundRequest({
  requestPathname,
  basePath,
}: {
  requestPathname: string;
  basePath: string;
}): NotFoundRequestInfo {
  const startsWithBasePathPrefix =
    basePath.length > 0 && requestPathname.startsWith(basePath);
  const isWithinBasePath =
    basePath.length === 0 ||
    requestPathname === basePath ||
    requestPathname.startsWith(`${basePath}/`);

  const pathnameWithoutBasePath =
    isWithinBasePath && basePath
      ? requestPathname.slice(basePath.length)
      : requestPathname;
  const isNextInternalPath =
    pathnameWithoutBasePath.startsWith('/_next/') ||
    pathnameWithoutBasePath.includes('/_next/');
  const isApiPath = pathnameWithoutBasePath.startsWith('/api/');
  const lastSegment = pathnameWithoutBasePath.split('/').pop() ?? '';
  const isAssetPath =
    STATIC_FILE_EXTENSION_PATTERN.test(lastSegment) &&
    !SERVER_CLIENT_MODULE_EXTENSION_PATTERN.test(lastSegment);

  return {
    isWithinBasePath,
    startsWithBasePathPrefix,
    pathnameWithoutBasePath,
    isNextInternalPath,
    isApiPath,
    isAssetPath,
  };
}

function shouldAttemptPagesNotFoundRoute(
  requestInfo: NotFoundRequestInfo
): boolean {
  return (
    requestInfo.isWithinBasePath &&
    !requestInfo.isNextInternalPath &&
    !requestInfo.isApiPath &&
    !requestInfo.isAssetPath
  );
}

function resolveDefaultNotFoundBody({
  requestInfo,
  hasBasePath,
}: {
  requestInfo: NotFoundRequestInfo;
  hasBasePath: boolean;
}): string {
  if (requestInfo.isAssetPath || requestInfo.isNextInternalPath) {
    return 'Not Found';
  }

  if (hasBasePath && !requestInfo.isWithinBasePath) {
    if (requestInfo.startsWithBasePathPrefix) {
      return '404: This page could not be found';
    }
    return 'NOT_FOUND';
  }

  return 'This page could not be found';
}

function stripMiddlewareResponse(
  result: RouterMiddlewareResult | {}
): MiddlewareResult {
  if (!('response' in result)) {
    return result;
  }

  const { response: _response, ...middlewareResult } = result;
  return middlewareResult;
}

function normalizeMiddlewareErrorResponse(response: Response): Response {
  const errorHeader = response.headers.get('error');
  if (!errorHeader) {
    return response;
  }

  if (
    errorHeader.includes('cannot be parsed as a URL') &&
    !errorHeader.includes('Invalid URL')
  ) {
    const headers = new Headers(response.headers);
    headers.set('error', `Invalid URL: ${errorHeader}`);
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  }

  return response;
}

function stripRequestHeaderEchoes({
  resolution,
  requestHeaders,
}: {
  resolution: RouteResolutionResult;
  requestHeaders: Headers;
}): RouteResolutionResult {
  if (!resolution.resolvedHeaders) {
    return resolution;
  }

  const filtered = new Headers();
  for (const [key, value] of resolution.resolvedHeaders.entries()) {
    const requestValue = requestHeaders.get(key);
    if (requestValue !== null && requestValue === value) {
      continue;
    }
    filtered.set(key, value);
  }

  return {
    ...resolution,
    resolvedHeaders: filtered,
  };
}

function stripInternalResponseHeaders(response: Response): Response {
  if (
    !response.headers.has(NEXT_CACHE_TAGS_HEADER)
  ) {
    return response;
  }
  const headers = new Headers(response.headers);
  headers.delete(NEXT_CACHE_TAGS_HEADER);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function applyResolutionToResponse(
  response: Response,
  resolution: RouteResolutionResult,
  explicitStatus?: number
): Response {
  const headers = new Headers(response.headers);
  const hasExplicitCacheControl = headers.has('cache-control');
  if (resolution.resolvedHeaders) {
    for (const [key, value] of resolution.resolvedHeaders.entries()) {
      const normalizedKey = key.toLowerCase();
      if (normalizedKey === 'x-middleware-set-cookie') {
        for (const cookie of splitSetCookieHeaderValue(value)) {
          headers.append('set-cookie', cookie);
        }
        continue;
      }
      if (
        normalizedKey === 'cache-control' &&
        normalizeCacheControlValue(value) === IMPLICIT_IMMUTABLE_CACHE_CONTROL
      ) {
        continue;
      }
      headers.set(key, value);
    }
  }

  const contentType = normalizeContentType(headers.get('content-type'));
  if (contentType === 'text/html' || contentType === 'text/x-component') {
    headers.set('vary', withDefaultRscVaryHeader(headers.get('vary')));
  }

  let status = response.status;
  if (typeof explicitStatus === 'number') {
    status = explicitStatus;
  } else if (typeof resolution.status === 'number') {
    // Keep non-200 statuses generated by the handler itself (e.g. static
    // conditional requests returning 304) instead of overwriting them with
    // route resolution's default 200.
    status =
      resolution.status === 200 && response.status !== 200
        ? response.status
        : resolution.status;
  }

  return new Response(response.body, {
    status,
    statusText: response.statusText,
    headers,
  });
}

function withHeader(response: Response, key: string, value: string): Response {
  const headers = new Headers(response.headers);
  headers.set(key, value);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function withRscVaryForRequest(response: Response, request: Request): Response {
  if (request.headers.get('rsc') !== '1') {
    return response;
  }

  const headers = new Headers(response.headers);
  if (normalizeContentType(headers.get('content-type')) === 'application/octet-stream') {
    headers.set('content-type', 'text/x-component');
  }
  headers.set('vary', withDefaultRscVaryHeader(headers.get('vary')));
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function withCacheState(
  response: Response,
  cacheState: PrerenderCacheState
): Response {
  const headers = new Headers(response.headers);
  headers.set('x-bun-cache', cacheState);
  headers.set('x-nextjs-cache', cacheState);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function withRouteMetadata(
  response: Response,
  route: {
    kind: RouterRouteKind;
    id?: string;
  }
): Response {
  response = stripInternalResponseHeaders(response);
  const headers = new Headers(response.headers);
  headers.set('x-bun-route-kind', route.kind);
  if (route.id) {
    headers.set('x-bun-route-id', route.id);
  } else {
    headers.delete('x-bun-route-id');
  }

  if (
    shouldForceDocumentResponseCacheControl({ response, route }) &&
    headers.get('cache-control') !== DOCUMENT_RESPONSE_CACHE_CONTROL
  ) {
    headers.set('cache-control', DOCUMENT_RESPONSE_CACHE_CONTROL);
  }

  if (
    route.kind === 'function' &&
    route.id &&
    (route.id === '/api' || route.id.startsWith('/api/')) &&
    !headers.has('content-type') &&
    response.body
  ) {
    headers.set('content-type', 'text/plain; charset=utf-8');
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function notFoundResponse({
  status = 404,
  body = 'This page could not be found',
}: {
  status?: number;
  body?: string;
} = {}): Response {
  return new Response(body, {
    status,
    headers: {
      'content-type': 'text/plain; charset=utf-8',
    },
  });
}

type ResolutionRoute = {
  status?: number;
  destination?: string;
  headers?: Record<string, string>;
};

function isRedirectStatusCode(status: number | undefined): boolean {
  return typeof status === 'number' && status >= 300 && status < 400;
}

function readRouteHeader(
  headers: Record<string, string> | undefined,
  key: string
): string | undefined {
  if (!headers) {
    return undefined;
  }
  const expectedKey = key.toLowerCase();
  for (const [headerKey, value] of Object.entries(headers)) {
    if (headerKey.toLowerCase() === expectedKey) {
      return value;
    }
  }
  return undefined;
}

function withDerivedRedirectDestination<T extends ResolutionRoute>(route: T): T {
  if (
    typeof route.destination === 'string' &&
    route.destination.length > 0
  ) {
    return route;
  }
  if (!isRedirectStatusCode(route.status)) {
    return route;
  }
  const location = readRouteHeader(route.headers, 'location');
  if (!location || location.length === 0) {
    return route;
  }
  return {
    ...route,
    destination: location,
  };
}

function withDerivedRedirectDestinations<T extends ResolutionRoute>(
  routes: readonly T[]
): T[] {
  return routes.map((route) => withDerivedRedirectDestination(route));
}

type RouteWithRegex = ResolutionRoute & { sourceRegex?: string };

/**
 * Resolve header-only route rules (from next.config.js `headers`) that match
 * a specific pathname. This mirrors @next/routing's `processRoutes` but only
 * extracts header entries — it intentionally skips redirects and rewrites so
 * we can apply config-level headers that @next/routing's `onMatch` overwrites.
 */
function resolveConfigHeadersForPathname(
  routes: readonly RouteWithRegex[],
  pathname: string
): Record<string, string> | null {
  let headers: Record<string, string> | null = null;
  for (const route of routes) {
    if (!route.headers || !route.sourceRegex) {
      continue;
    }
    // Only match header-only rules (no destination = no redirect/rewrite)
    if (route.destination) {
      continue;
    }
    try {
      const re = new RegExp(route.sourceRegex);
      if (re.test(pathname)) {
        headers ??= {};
        for (const [key, value] of Object.entries(route.headers)) {
          headers[key.toLowerCase()] = value;
        }
      }
    } catch {
      // Invalid regex — skip
    }
  }
  return headers;
}

function toResolutionRoutes(manifest: BunDeploymentManifest) {
  return {
    beforeMiddleware: withDerivedRedirectDestinations(
      manifest.routeGraph.beforeMiddleware
    ),
    beforeFiles: withDerivedRedirectDestinations(manifest.routeGraph.beforeFiles),
    afterFiles: withDerivedRedirectDestinations(manifest.routeGraph.afterFiles),
    dynamicRoutes: withDerivedRedirectDestinations(
      manifest.routeGraph.dynamicRoutes
    ),
    onMatch: withDerivedRedirectDestinations(manifest.routeGraph.onMatch),
    fallback: withDerivedRedirectDestinations(manifest.routeGraph.fallback),
    shouldNormalizeNextData: manifest.routeGraph.shouldNormalizeNextData,
    rsc: manifest.routeGraph.rsc,
  };
}

function withoutResolvedLocationHeader(
  resolution: RouteResolutionResult
): RouteResolutionResult {
  if (!resolution.resolvedHeaders?.has('location')) {
    return resolution;
  }
  const headers = new Headers(resolution.resolvedHeaders);
  headers.delete('location');
  return {
    ...resolution,
    resolvedHeaders: headers,
  };
}

function toRedirectLocation({
  redirectUrl,
  requestUrl,
}: {
  redirectUrl: URL;
  requestUrl: URL;
}): string {
  if (redirectUrl.origin === requestUrl.origin) {
    return `${redirectUrl.pathname}${redirectUrl.search}${redirectUrl.hash}`;
  }
  return redirectUrl.toString();
}

function resolveNextDataRequestLocale({
  requestUrl,
  basePath,
  buildId,
  i18n,
}: {
  requestUrl: URL;
  basePath: string;
  buildId: string;
  i18n: BunDeploymentManifest['build']['i18n'];
}): string | null {
  if (!i18n) {
    return null;
  }

  const pathnameWithoutBasePath = resolveRequestPathnameWithoutBasePath({
    requestPathname: requestUrl.pathname,
    basePath,
  });
  const nextDataPrefix = `/_next/data/${buildId}/`;
  if (
    !pathnameWithoutBasePath.startsWith(nextDataPrefix) ||
    !pathnameWithoutBasePath.endsWith('.json')
  ) {
    return null;
  }

  const encodedPath = pathnameWithoutBasePath
    .slice(nextDataPrefix.length, -'.json'.length)
    .replace(/\/+/g, '/')
    .replace(/^\/+/, '');
  if (!encodedPath) {
    return null;
  }

  const firstSegment = encodedPath.split('/').find((segment) => segment.length > 0);
  if (!firstSegment) {
    return null;
  }

  const locale = i18n.locales.find(
    (candidate) => candidate.toLowerCase() === firstSegment.toLowerCase()
  );
  return locale ?? null;
}

function withLocalizedNextDataRedirect({
  redirectLocation,
  requestUrl,
  basePath,
  buildId,
  i18n,
}: {
  redirectLocation: string;
  requestUrl: URL;
  basePath: string;
  buildId: string;
  i18n: BunDeploymentManifest['build']['i18n'];
}): string {
  if (!redirectLocation.startsWith('/') || !i18n) {
    return redirectLocation;
  }

  const requestLocale = resolveNextDataRequestLocale({
    requestUrl,
    basePath,
    buildId,
    i18n,
  });
  if (!requestLocale) {
    return redirectLocation;
  }

  const parsed = new URL(redirectLocation, 'http://n');
  if (parsed.pathname === '/api' || parsed.pathname.startsWith('/api/')) {
    return redirectLocation;
  }

  const strippedPathname =
    basePath &&
    (parsed.pathname === basePath || parsed.pathname.startsWith(`${basePath}/`))
      ? parsed.pathname.slice(basePath.length) || '/'
      : parsed.pathname;
  const firstSegment = strippedPathname.split('/').find(
    (segment) => segment.length > 0
  );
  if (
    firstSegment &&
    i18n.locales.some(
      (locale) => locale.toLowerCase() === firstSegment.toLowerCase()
    )
  ) {
    return redirectLocation;
  }

  const localizedPathname =
    strippedPathname === '/'
      ? `/${requestLocale}`
      : `/${requestLocale}${strippedPathname}`;
  parsed.pathname = basePath ? `${basePath}${localizedPathname}` : localizedPathname;
  return `${parsed.pathname}${parsed.search}${parsed.hash}`;
}

function withLocalizedNextDataResolutionHeaders({
  resolution,
  requestUrl,
  basePath,
  buildId,
  i18n,
}: {
  resolution: RouteResolutionResult;
  requestUrl: URL;
  basePath: string;
  buildId: string;
  i18n: BunDeploymentManifest['build']['i18n'];
}): RouteResolutionResult {
  if (!resolution.resolvedHeaders) {
    return resolution;
  }

  const requestLocale = resolveNextDataRequestLocale({
    requestUrl,
    basePath,
    buildId,
    i18n,
  });
  if (!requestLocale) {
    return resolution;
  }

  const headers = new Headers(resolution.resolvedHeaders);
  let mutated = false;
  const nextDataRedirect = headers.get('x-nextjs-redirect');
  if (nextDataRedirect) {
    const localizedRedirect = withLocalizedNextDataRedirect({
      redirectLocation: nextDataRedirect,
      requestUrl,
      basePath,
      buildId,
      i18n,
    });
    if (localizedRedirect !== nextDataRedirect) {
      headers.set('x-nextjs-redirect', localizedRedirect);
      mutated = true;
    }
  }

  if (!mutated) {
    return resolution;
  }

  return {
    ...resolution,
    resolvedHeaders: headers,
  };
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return normalized === 'localhost' || normalized === '127.0.0.1' || normalized === '::1';
}

function normalizeLoopbackRewriteUrl({
  rewriteUrl,
  requestUrl,
}: {
  rewriteUrl: URL;
  requestUrl: URL;
}): URL {
  if (rewriteUrl.origin === requestUrl.origin) {
    return rewriteUrl;
  }
  if (rewriteUrl.protocol !== requestUrl.protocol) {
    return rewriteUrl;
  }

  const rewritePort =
    rewriteUrl.port || (rewriteUrl.protocol === 'https:' ? '443' : '80');
  const requestPort =
    requestUrl.port || (requestUrl.protocol === 'https:' ? '443' : '80');
  if (rewritePort !== requestPort) {
    return rewriteUrl;
  }

  if (
    !isLoopbackHostname(rewriteUrl.hostname) ||
    !isLoopbackHostname(requestUrl.hostname)
  ) {
    return rewriteUrl;
  }

  return new URL(
    `${rewriteUrl.pathname}${rewriteUrl.search}${rewriteUrl.hash}`,
    requestUrl.origin
  );
}

function normalizeRscBasePathname(pathname: string): string {
  if (pathname === '/') {
    return '/index';
  }
  return pathname.endsWith('/') ? pathname.slice(0, -1) : pathname;
}

function maybeResolveRscMatchedPathname({
  request,
  matchedPathname,
  manifest,
  indexes,
}: {
  request: Request;
  matchedPathname: string;
  manifest: BunDeploymentManifest;
  indexes: ReturnType<typeof buildRouteIndexes>;
}): string {
  const rsc = manifest.routeGraph.rsc;
  const isRscRequest = request.headers.get(rsc.header) === '1';
  if (!isRscRequest) {
    return matchedPathname;
  }

  const hasOutputPathname = (pathname: string): boolean =>
    indexes.staticByPathname.has(pathname) ||
    indexes.prerenderByPathname.has(pathname) ||
    indexes.functionByPathname.has(pathname);

  const basePathname = normalizeRscBasePathname(matchedPathname);
  const segmentPrefetchPath = request.headers.get(rsc.prefetchSegmentHeader);
  if (segmentPrefetchPath && segmentPrefetchPath.length > 0) {
    const normalizedSegmentPath = segmentPrefetchPath.replace(/^\/+/, '');
    const segmentCandidatePathname = `${basePathname}${rsc.prefetchSegmentDirSuffix}/${normalizedSegmentPath}${rsc.prefetchSegmentSuffix}`;
    if (hasOutputPathname(segmentCandidatePathname)) {
      return segmentCandidatePathname;
    }
  }

  // For RSC document/data requests we must prefer the concrete `.rsc` seed
  // path when available (e.g. `/blog/tim.rsc`) before the HTML seed path
  // (`/blog/tim`) to avoid HTML/RSC prerender cache key collisions.
  const rscCandidatePathname = `${basePathname}${rsc.suffix}`;
  if (
    hasOutputPathname(rscCandidatePathname) &&
    indexes.functionByPathname.get(rscCandidatePathname)?.runtime !== 'edge'
  ) {
    return rscCandidatePathname;
  }

  if (hasOutputPathname(matchedPathname)) {
    return matchedPathname;
  }
  if (basePathname !== matchedPathname && hasOutputPathname(basePathname)) {
    return basePathname;
  }

  return matchedPathname;
}

function maybePreferExactMatchedPathname({
  request,
  matchedPathname,
  manifest,
  indexes,
}: {
  request: Request;
  matchedPathname: string;
  manifest: BunDeploymentManifest;
  indexes: ReturnType<typeof buildRouteIndexes>;
}): string {
  if (!matchedPathname.includes('[')) {
    return matchedPathname;
  }

  const requestUrl = new URL(request.url);
  let requestPathname = resolveRequestPathnameWithoutBasePath({
    requestPathname: requestUrl.pathname,
    basePath: manifest.build.basePath,
  });
  if (requestPathname !== '/' && requestPathname.endsWith('/')) {
    requestPathname = requestPathname.slice(0, -1) || '/';
  }

  const candidates = new Set<string>([requestPathname]);
  if (requestPathname === '/') {
    candidates.add('/index');
  }

  for (const candidate of candidates) {
    if (candidate === matchedPathname) {
      return matchedPathname;
    }
    if (hasOutputPathname(indexes, candidate) && !candidate.includes('[')) {
      return candidate;
    }
  }

  return matchedPathname;
}

function resolveRouteMatchValue(
  routeMatches: Record<string, string | string[]>,
  descriptor: DynamicSegmentDescriptor,
  numericIndex: number
): { value: string | string[] | undefined; nextNumericIndex: number } {
  const direct = routeMatches[descriptor.name];
  if (typeof direct === 'string' || Array.isArray(direct)) {
    return { value: direct, nextNumericIndex: numericIndex };
  }

  const prefixed = routeMatches[`nxtP${descriptor.name}`];
  if (typeof prefixed === 'string' || Array.isArray(prefixed)) {
    return { value: prefixed, nextNumericIndex: numericIndex };
  }

  const numeric = routeMatches[String(numericIndex)];
  if (typeof numeric === 'string' || Array.isArray(numeric)) {
    return { value: numeric, nextNumericIndex: numericIndex + 1 };
  }

  return { value: undefined, nextNumericIndex: numericIndex };
}

function maybeResolveConcreteMatchedPathname({
  matchedPathname,
  routeMatches,
  indexes,
  i18n,
}: {
  matchedPathname: string;
  routeMatches: Record<string, string | string[]> | undefined;
  indexes: ReturnType<typeof buildRouteIndexes>;
  i18n: BunDeploymentManifest['build']['i18n'];
}): string {
  if (!matchedPathname.includes('[') || !routeMatches) {
    return matchedPathname;
  }

  const segments = matchedPathname.split('/').filter(Boolean);
  if (segments.length === 0) {
    return matchedPathname;
  }

  const concreteSegments: string[] = [];
  let numericIndex = 1;

  for (const segment of segments) {
    const descriptor = parseDynamicSegmentDescriptor(segment);
    if (!descriptor) {
      concreteSegments.push(segment);
      continue;
    }

    const { value, nextNumericIndex } = resolveRouteMatchValue(
      routeMatches,
      descriptor,
      numericIndex
    );
    numericIndex = nextNumericIndex;
    if (value === undefined) {
      return matchedPathname;
    }

    if (descriptor.catchAll) {
      if (Array.isArray(value)) {
        if (value.length === 0) {
          if (descriptor.optionalCatchAll) {
            continue;
          }
          return matchedPathname;
        }
        concreteSegments.push(...value.map((part) => encodeURIComponent(part)));
        continue;
      }

      const parts = value
        .split('/')
        .filter((part) => part.length > 0)
        .map((part) => encodeURIComponent(part));
      if (parts.length === 0) {
        if (descriptor.optionalCatchAll) {
          continue;
        }
        return matchedPathname;
      }
      concreteSegments.push(...parts);
      continue;
    }

    if (Array.isArray(value)) {
      if (value.length === 0) {
        return matchedPathname;
      }
      const firstValue = value[0];
      if (typeof firstValue !== 'string' || firstValue.length === 0) {
        return matchedPathname;
      }
      concreteSegments.push(encodeURIComponent(firstValue) + descriptor.suffix);
      continue;
    }

    if (value.length === 0) {
      return matchedPathname;
    }
    concreteSegments.push(encodeURIComponent(value) + descriptor.suffix);
  }

  const concretePathname = concreteSegments.length > 0 ? `/${concreteSegments.join('/')}` : '/';
  if (hasOutputPathname(indexes, concretePathname)) {
    return concretePathname;
  }
  if (i18n && concretePathname !== '/') {
    const localeCandidate = concretePathname.split('/').filter(Boolean)[0];
    if (
      localeCandidate &&
      i18n.locales.some(
        (locale) => locale.toLowerCase() === localeCandidate.toLowerCase()
      )
    ) {
      const withoutLocale = concretePathname.slice(localeCandidate.length + 1) || '/';
      if (hasOutputPathname(indexes, withoutLocale)) {
        return withoutLocale;
      }
      if (
        withoutLocale !== '/' &&
        hasOutputPathname(indexes, `${withoutLocale}/index`)
      ) {
        return `${withoutLocale}/index`;
      }
    }
  }
  if (
    concretePathname !== '/' &&
    hasOutputPathname(indexes, `${concretePathname}/index`)
  ) {
    return `${concretePathname}/index`;
  }

  // For RSC segment requests (pathnames containing .segments/) where all
  // dynamic segments were resolved to concrete values, return the concrete
  // pathname even when it's not in the prerender/static indexes.  This
  // lets the prerender cache lookup miss naturally so the function is
  // invoked with real params instead of serving a fallback shell that
  // contains bracket-notation placeholders (e.g. [n]).
  if (concretePathname !== matchedPathname && matchedPathname.includes('.segments/')) {
    return concretePathname;
  }

  return matchedPathname;
}

function resolveConcretePathnameFromRouteMatches({
  matchedPathname,
  routeMatches,
}: {
  matchedPathname: string;
  routeMatches: Record<string, string | string[]> | undefined;
}): string | null {
  if (!matchedPathname.includes('[')) {
    return matchedPathname;
  }
  if (!routeMatches) {
    return null;
  }

  const segments = matchedPathname.split('/').filter(Boolean);
  if (segments.length === 0) {
    return '/';
  }

  const concreteSegments: string[] = [];
  let numericIndex = 1;

  for (const segment of segments) {
    const descriptor = parseDynamicSegmentDescriptor(segment);
    if (!descriptor) {
      concreteSegments.push(segment);
      continue;
    }

    const { value, nextNumericIndex } = resolveRouteMatchValue(
      routeMatches,
      descriptor,
      numericIndex
    );
    numericIndex = nextNumericIndex;
    if (value === undefined) {
      return null;
    }

    if (descriptor.catchAll) {
      const parts = Array.isArray(value)
        ? value
        : value.split('/').filter((part) => part.length > 0);
      if (parts.length === 0) {
        if (descriptor.optionalCatchAll) {
          continue;
        }
        return null;
      }
      concreteSegments.push(...parts.map((part) => encodeURIComponent(part)));
      continue;
    }

    const firstValue = Array.isArray(value) ? value[0] : value;
    if (typeof firstValue !== 'string' || firstValue.length === 0) {
      return null;
    }
    concreteSegments.push(encodeURIComponent(firstValue));
  }

  return concreteSegments.length > 0 ? `/${concreteSegments.join('/')}` : '/';
}

function withResolvedNextDataRequestPath({
  request,
  matchedPathname,
  routeMatches,
  basePath,
  buildId,
}: {
  request: Request;
  matchedPathname: string;
  routeMatches: Record<string, string | string[]> | undefined;
  basePath: string;
  buildId: string;
}): Request {
  const requestUrl = new URL(request.url);
  const pathnameWithoutBasePath = resolveRequestPathnameWithoutBasePath({
    requestPathname: requestUrl.pathname,
    basePath,
  });
  const nextDataPrefix = `/_next/data/${buildId}/`;
  const isNextDataRequest =
    request.headers.get('x-nextjs-data') === '1' ||
    (pathnameWithoutBasePath.startsWith(nextDataPrefix) &&
      pathnameWithoutBasePath.endsWith('.json'));
  if (!isNextDataRequest) {
    return request;
  }

  const concretePathname = resolveConcretePathnameFromRouteMatches({
    matchedPathname,
    routeMatches,
  });
  if (!concretePathname) {
    return request;
  }

  const normalizedConcretePathname =
    concretePathname === '/'
      ? '/index'
      : concretePathname.endsWith('/')
        ? concretePathname.slice(0, -1) || '/'
        : concretePathname;
  const nextDataPathname = `${nextDataPrefix}${normalizedConcretePathname.slice(1)}.json`;
  const nextDataPathnameWithBasePath = basePath
    ? `${basePath}${nextDataPathname}`
    : nextDataPathname;
  if (requestUrl.pathname === nextDataPathnameWithBasePath) {
    return request;
  }

  const method = request.method.toUpperCase();
  const body =
    method === 'GET' || method === 'HEAD' ? undefined : request.clone().body;
  const rewrittenUrl = new URL(requestUrl.toString());
  rewrittenUrl.pathname = nextDataPathnameWithBasePath;
  return new Request(rewrittenUrl.toString(), {
    method: request.method,
    headers: request.headers,
    body,
  });
}

function toResolutionI18nConfig(manifest: BunDeploymentManifest) {
  const i18n = manifest.build.i18n;
  if (!i18n) return undefined;

  return {
    defaultLocale: i18n.defaultLocale,
    locales: [...i18n.locales],
    localeDetection: i18n.localeDetection,
    domains: i18n.domains?.map((domain) => ({
      defaultLocale: domain.defaultLocale,
      domain: domain.domain,
      http: domain.http,
      locales: domain.locales ? [...domain.locales] : undefined,
    })),
  };
}

function normalizePathname(value: string): string {
  if (!value.startsWith('/')) {
    return `/${value}`;
  }
  return value;
}

function toRevalidateEndpointPath(
  basePath: string,
  endpointPath: string | undefined
): string {
  const normalizedEndpoint = normalizePathname(endpointPath ?? '/_next/revalidate');
  if (!basePath) {
    return normalizedEndpoint;
  }
  const normalizedBasePath = basePath.endsWith('/')
    ? basePath.slice(0, -1)
    : basePath;
  return `${normalizedBasePath}${normalizedEndpoint}`;
}

const PRERENDER_REVALIDATE_HEADER = 'x-prerender-revalidate';
const PRERENDER_REVALIDATE_ONLY_GENERATED_HEADER =
  'x-prerender-revalidate-if-generated';
const NEXT_CACHE_REVALIDATED_TAGS_HEADER = 'x-next-revalidated-tags';
const NEXT_CACHE_REVALIDATE_TAG_TOKEN_HEADER = 'x-next-revalidate-tag-token';

const PRERENDER_CONTROL_HEADERS = [
  PRERENDER_REVALIDATE_HEADER,
  PRERENDER_REVALIDATE_ONLY_GENERATED_HEADER,
  NEXT_CACHE_REVALIDATED_TAGS_HEADER,
  NEXT_CACHE_REVALIDATE_TAG_TOKEN_HEADER,
];

function toPrerenderCacheKeyRequest(
  request: Request,
  matchedPathname?: string
): Request {
  const sourceUrl = new URL(request.url);
  const shouldRewritePathname =
    typeof matchedPathname === 'string' &&
    matchedPathname.length > 0 &&
    !matchedPathname.includes('[') &&
    (isRscPathname(matchedPathname) || isNextDataPathname(matchedPathname)) &&
    sourceUrl.pathname !== matchedPathname;

  let needsStrip = false;
  for (const header of PRERENDER_CONTROL_HEADERS) {
    if (request.headers.has(header)) {
      needsStrip = true;
      break;
    }
  }
  if (!needsStrip && !shouldRewritePathname) {
    return request;
  }

  const headers = new Headers(request.headers);
  for (const header of PRERENDER_CONTROL_HEADERS) {
    headers.delete(header);
  }

  const url = new URL(sourceUrl.toString());
  if (shouldRewritePathname && typeof matchedPathname === 'string') {
    url.pathname = matchedPathname;
  }

  return new Request(url.toString(), { method: request.method, headers });
}

function readSeedBypassToken(seed: BunPrerenderSeed): string | null {
  const config = seed.config as Record<string, unknown>;
  if (
    typeof config.bypassToken === 'string' &&
    config.bypassToken.length > 0
  ) {
    return config.bypassToken;
  }
  return null;
}

function collectBypassTokens(manifest: BunDeploymentManifest): Set<string> {
  const tokens = new Set<string>();
  for (const seed of manifest.prerenderSeeds) {
    const token = readSeedBypassToken(seed);
    if (token) {
      tokens.add(token);
    }
  }
  return tokens;
}

type OnDemandRevalidateRequest =
  | { kind: 'none' }
  | { kind: 'valid'; onlyGenerated: boolean };

function parseOnDemandRevalidateRequest({
  request,
  revalidateAuthToken,
  bypassTokens,
}: {
  request: Request;
  revalidateAuthToken: string | undefined;
  bypassTokens: Set<string>;
}): OnDemandRevalidateRequest {
  const token = request.headers.get(PRERENDER_REVALIDATE_HEADER);
  if (!token) {
    return { kind: 'none' };
  }

  const valid =
    (revalidateAuthToken && token === revalidateAuthToken) ||
    bypassTokens.has(token);
  if (!valid) {
    return { kind: 'none' };
  }

  return {
    kind: 'valid',
    onlyGenerated: request.headers.has(PRERENDER_REVALIDATE_ONLY_GENERATED_HEADER),
  };
}

function parsePreviouslyRevalidatedTags({
  request,
  bypassTokens,
}: {
  request: Request;
  bypassTokens: Set<string>;
}): string[] {
  const token = request.headers.get(NEXT_CACHE_REVALIDATE_TAG_TOKEN_HEADER);
  if (!token || !bypassTokens.has(token)) {
    return [];
  }

  return parseCacheTagsHeader(
    request.headers.get(NEXT_CACHE_REVALIDATED_TAGS_HEADER)
  );
}

function parseRevalidateRequestBody(payload: unknown): {
  paths: string[];
  tags: string[];
  token: string | null;
  pathType: 'layout' | 'page' | null;
  tagMode: 'stale' | 'expire';
  tagProfile: string | null;
  tagExpireSeconds: number | undefined;
} | null {
  if (!payload || typeof payload !== 'object') {
    return null;
  }

  const body = payload as Record<string, unknown>;
  const paths = new Set<string>();
  const tags = new Set<string>();

  const singlePath = body.path;
  if (typeof singlePath === 'string' && singlePath.length > 0) {
    paths.add(normalizePathname(singlePath));
  }
  const multiPath = body.paths;
  if (Array.isArray(multiPath)) {
    for (const item of multiPath) {
      if (typeof item === 'string' && item.length > 0) {
        paths.add(normalizePathname(item));
      }
    }
  }

  const singleTag = body.tag;
  if (typeof singleTag === 'string' && singleTag.length > 0) {
    tags.add(singleTag);
  }
  const multiTags = body.tags;
  if (Array.isArray(multiTags)) {
    for (const item of multiTags) {
      if (typeof item === 'string' && item.length > 0) {
        tags.add(item);
      }
    }
  }

  if (paths.size === 0 && tags.size === 0) {
    return null;
  }

  const typeValue = body.type;
  const pathType =
    typeValue === 'layout' || typeValue === 'page' ? typeValue : null;

  const profileValue = body.profile;
  const expireValue = body.expire;
  let tagMode: 'stale' | 'expire' = 'expire';
  let tagExpireSeconds: number | undefined;

  if (
    (typeof profileValue === 'string' && profileValue.length > 0) ||
    (profileValue && typeof profileValue === 'object')
  ) {
    tagMode = 'stale';
  }

  if (
    profileValue &&
    typeof profileValue === 'object' &&
    'expire' in profileValue &&
    typeof (profileValue as { expire?: unknown }).expire === 'number'
  ) {
    tagExpireSeconds = Number((profileValue as { expire: number }).expire);
  } else if (typeof expireValue === 'number') {
    tagExpireSeconds = Number(expireValue);
  }

  const tagProfile =
    typeof profileValue === 'string' && profileValue.length > 0
      ? profileValue
      : null;

  return {
    paths: [...paths],
    tags: [...tags],
    token: typeof body.token === 'string' && body.token.length > 0 ? body.token : null,
    pathType,
    tagMode,
    tagProfile,
    tagExpireSeconds,
  };
}

function resolveProfileExpireSeconds(profile: string | null): number | undefined {
  if (!profile) {
    return undefined;
  }
  switch (profile) {
    case 'max':
      return 31536000;
    default:
      return 3600;
  }
}

function collectSeedTags(seed: BunPrerenderSeed): string[] {
  const tags = new Set<string>(seed.tags);
  const headerValue = seed.fallback?.initialHeaders?.[NEXT_CACHE_TAGS_HEADER];

  if (typeof headerValue === 'string') {
    for (const tag of parseCacheTagsHeader(headerValue)) {
      tags.add(tag);
    }
  } else if (Array.isArray(headerValue)) {
    for (const value of headerValue) {
      if (typeof value !== 'string') {
        continue;
      }
      for (const tag of parseCacheTagsHeader(value)) {
        tags.add(tag);
      }
    }
  }

  return [...tags];
}

function createManualRevalidateTasksFromManifest({
  manifest,
  request,
  pathnames,
  tags,
  pathTags,
}: {
  manifest: BunDeploymentManifest;
  request: Request;
  pathnames: string[];
  tags: string[];
  pathTags: string[];
}): {
  tasks: PrerenderRevalidateTask[];
  directMatchedPathnames: string[];
  expandedGroupPathnames: string[];
} {
  const pathSet = new Set(pathnames);
  const tagSet = new Set(tags);
  const pathTagSet = new Set(pathTags);
  const selected = new Map<string, PrerenderRevalidateReason>();

  for (const seed of manifest.prerenderSeeds) {
    if (pathSet.has(seed.pathname)) {
      selected.set(seed.pathname, 'MANUAL_PATH');
      continue;
    }
    if (tagSet.size > 0) {
      const seedTags = collectSeedTags(seed);
      for (const seedTag of seedTags) {
        if (!tagSet.has(seedTag)) {
          continue;
        }
        selected.set(
          seed.pathname,
          pathTagSet.has(seedTag) ? 'MANUAL_PATH' : 'MANUAL_TAG'
        );
        break;
      }
    }
  }

  const directMatchedPathnames = [...selected.keys()];
  const selectedGroupIds = new Set<number>();
  for (const seed of manifest.prerenderSeeds) {
    if (selected.has(seed.pathname)) {
      selectedGroupIds.add(seed.groupId);
    }
  }

  const expandedGroupPathnames: string[] = [];
  const defaultReason: PrerenderRevalidateReason =
    pathSet.size > 0 ? 'MANUAL_PATH' : 'MANUAL_TAG';
  for (const seed of manifest.prerenderSeeds) {
    if (selected.has(seed.pathname)) {
      continue;
    }
    if (selectedGroupIds.has(seed.groupId)) {
      selected.set(seed.pathname, defaultReason);
      expandedGroupPathnames.push(seed.pathname);
    }
  }

  const tasks: PrerenderRevalidateTask[] = [];
  for (const seed of manifest.prerenderSeeds) {
    const reason = selected.get(seed.pathname);
    if (!reason) {
      continue;
    }
    const seedRequest = new Request(new URL(seed.pathname, request.url).toString(), {
      method: 'GET',
    });
    const cacheKey = createPrerenderCacheKey(seed, seedRequest);
    tasks.push({
      cacheKey: cacheKey.key,
      pathname: seed.pathname,
      groupId: seed.groupId,
      reason,
    });
  }

  return {
    tasks,
    directMatchedPathnames,
    expandedGroupPathnames,
  };
}

function createManualRevalidateTasksFromTargets({
  targets,
  pathnames,
}: {
  targets: PrerenderRevalidateTarget[];
  pathnames: string[];
}): {
  tasks: PrerenderRevalidateTask[];
  directMatchedPathnames: string[];
} {
  const pathSet = new Set(pathnames);
  const defaultReason: PrerenderRevalidateReason =
    pathSet.size > 0 ? 'MANUAL_PATH' : 'MANUAL_TAG';
  const tasks = targets.map((target) => ({
    cacheKey: target.cacheKey,
    pathname: target.pathname,
    groupId: target.groupId,
    reason: pathSet.has(target.pathname) ? ('MANUAL_PATH' as const) : defaultReason,
  }));

  return {
    tasks,
    directMatchedPathnames: [...new Set(targets.map((target) => target.pathname))],
  };
}

async function maybeHandleManualRevalidateRequest({
  options,
  request,
}: {
  options: RouterRuntimeOptions;
  request: Request;
}): Promise<Response | null> {
  const requestUrl = new URL(request.url);
  const endpointPath = toRevalidateEndpointPath(
    options.manifest.build.basePath,
    options.revalidateEndpointPath
  );
  if (requestUrl.pathname !== endpointPath) {
    return null;
  }

  if (request.method !== 'POST') {
    return new Response('Method Not Allowed', {
      status: 405,
      headers: {
        allow: 'POST',
        'content-type': 'text/plain; charset=utf-8',
      },
    });
  }

  if (!options.revalidateAuthToken) {
    return new Response(
      'Revalidation endpoint is disabled because no auth token is configured.',
      {
        status: 503,
        headers: { 'content-type': 'text/plain; charset=utf-8' },
      }
    );
  }

  if (!options.prerenderCache?.store) {
    return new Response(
      'Prerender cache store is not configured for this runtime.',
      {
        status: 503,
        headers: { 'content-type': 'text/plain; charset=utf-8' },
      }
    );
  }

  const parsedBody = await request
    .clone()
    .json()
    .catch(() => null);
  const payload = parseRevalidateRequestBody(parsedBody);
  if (!payload) {
    return new Response(
      'Invalid revalidate payload. Expected { path|paths|tag|tags }.',
      {
        status: 400,
        headers: { 'content-type': 'text/plain; charset=utf-8' },
      }
    );
  }

  const authToken =
    request.headers.get('x-bun-revalidate-token') ??
    requestUrl.searchParams.get('token') ??
    payload.token;
  if (authToken !== options.revalidateAuthToken) {
    return new Response('Unauthorized', {
      status: 401,
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    });
  }

  const pathTags = payload.paths.flatMap((pathname) =>
    toImplicitPathTags(pathname, payload.pathType ?? undefined)
  );
  const allTags = [...new Set([...payload.tags, ...pathTags])];
  const now = options.prerenderCache.now?.() ?? Date.now();
  const tagManifestSupported = Boolean(options.prerenderCache.store.updateTagManifest);
  const resolvedTagExpireSeconds =
    payload.tagExpireSeconds ?? resolveProfileExpireSeconds(payload.tagProfile);

  if (options.prerenderCache.store.updateTagManifest) {
    if (pathTags.length > 0) {
      await options.prerenderCache.store.updateTagManifest(pathTags, {
        mode: 'expire',
        now,
      });
    }

    if (payload.tags.length > 0) {
      await options.prerenderCache.store.updateTagManifest(payload.tags, {
        mode: payload.tagMode,
        now,
        ...(payload.tagMode === 'stale' &&
        typeof resolvedTagExpireSeconds === 'number'
          ? { expireSeconds: resolvedTagExpireSeconds }
          : {}),
      });
    }
  }

  const storeTaskResult = options.prerenderCache.store.findRevalidateTargets
    ? createManualRevalidateTasksFromTargets({
        targets: await options.prerenderCache.store.findRevalidateTargets({
          pathnames: payload.paths,
          tags: allTags,
        }),
        pathnames: payload.paths,
      })
    : {
        tasks: [] as PrerenderRevalidateTask[],
        directMatchedPathnames: [] as string[],
      };

  const manifestTaskResult = createManualRevalidateTasksFromManifest({
    manifest: options.manifest,
    request,
    pathnames: payload.paths,
    tags: allTags,
    pathTags,
  });

  const tasksByCacheKey = new Map<string, PrerenderRevalidateTask>();
  for (const task of [...storeTaskResult.tasks, ...manifestTaskResult.tasks]) {
    const existing = tasksByCacheKey.get(task.cacheKey);
    if (!existing) {
      tasksByCacheKey.set(task.cacheKey, task);
      continue;
    }
    if (existing.reason === 'MANUAL_TAG' && task.reason === 'MANUAL_PATH') {
      tasksByCacheKey.set(task.cacheKey, task);
    }
  }

  let dispatched = 0;
  for (const task of tasksByCacheKey.values()) {
    if (!options.prerenderCache.revalidateQueue) {
      break;
    }
    await options.prerenderCache.revalidateQueue.enqueue(task);
    dispatched += 1;
  }

  return new Response(
    JSON.stringify({
      accepted: true,
      tagManifestUpdated: tagManifestSupported,
      tagMode: payload.tagMode,
      tagProfile: payload.tagProfile ?? undefined,
      tagExpireSeconds: resolvedTagExpireSeconds,
      derivedPathTags: pathTags,
      dispatched,
      directMatches: [
        ...new Set([
          ...storeTaskResult.directMatchedPathnames,
          ...manifestTaskResult.directMatchedPathnames,
        ]),
      ],
      groupFanout: manifestTaskResult.expandedGroupPathnames,
    }),
    {
      status: 202,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    }
  );
}

function indexByPathname<T extends { pathname: string; id: string }>(
  items: T[],
  label: string
): Map<string, T> {
  const byPathname = new Map<string, T>();

  for (const item of items) {
    const existing = byPathname.get(item.pathname);
    if (existing && existing.id !== item.id) {
      throw new Error(
        `Duplicate ${label} pathname "${item.pathname}" for "${existing.id}" and "${item.id}"`
      );
    }
    byPathname.set(item.pathname, item);
  }

  return byPathname;
}

function rankFunctionPathnameCandidate(output: BunFunctionArtifact): number {
  const source = output.sourcePage || output.id;
  let rank = 0;

  // Parallel route slot entries (e.g. "/@modal/page") should not win
  // against canonical page entries for direct pathname dispatch.
  if (source.includes('/@')) {
    rank += 100;
  }

  // Prefer shorter/canonical page ids when the slot signal is absent.
  rank += source.length / 1000;

  return rank;
}

function preferFunctionPathnameCandidate(
  left: BunFunctionArtifact,
  right: BunFunctionArtifact
): BunFunctionArtifact {
  const leftRank = rankFunctionPathnameCandidate(left);
  const rightRank = rankFunctionPathnameCandidate(right);
  if (leftRank < rightRank) {
    return left;
  }
  if (rightRank < leftRank) {
    return right;
  }
  return left.id.localeCompare(right.id) <= 0 ? left : right;
}

function indexFunctionOutputsByPathname(
  items: BunFunctionArtifact[]
): Map<string, BunFunctionArtifact> {
  const byPathname = new Map<string, BunFunctionArtifact>();

  for (const item of items) {
    const existing = byPathname.get(item.pathname);
    if (!existing) {
      byPathname.set(item.pathname, item);
      continue;
    }
    byPathname.set(item.pathname, preferFunctionPathnameCandidate(existing, item));
  }

  return byPathname;
}

function splitPathname(pathname: string): string[] {
  const trimmed = pathname.replace(/^\/+|\/+$/g, '');
  if (!trimmed) {
    return [];
  }
  return trimmed.split('/');
}

function isDynamicPathSegment(segment: string): boolean {
  return (
    /^\[[^\]]+\]$/.test(segment) ||
    /^\[\.\.\.[^\]]+\]$/.test(segment) ||
    /^\[\[\.\.\.[^\]]+\]\]$/.test(segment)
  );
}

function isPathPatternAncestor({
  ancestorPathname,
  descendantPathname,
}: {
  ancestorPathname: string;
  descendantPathname: string;
}): boolean {
  const ancestorSegments = splitPathname(ancestorPathname);
  const descendantSegments = splitPathname(descendantPathname);
  if (ancestorSegments.length > descendantSegments.length) {
    return false;
  }

  for (let index = 0; index < ancestorSegments.length; index += 1) {
    const ancestorSegment = ancestorSegments[index];
    const descendantSegment = descendantSegments[index];
    if (!ancestorSegment || !descendantSegment) {
      return false;
    }
    if (isDynamicPathSegment(ancestorSegment)) {
      continue;
    }
    if (ancestorSegment !== descendantSegment) {
      return false;
    }
  }

  return true;
}

function deriveAncestorSeedPathname({
  requestPathname,
  ancestorPathname,
}: {
  requestPathname: string;
  ancestorPathname: string;
}): string | null {
  const requestSegments = splitPathname(requestPathname);
  const ancestorSegments = splitPathname(ancestorPathname);
  if (requestSegments.length < ancestorSegments.length) {
    return null;
  }

  for (let index = 0; index < ancestorSegments.length; index += 1) {
    const ancestorSegment = ancestorSegments[index];
    const requestSegment = requestSegments[index];
    if (!ancestorSegment || !requestSegment) {
      return null;
    }
    if (isDynamicPathSegment(ancestorSegment)) {
      continue;
    }
    if (ancestorSegment !== requestSegment) {
      return null;
    }
  }

  const candidate = requestSegments.slice(0, ancestorSegments.length).join('/');
  return candidate ? `/${candidate}` : '/';
}

type RouteIndexes = {
  staticByPathname: Map<string, BunStaticAsset>;
  functionByPathname: Map<string, BunFunctionArtifact>;
  functionById: Map<string, BunFunctionArtifact>;
  prerenderByPathname: Map<string, BunPrerenderSeed>;
  strictDynamicAncestorSeedPaths: Map<string, Set<string>>;
};

function buildRouteIndexes(manifest: BunDeploymentManifest): RouteIndexes {
  const staticByPathname = indexByPathname(manifest.staticAssets, 'static asset');
  const functionByPathname = indexFunctionOutputsByPathname(manifest.functionMap);
  const prerenderByPathname = indexByPathname(
    manifest.prerenderSeeds,
    'prerender seed'
  );

  const functionById = new Map<string, BunFunctionArtifact>();
  for (const output of manifest.functionMap) {
    const existing = functionById.get(output.id);
    if (existing && existing.bundleId !== output.bundleId) {
      throw new Error(
        `Duplicate function id "${output.id}" for "${existing.bundleId}" and "${output.bundleId}"`
      );
    }
    functionById.set(output.id, output);
  }

  const strictDynamicAncestorSeedPaths = new Map<string, Set<string>>();
  for (const seed of manifest.prerenderSeeds) {
    if (seed.parentFallbackMode !== false) {
      continue;
    }
    const parentOutput = functionById.get(seed.parentOutputId);
    if (!parentOutput || !parentOutput.pathname.includes('[')) {
      continue;
    }
    const existing = strictDynamicAncestorSeedPaths.get(parentOutput.pathname);
    if (existing) {
      existing.add(seed.pathname);
      continue;
    }
    strictDynamicAncestorSeedPaths.set(
      parentOutput.pathname,
      new Set([seed.pathname])
    );
  }

  return {
    staticByPathname,
    functionByPathname,
    functionById,
    prerenderByPathname,
    strictDynamicAncestorSeedPaths,
  };
}

function hasOutputPathname(
  indexes: RouteIndexes,
  pathname: string
): boolean {
  return (
    indexes.staticByPathname.has(pathname) ||
    indexes.prerenderByPathname.has(pathname) ||
    indexes.functionByPathname.has(pathname)
  );
}

function resolveNotFoundStatusForRequest(request: Request): number {
  const method = request.method.toUpperCase();
  return method === 'GET' || method === 'HEAD' ? 404 : 405;
}

function withMethodNotAllowedAllowHeader(
  response: Response,
  status: number
): Response {
  if (status !== 405 || response.headers.has('allow')) {
    return response;
  }
  return withHeader(response, 'allow', 'GET, HEAD');
}

async function maybeServeAppNotFound({
  request,
  resolution,
  indexes,
  options,
  routeMatches,
}: {
  request: Request;
  resolution: RouteResolutionResult;
  indexes: RouteIndexes;
  options: RouterRuntimeOptions;
  routeMatches: Record<string, string | string[]> | undefined;
}): Promise<Response | null> {
  const notFoundStatus = resolveNotFoundStatusForRequest(request);
  const appNotFoundPathname = '/_not-found';
  const appNotFoundStaticAsset =
    indexes.staticByPathname.get(appNotFoundPathname) ??
    indexes.staticByPathname.get('/404');
  if (appNotFoundStaticAsset) {
    const appNotFoundResponse = await options.serveStatic({
      request,
      matchedPathname: appNotFoundPathname,
      routeMatches: undefined,
      resolution,
      asset: appNotFoundStaticAsset,
      source: 'static',
    });
    const responseWithStatus = withMethodNotAllowedAllowHeader(
      appNotFoundResponse,
      notFoundStatus
    );
    return withRouteMetadata(
      withRscVaryForRequest(
        applyResolutionToResponse(responseWithStatus, resolution, notFoundStatus),
        request
      ),
      {
        kind: 'not-found',
        id: appNotFoundStaticAsset.id,
      }
    );
  }

  const appNotFoundPrerender = indexes.prerenderByPathname.get(appNotFoundPathname);
  if (appNotFoundPrerender) {
    const appNotFoundParentOutput = indexes.functionById.get(
      appNotFoundPrerender.parentOutputId
    );
    if (appNotFoundParentOutput) {
      const appNotFoundResponse = await options.invokeFunction({
        request,
        matchedPathname: appNotFoundPathname,
        routeMatches: undefined,
        resolution,
        output: appNotFoundParentOutput,
        source: 'prerender-parent',
        prerenderSeed: appNotFoundPrerender,
        cacheState: undefined,
      });
      const responseWithStatus = withMethodNotAllowedAllowHeader(
        appNotFoundResponse,
        notFoundStatus
      );
      return withRouteMetadata(
        withRscVaryForRequest(
          applyResolutionToResponse(
            responseWithStatus,
            resolution,
            notFoundStatus
          ),
          request
        ),
        {
          kind: 'not-found',
          id: appNotFoundPrerender.id,
        }
      );
    }
  }

  const appNotFoundOutput = indexes.functionByPathname.get(appNotFoundPathname);
  if (appNotFoundOutput) {
    const appNotFoundResponse = await options.invokeFunction({
      request,
      matchedPathname: appNotFoundPathname,
      routeMatches,
      resolution,
      output: appNotFoundOutput,
      source: 'function',
      prerenderSeed: null,
      cacheState: undefined,
    });
    const responseWithStatus = withMethodNotAllowedAllowHeader(
      appNotFoundResponse,
      notFoundStatus
    );
    return withRouteMetadata(
      applyResolutionToResponse(responseWithStatus, resolution, notFoundStatus),
      {
        kind: 'not-found',
        id: appNotFoundOutput.id,
      }
    );
  }

  return null;
}

function decodeURIComponentSafe(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function isMalformedEncodedPathname(pathname: string): boolean {
  try {
    decodeURI(pathname);
    return false;
  } catch {
    return true;
  }
}

type DynamicSegmentDescriptor = {
  name: string;
  catchAll: boolean;
  optionalCatchAll: boolean;
  suffix: string;
};

function parseDynamicSegmentDescriptor(
  segment: string
): DynamicSegmentDescriptor | null {
  const optionalCatchAllMatch = segment.match(/^\[\[\.\.\.([^\]]+)\]\](\..+)?$/);
  if (optionalCatchAllMatch?.[1]) {
    return {
      name: optionalCatchAllMatch[1],
      catchAll: true,
      optionalCatchAll: true,
      suffix: optionalCatchAllMatch[2] ?? '',
    };
  }

  const catchAllMatch = segment.match(/^\[\.\.\.([^\]]+)\](\..+)?$/);
  if (catchAllMatch?.[1]) {
    return {
      name: catchAllMatch[1],
      catchAll: true,
      optionalCatchAll: false,
      suffix: catchAllMatch[2] ?? '',
    };
  }

  const singleMatch = segment.match(/^\[([^\]]+)\](\..+)?$/);
  if (singleMatch?.[1]) {
    return {
      name: singleMatch[1],
      catchAll: false,
      optionalCatchAll: false,
      suffix: singleMatch[2] ?? '',
    };
  }

  return null;
}

function normalizeRouteMatchesForPathname({
  matchedPathname,
  routeMatches,
}: {
  matchedPathname: string;
  routeMatches: Record<string, string> | undefined;
}): Record<string, string | string[]> | undefined {
  if (!routeMatches || Object.keys(routeMatches).length === 0) {
    return undefined;
  }

  const dynamicSegments = matchedPathname
    .split('/')
    .filter(Boolean)
    .map(parseDynamicSegmentDescriptor)
    .filter((value): value is DynamicSegmentDescriptor => value !== null);
  if (dynamicSegments.length === 0) {
    return undefined;
  }

  const normalized: Record<string, string | string[]> = {};
  const numericValues = Object.entries(routeMatches)
    .filter(([key]) => /^\d+$/.test(key))
    .sort((left, right) => Number(left[0]) - Number(right[0]))
    .map(([, value]) => value);
  let numericIndex = 0;

  for (const [key, value] of Object.entries(routeMatches)) {
    if (/^\d+$/.test(key)) {
      continue;
    }
    normalized[key] = value;
  }

  for (const segment of dynamicSegments) {
    const fallbackValue = numericValues[numericIndex];
    const prefixedRouteKey = `nxtP${segment.name}`;
    let rawValue = normalized[segment.name];
    if (
      typeof rawValue !== 'string' &&
      typeof normalized[prefixedRouteKey] === 'string'
    ) {
      rawValue = normalized[prefixedRouteKey];
    }
    if (typeof rawValue !== 'string' && typeof fallbackValue === 'string') {
      rawValue = fallbackValue;
      numericIndex += 1;
    }

    if (typeof rawValue !== 'string') {
      continue;
    }

    let normalizedRawValue = rawValue;
    if (
      segment.suffix.length > 0 &&
      normalizedRawValue.endsWith(segment.suffix)
    ) {
      normalizedRawValue = normalizedRawValue.slice(
        0,
        -segment.suffix.length
      );
    }
    if (normalizedRawValue.length === 0) {
      continue;
    }

    if (typeof normalized[prefixedRouteKey] !== 'string') {
      normalized[prefixedRouteKey] = normalizedRawValue;
    }

    if (segment.catchAll) {
      const parts = normalizedRawValue
        .split('/')
        .filter((part) => part.length > 0)
        .map((part) => decodeURIComponentSafe(part));
      if (parts.length === 0 && segment.optionalCatchAll) {
        delete normalized[segment.name];
      } else {
        normalized[segment.name] = parts;
      }
      continue;
    }

    normalized[segment.name] = decodeURIComponentSafe(normalizedRawValue);
  }

  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

function decodeNextDataRequestPathname({
  requestPathname,
  basePath,
  buildId,
}: {
  requestPathname: string;
  basePath: string;
  buildId: string;
}): string | null {
  const pathnameWithoutBasePath =
    basePath && requestPathname.startsWith(`${basePath}/`)
      ? requestPathname.slice(basePath.length)
      : requestPathname;
  const nextDataPrefix = `/_next/data/${buildId}/`;
  if (
    !pathnameWithoutBasePath.startsWith(nextDataPrefix) ||
    !pathnameWithoutBasePath.endsWith('.json')
  ) {
    return null;
  }

  const encodedPath = pathnameWithoutBasePath
    .slice(nextDataPrefix.length, -'.json'.length)
    .replace(/\/+/g, '/')
    .replace(/^\/+/, '');

  if (encodedPath.length === 0 || encodedPath === 'index') {
    return '/';
  }
  if (encodedPath.endsWith('/index')) {
    const withoutIndex = encodedPath.slice(0, -'/index'.length);
    return withoutIndex.length > 0 ? `/${withoutIndex}` : '/';
  }

  return `/${encodedPath}`;
}

function hydrateMissingSingleSegmentDynamicRouteMatches({
  matchedPathname,
  routeMatches,
  requestPathname,
  basePath,
  buildId,
}: {
  matchedPathname: string;
  routeMatches: Record<string, string | string[]> | undefined;
  requestPathname: string;
  basePath: string;
  buildId: string;
}): Record<string, string | string[]> | undefined {
  const matchedSegments = matchedPathname.split('/').filter(Boolean);
  if (matchedSegments.length === 0) {
    return routeMatches;
  }

  const decodedNextDataPathname = decodeNextDataRequestPathname({
    requestPathname,
    basePath,
    buildId,
  });
  let normalizedRequestPathname =
    decodedNextDataPathname ??
    resolveRequestPathnameWithoutBasePath({ requestPathname, basePath });
  if (normalizedRequestPathname !== '/' && normalizedRequestPathname.endsWith('/')) {
    normalizedRequestPathname = normalizedRequestPathname.slice(0, -1) || '/';
  }
  const requestSegments = normalizedRequestPathname.split('/').filter(Boolean);

  if (requestSegments.length !== matchedSegments.length) {
    return routeMatches;
  }

  const normalized = routeMatches ? { ...routeMatches } : {};
  let didAddMatch = false;

  for (let index = 0; index < matchedSegments.length; index += 1) {
    const matchedSegment = matchedSegments[index];
    const requestSegment = requestSegments[index];
    if (!matchedSegment || !requestSegment) {
      continue;
    }

    const descriptor = parseDynamicSegmentDescriptor(matchedSegment);
    if (!descriptor || descriptor.catchAll) {
      continue;
    }

    let normalizedRequestValue = requestSegment;
    if (
      descriptor.suffix.length > 0 &&
      normalizedRequestValue.endsWith(descriptor.suffix)
    ) {
      normalizedRequestValue = normalizedRequestValue.slice(
        0,
        -descriptor.suffix.length
      );
    }
    if (normalizedRequestValue.length === 0) {
      continue;
    }

    if (typeof normalized[descriptor.name] !== 'string') {
      normalized[descriptor.name] = decodeURIComponentSafe(normalizedRequestValue);
      didAddMatch = true;
    }
    const prefixedKey = `nxtP${descriptor.name}`;
    if (typeof normalized[prefixedKey] !== 'string') {
      normalized[prefixedKey] = normalizedRequestValue;
      didAddMatch = true;
    }
  }

  if (!didAddMatch) {
    return routeMatches;
  }
  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

function isRedirectResolution(resolution: RouteResolutionResult): boolean {
  if (!resolution.status) return false;
  if (resolution.status < 300 || resolution.status >= 400) return false;
  return Boolean(resolution.resolvedHeaders?.get('location'));
}

async function enqueueRevalidate({
  options,
  cacheKey,
  seed,
  reason,
}: {
  options: RouterRuntimeOptions;
  cacheKey: string;
  seed: BunPrerenderSeed;
  reason: PrerenderRevalidateReason;
}): Promise<void> {
  const cacheConfig = options.prerenderCache;
  if (!cacheConfig?.revalidateQueue) {
    return;
  }

  const completion = cacheConfig.revalidateQueue.enqueue({
    cacheKey,
    pathname: seed.pathname,
    groupId: seed.groupId,
    reason,
  });
  if (completion && typeof (completion as PromiseLike<void>).then === 'function') {
    void (completion as Promise<void>).catch(() => undefined);
  }
}

function applySeedFallbackHeaders(
  response: Response,
  seed: BunPrerenderSeed
): Response {
  const fallback = seed.fallback;
  if (!fallback) {
    return response;
  }

  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(fallback.initialHeaders ?? {})) {
    if (Array.isArray(value)) {
      headers.set(key, value.join(', '));
      continue;
    }
    headers.set(key, value);
  }

  return new Response(response.body, {
    status: fallback.initialStatus ?? response.status,
    statusText: response.statusText,
    headers,
  });
}

function toPrerenderParentRequest({
  request,
  seed,
}: {
  request: Request;
  seed: BunPrerenderSeed;
}): Request {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return request;
  }

  const rawPostponedStatePath = seed.fallback?.postponedStatePath;
  if (
    typeof rawPostponedStatePath !== 'string' ||
    rawPostponedStatePath.length === 0
  ) {
    return request;
  }

  const shouldTreatAsResumePath =
    rawPostponedStatePath.startsWith('/') ||
    rawPostponedStatePath.startsWith('http://') ||
    rawPostponedStatePath.startsWith('https://');
  if (!shouldTreatAsResumePath) {
    if (request.method !== 'GET') {
      return request;
    }
    const headers = new Headers(request.headers);
    applyPrerenderResumeHeaders(headers, seed);
    if (!headers.has('content-type')) {
      headers.set('content-type', 'text/plain; charset=utf-8');
    }
    return new Request(request.url, {
      method: 'POST',
      headers,
      body: rawPostponedStatePath,
    });
  }

  const resumePath = resolvePrerenderResumePath(seed);
  if (!resumePath) {
    return request;
  }

  const url = new URL(request.url);
  url.pathname = resumePath.pathname;
  url.search = resumePath.search;

  const headers = new Headers(request.headers);
  applyPrerenderResumeHeaders(headers, seed);
  return new Request(url.toString(), {
    method: request.method,
    headers,
  });
}

function shouldBypassPrerenderAllowListFiltering(request: Request): boolean {
  if (request.headers.get('rsc') === '1') {
    return true;
  }

  const url = new URL(request.url);
  if (url.searchParams.has('_rsc')) {
    return true;
  }

  const pathname = url.pathname.toLowerCase();
  return pathname.endsWith('.rsc') || pathname.includes('.segment.rsc');
}

function maybeFilterPrerenderRequestByAllowLists({
  seed,
  request,
}: {
  seed: BunPrerenderSeed;
  request: Request;
}): Request {
  if (shouldBypassPrerenderAllowListFiltering(request)) {
    return request;
  }
  return filterPrerenderRequestByAllowLists(seed, request);
}

function createFallbackBodyConcatenatedResponse({
  fallbackResponse,
  resumeResponse,
  resumeResponsePromise,
}: {
  fallbackResponse: Response;
  resumeResponse?: Response | null;
  resumeResponsePromise?: Promise<Response | null>;
}): Response {
  if (typeof resumeResponse === 'undefined' && !resumeResponsePromise) {
    return fallbackResponse;
  }

  const directResumeResponse = resumeResponse ?? null;
  const pendingResumePromise =
    resumeResponsePromise ??
    (typeof resumeResponse === 'undefined'
      ? undefined
      : Promise.resolve(directResumeResponse));

  const headers = new Headers(fallbackResponse.headers);
  headers.delete('content-length');
  headers.delete('content-encoding');
  headers.delete('transfer-encoding');

  if (directResumeResponse) {
    for (const [key, value] of directResumeResponse.headers.entries()) {
      const normalizedKey = key.toLowerCase();
      if (
        normalizedKey === 'content-length' ||
        normalizedKey === 'content-encoding' ||
        normalizedKey === 'transfer-encoding'
      ) {
        continue;
      }
      if (normalizedKey === 'set-cookie') {
        headers.append(key, value);
        continue;
      }
      headers.set(key, value);
    }
  } else if (pendingResumePromise) {
    headers.set(
      'cache-control',
      'private, no-cache, no-store, max-age=0, must-revalidate'
    );
  }

  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      const pump = async (response: Response | null) => {
        if (!response?.body) {
          return;
        }
        const reader = response.body.getReader();
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) {
              break;
            }
            if (value) {
              controller.enqueue(value);
            }
          }
        } finally {
          reader.releaseLock();
        }
      };

      try {
        await pump(fallbackResponse);
        if (directResumeResponse) {
          await pump(directResumeResponse);
        } else if (pendingResumePromise) {
          const resolvedResumeResponse = await pendingResumePromise.catch(() => null);
          await pump(resolvedResumeResponse);
        }
        controller.close();
      } catch (error) {
        controller.error(error);
      }
    },
  });

  return new Response(body, {
    status: fallbackResponse.status,
    statusText: fallbackResponse.statusText,
    headers,
  });
}

function isGetOrHeadRequest(request: Request): boolean {
  return request.method === 'GET' || request.method === 'HEAD';
}

function stripInternalMiddlewareRequestHeaders(headers: Headers): Headers {
  const sanitized = new Headers(headers);
  for (const header of INTERNAL_MIDDLEWARE_REQUEST_HEADERS) {
    sanitized.delete(header);
  }
  return sanitized;
}

function sanitizeIncomingMiddlewareRequestHeaders(headers: Headers): {
  headers: Headers;
  didStrip: boolean;
} {
  const sanitized = new Headers(headers);
  let didStrip = false;

  for (const [key] of headers.entries()) {
    const normalizedKey = key.toLowerCase();
    const shouldStripByName = UNTRUSTED_MIDDLEWARE_REQUEST_HEADERS.has(normalizedKey);
    const shouldStripByPrefix = UNTRUSTED_MIDDLEWARE_REQUEST_HEADER_PREFIXES.some(
      (prefix) => normalizedKey.startsWith(prefix)
    );
    if (!shouldStripByName && !shouldStripByPrefix) {
      continue;
    }

    didStrip = true;
    sanitized.delete(key);
  }

  return {
    headers: sanitized,
    didStrip,
  };
}

function collectInternalMiddlewareRequestHeaders(headers: Headers): Headers {
  const internal = new Headers();
  for (const header of INTERNAL_MIDDLEWARE_REQUEST_HEADERS) {
    const value = headers.get(header);
    if (value !== null) {
      internal.set(header, value);
    }
  }
  return internal;
}

function restoreInternalMiddlewareRequestHeaders({
  requestHeaders,
  internalHeaders,
}: {
  requestHeaders: Headers;
  internalHeaders: Headers;
}): Headers {
  const restored = new Headers(requestHeaders);
  for (const header of INTERNAL_MIDDLEWARE_REQUEST_HEADERS) {
    const value = internalHeaders.get(header);
    if (value !== null) {
      restored.set(header, value);
    }
  }
  return restored;
}

async function refreshImageCache({
  options,
  request,
  resolution,
}: {
  options: RouterRuntimeOptions;
  request: Request;
  resolution: RouteResolutionResult;
}): Promise<void> {
  const cacheConfig = options.imageCache;
  if (!cacheConfig || !options.invokeImageFunction) {
    return;
  }

  const now = cacheConfig.now?.() ?? Date.now();
  const cacheKey = createImageCacheKey(request, options.manifest.build.basePath);
  const generatedResponse = await options.invokeImageFunction({
    request,
    matchedPathname: toImageRoutePath(options.manifest.build.basePath),
    routeMatches: resolution.routeMatches,
    resolution,
    source: 'image',
    cacheState: 'MISS',
  });
  const shouldCache =
    cacheConfig.shouldCacheResponse?.(generatedResponse, cacheKey) ??
    defaultShouldCacheImageResponse(generatedResponse);
  if (!shouldCache) {
    return;
  }

  const cacheEntry = await responseToImageCacheEntry({
    cacheKey: cacheKey.key,
    pathname: cacheKey.pathname,
    response: generatedResponse,
    now,
    ttlSeconds: cacheConfig.ttlSeconds,
    staleTtlSeconds: cacheConfig.staleTtlSeconds,
  });
  await cacheConfig.store.set(cacheKey.key, cacheEntry);
}

export function createRouterRuntime(options: RouterRuntimeOptions): RouterRuntime {
  const { manifest } = options;
  const indexes = buildRouteIndexes(manifest);
  const bypassTokens = collectBypassTokens(manifest);

  return {
    manifest,
    async handleRequest(request: Request): Promise<Response> {
      const incomingUrl = new URL(request.url);
      if (process.env.ADAPTER_BUN_DEBUG_REDIRECT === '1') {
        console.log('[adapter-bun][req]', {
          method: request.method,
          url: incomingUrl.toString(),
          rsc: request.headers.get('rsc'),
          xNextjsData: request.headers.get('x-nextjs-data'),
          xMiddlewarePrefetch: request.headers.get('x-middleware-prefetch'),
          nextAction: request.headers.get('next-action'),
        });
      }
      if (isMalformedEncodedPathname(incomingUrl.pathname)) {
        return new Response('Bad Request', {
          status: 400,
          headers: {
            'content-type': 'text/plain; charset=utf-8',
          },
        });
      }

      if (
        process.env.ADAPTER_BUN_DEBUG_BODY === '1' &&
        request.method.toUpperCase() === 'OPTIONS'
      ) {
        const debugUrl = new URL(request.url);
        if (debugUrl.pathname.includes('/advanced/body/json')) {
          let ingressBodyLength = -1;
          try {
            ingressBodyLength = (await request.clone().arrayBuffer()).byteLength;
          } catch {
            ingressBodyLength = -2;
          }
          console.log('[adapter-bun][router][ingress-body]', {
            method: request.method,
            pathname: debugUrl.pathname,
            contentLengthHeader: request.headers.get('content-length'),
            contentTypeHeader: request.headers.get('content-type'),
            hasBodyStream: request.body !== null,
            ingressBodyLength,
          });
        }
      }
      const onDemandRevalidate = parseOnDemandRevalidateRequest({
        request,
        revalidateAuthToken: options.revalidateAuthToken,
        bypassTokens,
      });
      const previouslyRevalidatedTagSet = new Set(
        parsePreviouslyRevalidatedTags({ request, bypassTokens })
      );

      const manualRevalidateResponse = await maybeHandleManualRevalidateRequest({
        options,
        request,
      });
      if (manualRevalidateResponse) {
        return withRouteMetadata(manualRevalidateResponse, {
          kind: 'function',
          id: 'revalidate-endpoint',
        });
      }

      let middlewareResponse: Response | null = null;
      let middlewareRewriteUrl: URL | null = null;
      let middlewareRequestHeaders: Headers | null = null;
      let middlewareResponseHeaders: Headers | null = null;
  const {
    headers: incomingRequestHeaders,
    didStrip: didStripIncomingMiddlewareHeaders,
  } = sanitizeIncomingMiddlewareRequestHeaders(request.headers);
      const internalMiddlewareRequestHeaders =
        collectInternalMiddlewareRequestHeaders(incomingRequestHeaders);
      const debugMiddleware =
        process.env.ADAPTER_BUN_DEBUG_MW === '1' ||
        process.env.ADAPTER_BUN_DEBUG_BODY === '1';

      const unresolvedResolution = await resolveRoutes({
        url: new URL(request.url),
        buildId: manifest.build.buildId,
        basePath: manifest.build.basePath,
        requestBody: toResolveRoutesRequestBody(request),
        headers: new Headers(incomingRequestHeaders),
        pathnames: manifest.pathnames,
        i18n: toResolutionI18nConfig(manifest),
        routes: toResolutionRoutes(manifest),
        invokeMiddleware: async (ctx) => {
          const normalizedMiddlewareUrl = normalizeMiddlewareInvocationUrl({
            url: ctx.url,
            basePath: manifest.build.basePath,
            buildId: manifest.build.buildId,
            trailingSlash: manifest.build.trailingSlash,
            sourceRequestUrl: new URL(request.url),
            i18n: manifest.build.i18n,
          });
          const middlewareHeaders = stripInternalMiddlewareRequestHeaders(
            ctx.headers
          );
          const middlewareCtx = {
            ...ctx,
            url: normalizedMiddlewareUrl,
            headers: middlewareHeaders,
            method: request.method.toUpperCase(),
          };
          let result: RouterMiddlewareResult | {} =
            (await options.invokeMiddleware?.(middlewareCtx)) ?? {};
          if ('rewrite' in result && result.rewrite instanceof URL) {
            const normalizedRewrite = normalizeLoopbackRewriteUrl({
              rewriteUrl: result.rewrite,
              requestUrl: ctx.url,
            });
            if (normalizedRewrite.toString() !== result.rewrite.toString()) {
              result = {
                ...result,
                rewrite: normalizedRewrite,
              };
            }
          }
          let restoredRequestHeaders: Headers | null = null;

          if ('rewrite' in result && result.rewrite instanceof URL) {
            middlewareRewriteUrl = result.rewrite;
          }
          if ('requestHeaders' in result && result.requestHeaders instanceof Headers) {
            restoredRequestHeaders = restoreInternalMiddlewareRequestHeaders({
              requestHeaders: result.requestHeaders,
              internalHeaders: internalMiddlewareRequestHeaders,
            });
            middlewareRequestHeaders = restoredRequestHeaders;
          }
          if ('responseHeaders' in result && result.responseHeaders instanceof Headers) {
            middlewareResponseHeaders = result.responseHeaders;
          }
          if ('response' in result && result.response) {
            middlewareResponse = normalizeMiddlewareErrorResponse(result.response);
          }
          if (debugMiddleware) {
            const debugUrl = new URL(ctx.url.toString());
            if (
              debugUrl.pathname.includes('/rewrite-to-dynamic') ||
              debugUrl.pathname.includes('/rewrite-to-config-rewrite') ||
              debugUrl.pathname.includes('/rewrite-to-app') ||
              debugUrl.pathname.includes('/rewrite-1') ||
              debugUrl.searchParams.has('draft')
            ) {
              const responseHeaders =
                'response' in result && result.response
                  ? Object.fromEntries(result.response.headers.entries())
                  : null;
              console.log('[adapter-bun][middleware][result]', {
                url: debugUrl.toString(),
                hasRewrite:
                  'rewrite' in result && result.rewrite instanceof URL,
                rewrite:
                  'rewrite' in result && result.rewrite instanceof URL
                    ? result.rewrite.toString()
                    : null,
                requestHeaders:
                  'requestHeaders' in result && result.requestHeaders instanceof Headers
                    ? Object.fromEntries(result.requestHeaders.entries())
                    : null,
                responseHeaders,
              });
            }
          }
          const middlewareResult = stripMiddlewareResponse(result);
          if (restoredRequestHeaders) {
            return {
              ...middlewareResult,
              requestHeaders: restoredRequestHeaders,
            };
          }
          return middlewareResult;
        },
      });

      let resolution = stripRequestHeaderEchoes({
        resolution: unresolvedResolution,
        requestHeaders: incomingRequestHeaders,
      });
      resolution = withLocalizedNextDataResolutionHeaders({
        resolution,
        requestUrl: new URL(request.url),
        basePath: manifest.build.basePath,
        buildId: manifest.build.buildId,
        i18n: manifest.build.i18n,
      });
      const resolvedMiddlewareRequestHeaders =
        middlewareRequestHeaders as Headers | null;
      const resolvedMiddlewareRewriteUrl =
        middlewareRewriteUrl as URL | null;
      if (process.env.ADAPTER_BUN_DEBUG_REDIRECT === '1') {
        const debugRedirectUrl = new URL(request.url);
        const middlewareResponseForDebug = middlewareResponse as Response | null;
        if (
          debugRedirectUrl.pathname === '/' ||
          debugRedirectUrl.pathname === '/fr' ||
          debugRedirectUrl.pathname === '/to' ||
          debugRedirectUrl.pathname === '/nl/to'
        ) {
          console.log('[adapter-bun][redirect][resolution]', {
            requestUrl: debugRedirectUrl.toString(),
            middlewareResponded: resolution.middlewareResponded ?? false,
            redirect: resolution.redirect
              ? {
                  url: resolution.redirect.url.toString(),
                  status: resolution.redirect.status,
                }
              : null,
            resolvedLocationHeader:
              resolution.resolvedHeaders?.get('location') ?? null,
            middlewareResponse: middlewareResponseForDebug
              ? {
                  status: middlewareResponseForDebug.status,
                  location: middlewareResponseForDebug.headers.get('location'),
                  xMiddlewareRedirect:
                    middlewareResponseForDebug.headers.get('x-middleware-redirect'),
                }
              : null,
          });
        }
      }
      if (debugMiddleware) {
        const debugUrl = new URL(request.url);
        if (
          debugUrl.pathname.includes('/rewrite-to-dynamic') ||
          debugUrl.pathname.includes('/rewrite-to-config-rewrite') ||
          debugUrl.pathname.includes('/rewrite-to-app') ||
          debugUrl.pathname.includes('/rewrite-1') ||
          debugUrl.searchParams.has('draft')
        ) {
          console.log('[adapter-bun][middleware][resolution]', {
            requestUrl: debugUrl.toString(),
            matchedPathname: unresolvedResolution.matchedPathname ?? null,
            routeMatches: unresolvedResolution.routeMatches ?? null,
            middlewareRewriteUrl:
              resolvedMiddlewareRewriteUrl?.toString() ?? null,
            middlewareRequestHeaders: resolvedMiddlewareRequestHeaders
              ? Object.fromEntries(resolvedMiddlewareRequestHeaders.entries())
              : null,
            resolvedHeaders: unresolvedResolution.resolvedHeaders
              ? Object.fromEntries(unresolvedResolution.resolvedHeaders.entries())
              : null,
          });
        }
      }
      const nextDataRewriteHeader = resolveNextDataRewriteHeader({
        request,
        rewriteUrl: resolvedMiddlewareRewriteUrl,
        basePath: manifest.build.basePath,
        buildId: manifest.build.buildId,
      });
      if (
        nextDataRewriteHeader &&
        resolution.resolvedHeaders?.has('x-nextjs-rewrite') !== true
      ) {
        resolution = withResolvedHeader(
          resolution,
          'x-nextjs-rewrite',
          nextDataRewriteHeader
        );
      }
      if (
        resolvedMiddlewareRequestHeaders &&
        resolvedMiddlewareRequestHeaders.has('x-middleware-set-cookie') &&
        resolution.resolvedHeaders?.has('x-middleware-set-cookie') !== true
      ) {
        resolution = withResolvedHeader(
          resolution,
          'x-middleware-set-cookie',
          resolvedMiddlewareRequestHeaders.get('x-middleware-set-cookie') ?? ''
        );
      }
      let requestWithMiddlewareMutations = withMiddlewareRequestMutations({
        request,
        rewriteUrl: resolvedMiddlewareRewriteUrl,
        requestHeaders:
          resolvedMiddlewareRequestHeaders ??
          (didStripIncomingMiddlewareHeaders ? incomingRequestHeaders : null),
        basePath: manifest.build.basePath,
        buildId: manifest.build.buildId,
      });
      const originalRequestUrl = new URL(request.url);
      const mutatedRequestUrl = new URL(requestWithMiddlewareMutations.url);
      const didInternalMiddlewareRewrite =
        resolvedMiddlewareRewriteUrl !== null &&
        resolvedMiddlewareRewriteUrl.origin === originalRequestUrl.origin &&
        (resolvedMiddlewareRewriteUrl.pathname !== originalRequestUrl.pathname ||
          resolvedMiddlewareRewriteUrl.search !== originalRequestUrl.search);
      const effectiveRouteMatches = resolution.routeMatches;

      if (resolution.redirect) {
        const redirectResolution = withoutResolvedLocationHeader(resolution);
        const redirectRequestUrl = new URL(requestWithMiddlewareMutations.url);
        const redirectLocation = toRedirectLocation({
          redirectUrl: resolution.redirect.url,
          requestUrl: redirectRequestUrl,
        });
        const redirectPathnameWithoutBasePath = resolveRequestPathnameWithoutBasePath({
          requestPathname: redirectRequestUrl.pathname,
          basePath: manifest.build.basePath,
        });
        const isNextDataRedirectRequest =
          redirectPathnameWithoutBasePath.startsWith(
            `/_next/data/${manifest.build.buildId}/`
          ) && redirectPathnameWithoutBasePath.endsWith('.json');
        const redirectHeaders = new Headers();
        if (isNextDataRedirectRequest) {
          redirectHeaders.set(
            'x-nextjs-redirect',
            withLocalizedNextDataRedirect({
              redirectLocation,
              requestUrl: redirectRequestUrl,
              basePath: manifest.build.basePath,
              buildId: manifest.build.buildId,
              i18n: manifest.build.i18n,
            })
          );
        } else {
          redirectHeaders.set('location', redirectLocation);
        }
        if (process.env.ADAPTER_BUN_DEBUG_REDIRECT === '1') {
          console.log('[adapter-bun][redirect]', {
            requestUrl: redirectRequestUrl.toString(),
            redirectUrl: resolution.redirect.url.toString(),
            resolvedLocationHeader:
              resolution.resolvedHeaders?.get('location') ?? null,
            redirectLocation,
          });
        }
        const response = new Response(null, {
          status: resolution.redirect.status,
          headers: redirectHeaders,
        });
        return withRouteMetadata(
          applyResolutionToResponse(
            response,
            redirectResolution,
            resolution.redirect.status
          ),
          { kind: 'redirect' }
        );
      }

      if (resolution.externalRewrite) {
        if (options.handleExternalRewrite) {
          const response = await options.handleExternalRewrite({
            request,
            resolution,
            targetUrl: resolution.externalRewrite,
          });
          return withRouteMetadata(applyResolutionToResponse(response, resolution), {
            kind: 'external-rewrite',
          });
        }

        return withRouteMetadata(
          applyResolutionToResponse(
            new Response('External rewrite handling is not configured', {
              status: 502,
              headers: { 'content-type': 'text/plain; charset=utf-8' },
            }),
            resolution,
            502
          ),
          { kind: 'external-rewrite' }
        );
      }

      if (resolution.middlewareResponded) {
        const response =
          middlewareResponse ??
          new Response('Middleware response payload was not provided', {
            status: 500,
            headers: { 'content-type': 'text/plain; charset=utf-8' },
          });
        return withRouteMetadata(applyResolutionToResponse(response, resolution), {
          kind: 'middleware',
        });
      }

      if (isRedirectResolution(resolution)) {
        let redirectResolution = resolution;
        const redirectLocationHeader =
          redirectResolution.resolvedHeaders?.get('location');
        if (redirectLocationHeader) {
          try {
            const normalizedLocation = toRedirectLocation({
              redirectUrl: new URL(redirectLocationHeader, mutatedRequestUrl),
              requestUrl: mutatedRequestUrl,
            });
            if (normalizedLocation !== redirectLocationHeader) {
              redirectResolution = withResolvedHeader(
                redirectResolution,
                'location',
                normalizedLocation
              );
            }
          } catch {
            // Leave malformed redirect locations untouched so upstream behavior
            // remains observable to callers/tests.
          }
        }
        const redirectPathnameWithoutBasePath = resolveRequestPathnameWithoutBasePath({
          requestPathname: mutatedRequestUrl.pathname,
          basePath: manifest.build.basePath,
        });
        const isNextDataRedirectRequest =
          redirectPathnameWithoutBasePath.startsWith(
            `/_next/data/${manifest.build.buildId}/`
          ) && redirectPathnameWithoutBasePath.endsWith('.json');
        if (isNextDataRedirectRequest) {
          const redirectHeaders = new Headers(redirectResolution.resolvedHeaders);
          const normalizedLocation = redirectHeaders.get('location');
          if (normalizedLocation) {
            redirectHeaders.delete('location');
            redirectHeaders.set(
              'x-nextjs-redirect',
              withLocalizedNextDataRedirect({
                redirectLocation: normalizedLocation,
                requestUrl: mutatedRequestUrl,
                basePath: manifest.build.basePath,
                buildId: manifest.build.buildId,
                i18n: manifest.build.i18n,
              })
            );
            redirectResolution = {
              ...redirectResolution,
              resolvedHeaders: redirectHeaders,
            };
          }
        }
        if (
          process.env.ADAPTER_BUN_DEBUG_REDIRECT === '1' &&
          mutatedRequestUrl.pathname.includes('/_next/data/')
        ) {
          console.log('[adapter-bun][redirect][next-data]', {
            requestUrl: mutatedRequestUrl.toString(),
            status: redirectResolution.status,
            location: redirectResolution.resolvedHeaders?.get('location') ?? null,
            xNextjsRedirect:
              redirectResolution.resolvedHeaders?.get('x-nextjs-redirect') ?? null,
          });
        }
        return withRouteMetadata(
          applyResolutionToResponse(
            new Response(null, { status: redirectResolution.status }),
            redirectResolution,
            redirectResolution.status
          ),
          { kind: 'redirect' }
        );
      }

      const requestUrl = mutatedRequestUrl;
      if (isImageOptimizationPath(requestUrl.pathname, manifest.build.basePath)) {
        if (!options.invokeImageFunction) {
          return withRouteMetadata(
            applyResolutionToResponse(
              new Response('Image optimization handling is not configured', {
                status: 502,
                headers: { 'content-type': 'text/plain; charset=utf-8' },
              }),
              resolution,
              502
            ),
            { kind: 'image', id: 'image-optimizer' }
          );
        }

        const imageContext = {
          request,
          matchedPathname: toImageRoutePath(manifest.build.basePath),
          routeMatches: effectiveRouteMatches,
          resolution,
          source: 'image' as const,
        };
        const cacheConfig = options.imageCache;

        if (!cacheConfig) {
          const response = await options.invokeImageFunction({
            ...imageContext,
            cacheState: undefined,
          });
          return withRouteMetadata(
            applyResolutionToResponse(response, resolution, response.status),
            { kind: 'image', id: 'image-optimizer' }
          );
        }

        const now = cacheConfig.now?.() ?? Date.now();
        const cacheKey = createImageCacheKey(request, manifest.build.basePath);
        const bypass = shouldBypassImageCache(
          request,
          cacheKey,
          cacheConfig.shouldBypassCache
        );

        if (!bypass) {
          const cachedEntry = await cacheConfig.store.get(cacheKey.key);
          const cacheResult = evaluateImageCacheEntry({ entry: cachedEntry, now });

          if (cacheResult.kind === 'fresh') {
            const cachedResponse = imageCacheEntryToResponse(cacheResult.entry);
            return withRouteMetadata(
              withCacheState(
                applyResolutionToResponse(cachedResponse, resolution, cachedResponse.status),
                'HIT'
              ),
              { kind: 'image', id: 'image-optimizer' }
            );
          }

          if (cacheResult.kind === 'stale') {
            void refreshImageCache({
              options,
              request: new Request(request),
              resolution,
            }).catch(() => undefined);
            const cachedResponse = imageCacheEntryToResponse(cacheResult.entry);
            return withRouteMetadata(
              withCacheState(
                applyResolutionToResponse(cachedResponse, resolution, cachedResponse.status),
                'STALE'
              ),
              { kind: 'image', id: 'image-optimizer' }
            );
          }
        }

        const generatedResponse = await options.invokeImageFunction({
          ...imageContext,
          cacheState: bypass ? 'BYPASS' : 'MISS',
        });

        if (!bypass) {
          const shouldCache =
            cacheConfig.shouldCacheResponse?.(generatedResponse, cacheKey) ??
            defaultShouldCacheImageResponse(generatedResponse);
          if (shouldCache) {
            const cacheEntry = await responseToImageCacheEntry({
              cacheKey: cacheKey.key,
              pathname: cacheKey.pathname,
              response: generatedResponse.clone(),
              now,
              ttlSeconds: cacheConfig.ttlSeconds,
              staleTtlSeconds: cacheConfig.staleTtlSeconds,
            });
            await cacheConfig.store.set(cacheKey.key, cacheEntry);
          }
        }

        const resolvedResponse = applyResolutionToResponse(
          generatedResponse,
          resolution,
          generatedResponse.status
        );
        return withRouteMetadata(
          withCacheState(resolvedResponse, bypass ? 'BYPASS' : 'MISS'),
          { kind: 'image', id: 'image-optimizer' }
        );
      }

      let matchedPathname = resolution.matchedPathname;
      if (!matchedPathname) {
        matchedPathname = maybeResolveDirectPathnameFallback({
          requestPathname: requestUrl.pathname,
          indexes,
        }) ?? undefined;
      }
      if (!matchedPathname) {
        matchedPathname = maybeResolveNextDataFallbackPathname({
          requestPathname: requestUrl.pathname,
          basePath: manifest.build.basePath,
          buildId: manifest.build.buildId,
          indexes,
        }) ?? undefined;
      }
      if (!matchedPathname) {
        const notFoundRequestInfo = analyzeNotFoundRequest({
          requestPathname: requestUrl.pathname,
          basePath: manifest.build.basePath,
        });
        if (
          shouldAttemptAppNotFoundFunction({
            requestPathname: requestUrl.pathname,
            basePath: manifest.build.basePath,
          })
        ) {
          const appNotFoundResponse = await maybeServeAppNotFound({
            request: requestWithMiddlewareMutations,
            resolution,
            indexes,
            options,
            routeMatches: effectiveRouteMatches,
          });
          if (appNotFoundResponse) {
            return appNotFoundResponse;
          }
        }

        if (shouldAttemptPagesNotFoundRoute(notFoundRequestInfo)) {
          const pages404Pathname = '/404';
          const pagesNotFoundStaticAsset =
            indexes.staticByPathname.get(pages404Pathname);
          if (pagesNotFoundStaticAsset) {
            const pagesNotFoundResponse = await options.serveStatic({
              request: requestWithMiddlewareMutations,
              matchedPathname: pages404Pathname,
              routeMatches: undefined,
              resolution,
              asset: pagesNotFoundStaticAsset,
              source: 'static',
            });
            return withRouteMetadata(
              withRscVaryForRequest(
                applyResolutionToResponse(
                  pagesNotFoundResponse,
                  resolution,
                  resolution.status ?? 404
                ),
                requestWithMiddlewareMutations
              ),
              {
                kind: 'not-found',
                id: pagesNotFoundStaticAsset.id,
              }
            );
          }

          const pagesNotFoundPrerender = indexes.prerenderByPathname.get(pages404Pathname);
          if (pagesNotFoundPrerender) {
            const pagesNotFoundParentOutput = indexes.functionById.get(
              pagesNotFoundPrerender.parentOutputId
            );
            if (pagesNotFoundParentOutput) {
              const pagesNotFoundResponse = await options.invokeFunction({
                request: requestWithMiddlewareMutations,
                matchedPathname: pages404Pathname,
                routeMatches: undefined,
                resolution,
                output: pagesNotFoundParentOutput,
                source: 'prerender-parent',
                prerenderSeed: pagesNotFoundPrerender,
                cacheState: undefined,
              });
              return withRouteMetadata(
                withRscVaryForRequest(
                  applyResolutionToResponse(
                    pagesNotFoundResponse,
                    resolution,
                    resolution.status ?? 404
                  ),
                  requestWithMiddlewareMutations
                ),
                {
                  kind: 'not-found',
                  id: pagesNotFoundPrerender.id,
                }
              );
            }
          }

          const pagesNotFoundOutput = indexes.functionByPathname.get(pages404Pathname);
          if (pagesNotFoundOutput) {
            const pagesNotFoundResponse = await options.invokeFunction({
              request: requestWithMiddlewareMutations,
              matchedPathname: pages404Pathname,
              routeMatches: undefined,
              resolution,
              output: pagesNotFoundOutput,
              source: 'function',
              prerenderSeed: null,
              cacheState: undefined,
            });
            return withRouteMetadata(
              withRscVaryForRequest(
                applyResolutionToResponse(
                  pagesNotFoundResponse,
                  resolution,
                  resolution.status ?? 404
                ),
                requestWithMiddlewareMutations
              ),
              {
                kind: 'not-found',
                id: pagesNotFoundOutput.id,
              }
            );
          }
        }

        const notFoundBody = resolveDefaultNotFoundBody({
          requestInfo: notFoundRequestInfo,
          hasBasePath: manifest.build.basePath.length > 0,
        });
        const response = options.handleNotFound
          ? await options.handleNotFound({
            request: requestWithMiddlewareMutations,
            resolution,
          })
          : notFoundResponse({
            status: resolution.status ?? 404,
            body: notFoundBody,
          });
        return withRouteMetadata(applyResolutionToResponse(response, resolution), {
          kind: 'not-found',
        });
      }

      // Pages Router can emit root as "/index", while App Router commonly
      // keeps it as "/". Prefer "/" when present and only fall back to
      // "/index" when "/" has no output binding.
      const requestPathnameWithoutBasePath = resolveRequestPathnameWithoutBasePath({
        requestPathname: requestUrl.pathname,
        basePath: manifest.build.basePath,
      });
      const isNextDataRequestPathname =
        requestPathnameWithoutBasePath.startsWith(
          `/_next/data/${manifest.build.buildId}/`
        ) && requestPathnameWithoutBasePath.endsWith('.json');
      if (
        isNextDataRequestPathname &&
        matchedPathname &&
        (matchedPathname === '/api' || matchedPathname.startsWith('/api/'))
      ) {
        return withRouteMetadata(
          applyResolutionToResponse(
            notFoundResponse({
              status: resolution.status ?? 404,
              body: 'Not Found',
            }),
            resolution,
            resolution.status ?? 404
          ),
          { kind: 'not-found' }
        );
      }

      const normalizedMatchedPathname =
        matchedPathname === '/'
          ? !hasOutputPathname(indexes, '/') && hasOutputPathname(indexes, '/index')
            ? '/index'
            : '/'
          : matchedPathname;

      let resolvedMatchedPathname = maybeResolveRscMatchedPathname({
        request,
        matchedPathname: normalizedMatchedPathname,
        manifest,
        indexes,
      });
      resolvedMatchedPathname = maybePreferExactMatchedPathname({
        request: requestWithMiddlewareMutations,
        matchedPathname: resolvedMatchedPathname,
        manifest,
        indexes,
      });
      let resolvedRouteMatches = normalizeRouteMatchesForPathname({
        matchedPathname: resolvedMatchedPathname,
        routeMatches: effectiveRouteMatches,
      });
      resolvedMatchedPathname = maybeResolveConcreteMatchedPathname({
        matchedPathname: resolvedMatchedPathname,
        routeMatches: resolvedRouteMatches,
        indexes,
        i18n: manifest.build.i18n,
      });
      const hydratedRouteMatches = hydrateMissingSingleSegmentDynamicRouteMatches({
        matchedPathname: resolvedMatchedPathname,
        routeMatches: resolvedRouteMatches,
        requestPathname: mutatedRequestUrl.pathname,
        basePath: manifest.build.basePath,
        buildId: manifest.build.buildId,
      });
      requestWithMiddlewareMutations = withResolvedNextDataRequestPath({
        request: requestWithMiddlewareMutations,
        matchedPathname: resolvedMatchedPathname,
        routeMatches: hydratedRouteMatches,
        basePath: manifest.build.basePath,
        buildId: manifest.build.buildId,
      });
      if (debugMiddleware) {
        const debugUrl = new URL(request.url);
        if (debugUrl.pathname.includes('/rewrite-to-app')) {
          console.log('[adapter-bun][middleware][route-selection]', {
            requestUrl: debugUrl.toString(),
            mutatedRequestUrl: requestWithMiddlewareMutations.url,
            didInternalMiddlewareRewrite,
            initialMatchedPathname: resolution.matchedPathname ?? null,
            fallbackMatchedPathname: matchedPathname ?? null,
            normalizedMatchedPathname,
            resolvedMatchedPathname,
            hasStatic: indexes.staticByPathname.has(resolvedMatchedPathname),
            hasPrerender: indexes.prerenderByPathname.has(resolvedMatchedPathname),
            hasFunction: indexes.functionByPathname.has(resolvedMatchedPathname),
            resolvedRouteMatches,
            hydratedRouteMatches,
          });
        }
        if (debugUrl.pathname.includes('/rewrite-1')) {
          console.log('[adapter-bun][middleware][route-selection]', {
            requestUrl: debugUrl.toString(),
            mutatedRequestUrl: requestWithMiddlewareMutations.url,
            didInternalMiddlewareRewrite,
            initialMatchedPathname: resolution.matchedPathname ?? null,
            fallbackMatchedPathname: matchedPathname ?? null,
            normalizedMatchedPathname,
            resolvedMatchedPathname,
            hasStatic: indexes.staticByPathname.has(resolvedMatchedPathname),
            hasPrerender: indexes.prerenderByPathname.has(resolvedMatchedPathname),
            hasFunction: indexes.functionByPathname.has(resolvedMatchedPathname),
            resolvedRouteMatches,
            hydratedRouteMatches,
          });
        }
        if (debugUrl.pathname.includes('/rewrite-to-dynamic')) {
          console.log('[adapter-bun][middleware][route-selection]', {
            requestUrl: debugUrl.toString(),
            mutatedRequestUrl: requestWithMiddlewareMutations.url,
            didInternalMiddlewareRewrite,
            initialMatchedPathname: resolution.matchedPathname ?? null,
            fallbackMatchedPathname: matchedPathname ?? null,
            normalizedMatchedPathname,
            resolvedMatchedPathname,
            hasStatic: indexes.staticByPathname.has(resolvedMatchedPathname),
            hasPrerender: indexes.prerenderByPathname.has(resolvedMatchedPathname),
            hasFunction: indexes.functionByPathname.has(resolvedMatchedPathname),
            resolvedRouteMatches,
            hydratedRouteMatches,
          });
        }
        if (debugUrl.pathname.includes('/rewrite-to-config-rewrite')) {
          console.log('[adapter-bun][middleware][route-selection]', {
            requestUrl: debugUrl.toString(),
            mutatedRequestUrl: requestWithMiddlewareMutations.url,
            didInternalMiddlewareRewrite,
            initialMatchedPathname: resolution.matchedPathname ?? null,
            fallbackMatchedPathname: matchedPathname ?? null,
            normalizedMatchedPathname,
            resolvedMatchedPathname,
            hasStatic: indexes.staticByPathname.has(resolvedMatchedPathname),
            hasPrerender: indexes.prerenderByPathname.has(resolvedMatchedPathname),
            hasFunction: indexes.functionByPathname.has(resolvedMatchedPathname),
            resolvedRouteMatches,
            hydratedRouteMatches,
          });
        }
      }

      const staticAsset = indexes.staticByPathname.get(resolvedMatchedPathname);
      if (staticAsset) {
        const response = await options.serveStatic({
          request,
          matchedPathname: resolvedMatchedPathname,
          routeMatches: hydratedRouteMatches,
          resolution,
          asset: staticAsset,
          source: 'static',
        });
        let staticResponse = applyResolutionToResponse(response, resolution);
        // @next/routing's onMatch rules can override user-configured
        // headers from next.config.js and middleware response headers
        // (e.g. immutable cache-control for _next/static overwrites a
        // user's cache-control). Re-apply those authoritative headers
        // last so they win.
        const configHeaders = resolveConfigHeadersForPathname(
          manifest.routeGraph.beforeMiddleware as RouteWithRegex[],
          resolvedMatchedPathname
        );
        const resolvedMiddlewareResponseHeaders = middlewareResponseHeaders as Headers | null;
        if (configHeaders || resolvedMiddlewareResponseHeaders) {
          const overrideHeaders = new Headers(staticResponse.headers);
          if (configHeaders) {
            for (const [key, value] of Object.entries(configHeaders)) {
              overrideHeaders.set(key, value);
            }
          }
          // Middleware headers take highest priority
          if (resolvedMiddlewareResponseHeaders) {
            for (const [key, value] of resolvedMiddlewareResponseHeaders.entries()) {
              overrideHeaders.set(key, value);
            }
          }
          staticResponse = new Response(staticResponse.body, {
            status: staticResponse.status,
            statusText: staticResponse.statusText,
            headers: overrideHeaders,
          });
        }
        return withRouteMetadata(
          withRscVaryForRequest(
            staticResponse,
            requestWithMiddlewareMutations
          ),
          {
            kind: 'static',
            id: staticAsset.id,
          }
        );
      }

      const prerenderSeed = indexes.prerenderByPathname.get(resolvedMatchedPathname);
      if (prerenderSeed) {
        const cacheConfig = options.prerenderCache;
        const bypass = shouldBypassPrerenderCache(
          prerenderSeed,
          request,
          cacheConfig?.bypassTokenResolver
        );
        const supportsPrerenderCacheMethod = isGetOrHeadRequest(request);
        if (!supportsPrerenderCacheMethod && !bypass) {
          return withRouteMetadata(
            applyResolutionToResponse(
              new Response('Method Not Allowed', {
                status: 405,
                headers: {
                  allow: 'GET, HEAD',
                  'content-type': 'text/plain; charset=utf-8',
                },
              }),
              resolution,
              405
            ),
            { kind: 'prerender', id: prerenderSeed.id }
          );
        }

        if (onDemandRevalidate.kind === 'valid') {
          if (!cacheConfig) {
            return withRouteMetadata(
              new Response('Prerender cache is not configured for revalidation', {
                status: 503,
                headers: {
                  'content-type': 'text/plain; charset=utf-8',
                  'x-nextjs-cache': 'REVALIDATED',
                },
              }),
              { kind: 'prerender', id: prerenderSeed.id }
            );
          }

          const now = cacheConfig.now?.() ?? Date.now();
          const cacheKeyRequest = toPrerenderCacheKeyRequest(
            request,
            resolvedMatchedPathname
          );
          const cacheKey = createPrerenderCacheKey(prerenderSeed, cacheKeyRequest);
          const existingEntry = await cacheConfig.store.get(cacheKey.key);
          if (onDemandRevalidate.onlyGenerated && !existingEntry) {
            return withRouteMetadata(
              applyResolutionToResponse(
                new Response('This page could not be found', {
                  status: 404,
                  headers: {
                    'content-type': 'text/plain; charset=utf-8',
                    'x-nextjs-cache': 'REVALIDATED',
                  },
                }),
                resolution,
                404
              ),
              { kind: 'prerender', id: prerenderSeed.id }
            );
          }

          if (!existingEntry && prerenderSeed.parentFallbackMode === false) {
            return withRouteMetadata(
              applyResolutionToResponse(
                new Response('This page could not be found', {
                  status: 404,
                  headers: {
                    'content-type': 'text/plain; charset=utf-8',
                    'x-nextjs-cache': 'REVALIDATED',
                  },
                }),
                resolution,
                404
              ),
              { kind: 'prerender', id: prerenderSeed.id }
            );
          }

          const pathTags = toImplicitPathTags(prerenderSeed.pathname);
          if (cacheConfig.store.updateTagManifest) {
            await cacheConfig.store.updateTagManifest(pathTags, {
              mode: 'expire',
              now,
            });

            if (existingEntry) {
              const existingTags = parseCacheTagsHeader(
                existingEntry.headers[NEXT_CACHE_TAGS_HEADER]
              );
              if (existingTags.length > 0) {
                await cacheConfig.store.updateTagManifest(existingTags, {
                  mode: 'expire',
                  now,
                });
              }
            }
          }

          const parentOutput = indexes.functionById.get(prerenderSeed.parentOutputId);
          if (!parentOutput) {
            return withRouteMetadata(
              applyResolutionToResponse(
                new Response('Prerender parent function is missing', {
                  status: 500,
                  headers: {
                    'content-type': 'text/plain; charset=utf-8',
                    'x-nextjs-cache': 'REVALIDATED',
                  },
                }),
                resolution,
                500
              ),
              { kind: 'prerender', id: prerenderSeed.id }
            );
          }

          const invocationRequest = maybeFilterPrerenderRequestByAllowLists({
            seed: prerenderSeed,
            request: requestWithMiddlewareMutations,
          });
          const generatedResponse = await options.invokeFunction({
            request: invocationRequest,
            matchedPathname: resolvedMatchedPathname,
            routeMatches: hydratedRouteMatches,
            resolution,
            output: parentOutput,
            source: 'prerender-parent',
            prerenderSeed,
            cacheState: 'MISS',
          });

          const shouldCache =
            cacheConfig.shouldCacheResponse?.(generatedResponse, prerenderSeed) ??
            generatedResponse.status < 500;
          if (shouldCache && !isPrerenderResumeRequest(prerenderSeed, invocationRequest)) {
            const cacheEntry = await responseToPrerenderCacheEntry({
              seed: prerenderSeed,
              cacheKey: cacheKey.key,
              pathname: cacheKey.pathname,
              cacheQuery: cacheKey.query,
              cacheHeaders: cacheKey.headers,
              response: generatedResponse.clone(),
              now,
            });
            await cacheConfig.store.set(cacheKey.key, cacheEntry);
          }

          return withRouteMetadata(
            withHeader(
              applyResolutionToResponse(generatedResponse, resolution),
              'x-nextjs-cache',
              'REVALIDATED'
            ),
            { kind: 'prerender', id: prerenderSeed.id }
          );
        }

        if (options.handlePrerender) {
          const response = await options.handlePrerender({
            request,
            matchedPathname: resolvedMatchedPathname,
            routeMatches: hydratedRouteMatches,
            resolution,
            seed: prerenderSeed,
            parentOutput:
              indexes.functionById.get(prerenderSeed.parentOutputId) ?? null,
            source: 'prerender',
            cacheState: cacheConfig ? 'MISS' : undefined,
          });
          const resolvedResponse = applyResolutionToResponse(response, resolution);
          return withRouteMetadata(
            cacheConfig ? withCacheState(resolvedResponse, 'MISS') : resolvedResponse,
            { kind: 'prerender', id: prerenderSeed.id }
          );
        }

        if (cacheConfig) {
          const now = cacheConfig.now?.() ?? Date.now();
          const cacheKeyRequest = toPrerenderCacheKeyRequest(
            request,
            resolvedMatchedPathname
          );
          const cacheKey = createPrerenderCacheKey(prerenderSeed, cacheKeyRequest);

          if (!bypass) {
            const cachedEntry = await cacheConfig.store.get(cacheKey.key);
            const hadExistingEntry = Boolean(cachedEntry);
            const cacheResultBase = evaluatePrerenderCacheEntry({
              entry: cachedEntry,
              now,
            });
            let cacheResult = cacheResultBase;
            const cacheTags = cacheResultBase.entry
              ? parseCacheTagsHeader(
                  cacheResultBase.entry.headers[NEXT_CACHE_TAGS_HEADER]
                )
              : [];
            if (
              cacheResultBase.entry &&
              cacheTags.length > 0 &&
              cacheTags.some((tag) => previouslyRevalidatedTagSet.has(tag))
            ) {
              cacheResult = { kind: 'miss', entry: null };
            } else if (
              cacheResultBase.entry &&
              cacheConfig.store.getTagManifestEntries &&
              cacheTags.length > 0
            ) {
              const tagManifestEntries =
                await cacheConfig.store.getTagManifestEntries(cacheTags);
              const tagState = evaluatePrerenderTagManifestState({
                entryCreatedAt: cacheResultBase.entry.createdAt,
                tags: cacheTags,
                tagManifestEntries,
                now,
              });

              if (tagState === 'expired') {
                cacheResult = { kind: 'miss', entry: null };
              } else if (
                tagState === 'stale' &&
                cacheResultBase.kind === 'fresh'
              ) {
                cacheResult = { kind: 'stale', entry: cacheResultBase.entry };
              }
            }

            if (cacheResult.kind === 'fresh') {
              const cachedResponse = prerenderCacheEntryToResponse(cacheResult.entry);
              return withRouteMetadata(
                withCacheState(
                  applyResolutionToResponse(cachedResponse, resolution),
                  'HIT'
                ),
                { kind: 'prerender', id: prerenderSeed.id }
              );
            }

            if (cacheResult.kind === 'stale') {
              await enqueueRevalidate({
                options,
                cacheKey: cacheKey.key,
                seed: prerenderSeed,
                reason: 'STALE',
              });
              const cachedResponse = prerenderCacheEntryToResponse(cacheResult.entry);
              return withRouteMetadata(
                withCacheState(
                  applyResolutionToResponse(cachedResponse, resolution),
                  'STALE'
                ),
                { kind: 'prerender', id: prerenderSeed.id }
              );
            }

            if (!hadExistingEntry && prerenderSeed.fallback?.stagedPath && prerenderSeed.fallback.sourcePath) {
              const fallbackResponse = await options.serveStatic({
                request,
                matchedPathname: resolvedMatchedPathname,
                routeMatches: hydratedRouteMatches,
                resolution,
                source: 'static',
                cacheState: 'MISS',
                asset: {
                  id: `prerender-fallback:${prerenderSeed.id}`,
                  pathname: resolvedMatchedPathname,
                  sourceType: 'next-static',
                  sourcePath: prerenderSeed.fallback.sourcePath,
                  stagedPath: prerenderSeed.fallback.stagedPath,
                  objectKey: prerenderSeed.fallback.stagedPath,
                  contentType: null,
                  cacheControl: null,
                },
              });
              const seededFallbackResponse = applySeedFallbackHeaders(
                fallbackResponse,
                prerenderSeed
              );

              const parentOutput = indexes.functionById.get(
                prerenderSeed.parentOutputId
              );
              const resumeRequest = parentOutput
                ? maybeFilterPrerenderRequestByAllowLists({
                    seed: prerenderSeed,
                    request: toPrerenderParentRequest({
                      request: requestWithMiddlewareMutations,
                      seed: prerenderSeed,
                    }),
                  })
                : requestWithMiddlewareMutations;
              const hasPostponedStatePath =
                typeof prerenderSeed.fallback?.postponedStatePath === 'string' &&
                prerenderSeed.fallback.postponedStatePath.length > 0;
              const isFullyStaticPrerenderSeed =
                prerenderSeed.fallback?.initialRevalidate === false;
              const hasExplicitSeedTags = prerenderSeed.tags.some(
                (tag) => !tag.startsWith('_N_T_/')
              );
              const shouldAttemptInlineResume =
                Boolean(parentOutput) &&
                hasPostponedStatePath &&
                resumeRequest !== requestWithMiddlewareMutations;
              const shouldScheduleMissFallbackRevalidate =
                prerenderSeed.parentFallbackMode !== false &&
                (!isFullyStaticPrerenderSeed || hasExplicitSeedTags);
              const missFallbackCacheState = isFullyStaticPrerenderSeed
                ? 'HIT'
                : 'MISS';

              if (parentOutput && shouldAttemptInlineResume) {
                const resumeResponsePromise = Promise.resolve(
                  options.invokeFunction({
                    request: resumeRequest,
                    matchedPathname: resolvedMatchedPathname,
                    routeMatches: hydratedRouteMatches,
                    resolution,
                    output: parentOutput,
                    source: 'prerender-parent',
                    prerenderSeed,
                    cacheState: 'MISS',
                  })
                ).catch(async () => {
                  if (shouldScheduleMissFallbackRevalidate) {
                    await enqueueRevalidate({
                      options,
                      cacheKey: cacheKey.key,
                      seed: prerenderSeed,
                      reason: 'MISS_FALLBACK',
                    });
                  }
                  return null;
                });
                const mergedResponse = createFallbackBodyConcatenatedResponse({
                  fallbackResponse: seededFallbackResponse,
                  resumeResponsePromise,
                });
                return withRouteMetadata(
                  withCacheState(
                    applyResolutionToResponse(mergedResponse, resolution),
                    missFallbackCacheState
                  ),
                  { kind: 'prerender', id: prerenderSeed.id }
                );
              }

              if (shouldScheduleMissFallbackRevalidate) {
                await enqueueRevalidate({
                  options,
                  cacheKey: cacheKey.key,
                  seed: prerenderSeed,
                  reason: 'MISS_FALLBACK',
                });
              }

              const resolvedFallbackResponse = applyResolutionToResponse(
                seededFallbackResponse,
                resolution
              );
              const cachedFallbackResponse = withCacheState(
                resolvedFallbackResponse,
                missFallbackCacheState
              );
              const routedFallbackResponse = withRouteMetadata(
                cachedFallbackResponse,
                { kind: 'prerender', id: prerenderSeed.id }
              );
              return routedFallbackResponse;
            }

            if (!hadExistingEntry && prerenderSeed.parentFallbackMode === false) {
              const appNotFoundResponse = await maybeServeAppNotFound({
                request: requestWithMiddlewareMutations,
                resolution,
                indexes,
                options,
                routeMatches: hydratedRouteMatches,
              });
              if (appNotFoundResponse) {
                return withRouteMetadata(
                  withCacheState(applyResolutionToResponse(appNotFoundResponse, resolution, 404), 'MISS'),
                  { kind: 'prerender', id: prerenderSeed.id }
                );
              }
              return withRouteMetadata(
                withCacheState(
                  applyResolutionToResponse(
                    notFoundResponse({ status: 404 }),
                    resolution,
                    404
                  ),
                  'MISS'
                ),
                { kind: 'prerender', id: prerenderSeed.id }
              );
            }
          }

          const parentOutput = indexes.functionById.get(prerenderSeed.parentOutputId);
          if (!parentOutput) {
            return withRouteMetadata(
              withCacheState(
                applyResolutionToResponse(
                  new Response('Prerender parent function is missing', {
                    status: 500,
                    headers: { 'content-type': 'text/plain; charset=utf-8' },
                  }),
                  resolution,
                  500
                ),
                'MISS'
              ),
              { kind: 'prerender', id: prerenderSeed.id }
            );
          }

          const prerenderParentRequest = toPrerenderParentRequest({
            request: requestWithMiddlewareMutations,
            seed: prerenderSeed,
          });
          const invocationRequest = bypass
            ? prerenderParentRequest
            : maybeFilterPrerenderRequestByAllowLists({
                seed: prerenderSeed,
                request: prerenderParentRequest,
              });
          const generatedResponse = await options.invokeFunction({
            request: invocationRequest,
            matchedPathname: resolvedMatchedPathname,
            routeMatches: hydratedRouteMatches,
            resolution,
            output: parentOutput,
            source: 'prerender-parent',
            prerenderSeed,
            cacheState: bypass ? 'BYPASS' : 'MISS',
          });

          if (
            generatedResponse.status === 404 &&
            parentOutput.type === 'PAGES' &&
            shouldAttemptAppNotFoundFunction({
              requestPathname: requestUrl.pathname,
              basePath: manifest.build.basePath,
            })
          ) {
            const appNotFoundResponse = await maybeServeAppNotFound({
              request: requestWithMiddlewareMutations,
              resolution,
              indexes,
              options,
              routeMatches: hydratedRouteMatches,
            });
            if (appNotFoundResponse) {
              return withCacheState(appNotFoundResponse, bypass ? 'BYPASS' : 'MISS');
            }
          }

          if (!bypass) {
            const shouldCache =
              cacheConfig.shouldCacheResponse?.(generatedResponse, prerenderSeed) ??
              generatedResponse.status < 500;
            if (shouldCache && !isPrerenderResumeRequest(prerenderSeed, invocationRequest)) {
              const cacheEntry = await responseToPrerenderCacheEntry({
                seed: prerenderSeed,
                cacheKey: cacheKey.key,
                pathname: cacheKey.pathname,
                cacheQuery: cacheKey.query,
                cacheHeaders: cacheKey.headers,
                response: generatedResponse.clone(),
                now,
              });
              await cacheConfig.store.set(cacheKey.key, cacheEntry);
            }
          }

          return withRouteMetadata(
            withCacheState(
              applyResolutionToResponse(generatedResponse, resolution),
              bypass ? 'BYPASS' : 'MISS'
            ),
            { kind: 'prerender', id: prerenderSeed.id }
          );
        }

        if (prerenderSeed.fallback?.stagedPath && prerenderSeed.fallback.sourcePath) {
          const fallbackResponse = await options.serveStatic({
            request,
            matchedPathname: resolvedMatchedPathname,
            routeMatches: hydratedRouteMatches,
            resolution,
            source: 'static',
            cacheState: 'MISS',
            asset: {
              id: `prerender-fallback:${prerenderSeed.id}`,
              pathname: resolvedMatchedPathname,
              sourceType: 'next-static',
              sourcePath: prerenderSeed.fallback.sourcePath,
              stagedPath: prerenderSeed.fallback.stagedPath,
              objectKey: prerenderSeed.fallback.stagedPath,
              contentType: null,
              cacheControl: null,
            },
          });
          const seededFallbackResponse = applySeedFallbackHeaders(
            fallbackResponse,
            prerenderSeed
          );

          const parentOutput = indexes.functionById.get(prerenderSeed.parentOutputId);
          const resumeRequest = parentOutput
            ? maybeFilterPrerenderRequestByAllowLists({
                seed: prerenderSeed,
                request: toPrerenderParentRequest({
                  request: requestWithMiddlewareMutations,
                  seed: prerenderSeed,
                }),
              })
            : requestWithMiddlewareMutations;
          const hasPostponedStatePath =
            typeof prerenderSeed.fallback?.postponedStatePath === 'string' &&
            prerenderSeed.fallback.postponedStatePath.length > 0;
          const isFullyStaticPrerenderSeed =
            prerenderSeed.fallback?.initialRevalidate === false;
          const shouldAttemptInlineResume =
            Boolean(parentOutput) &&
            hasPostponedStatePath &&
            resumeRequest !== requestWithMiddlewareMutations;
          const missFallbackCacheState = isFullyStaticPrerenderSeed
            ? 'HIT'
            : 'MISS';

          if (parentOutput && shouldAttemptInlineResume) {
            const resumeResponsePromise = Promise.resolve(
              options.invokeFunction({
                request: resumeRequest,
                matchedPathname: resolvedMatchedPathname,
                routeMatches: hydratedRouteMatches,
                resolution,
                output: parentOutput,
                source: 'prerender-parent',
                prerenderSeed,
                cacheState: 'MISS',
              })
            ).catch(() => null);
            const mergedResponse = createFallbackBodyConcatenatedResponse({
              fallbackResponse: seededFallbackResponse,
              resumeResponsePromise,
            });
            return withRouteMetadata(
              withCacheState(
                applyResolutionToResponse(mergedResponse, resolution),
                missFallbackCacheState
              ),
              { kind: 'prerender', id: prerenderSeed.id }
            );
          }

          return withRouteMetadata(
            withCacheState(
              applyResolutionToResponse(seededFallbackResponse, resolution),
              missFallbackCacheState
            ),
            { kind: 'prerender', id: prerenderSeed.id }
          );
        }

        const parentOutput = indexes.functionById.get(prerenderSeed.parentOutputId);
        if (!parentOutput) {
          return withRouteMetadata(
            applyResolutionToResponse(
              new Response('Prerender parent function is missing', {
                status: 500,
                headers: { 'content-type': 'text/plain; charset=utf-8' },
              }),
              resolution,
              500
            ),
            { kind: 'prerender', id: prerenderSeed.id }
          );
        }

        const response = await options.invokeFunction({
          request: maybeFilterPrerenderRequestByAllowLists({
            seed: prerenderSeed,
            request: toPrerenderParentRequest({
              request: requestWithMiddlewareMutations,
              seed: prerenderSeed,
            }),
          }),
          matchedPathname: resolvedMatchedPathname,
          routeMatches: hydratedRouteMatches,
          resolution,
          output: parentOutput,
          source: 'prerender-parent',
          prerenderSeed,
          cacheState: 'MISS',
        });
        return withRouteMetadata(
          withCacheState(applyResolutionToResponse(response, resolution), 'MISS'),
          { kind: 'prerender', id: prerenderSeed.id }
        );
      }

      const output = indexes.functionByPathname.get(resolvedMatchedPathname);
      if (output) {
        const isNextDataMiddlewarePrefetchRequest =
          requestWithMiddlewareMutations.headers.get('x-nextjs-data') === '1' &&
          requestWithMiddlewareMutations.headers.get('x-middleware-prefetch') === '1' &&
          requestUrl.pathname.startsWith(`/_next/data/${manifest.build.buildId}/`) &&
          requestUrl.pathname.endsWith('.json');
        if (isNextDataMiddlewarePrefetchRequest) {
          return withRouteMetadata(
            applyResolutionToResponse(
              new Response('{}', {
                status: 200,
                headers: {
                  'content-type': 'application/json; charset=utf-8',
                  'x-nextjs-matched-path': resolvedMatchedPathname,
                  'x-middleware-skip': '1',
                  'cache-control':
                    'private, no-cache, no-store, max-age=0, must-revalidate',
                },
              }),
              resolution,
              200
            ),
            {
              kind: 'function',
              id: output.id,
            }
          );
        }

        for (const [ancestorPathname, allowedSeedPaths] of indexes.strictDynamicAncestorSeedPaths.entries()) {
          if (
            !isPathPatternAncestor({
              ancestorPathname,
              descendantPathname: output.pathname,
            })
          ) {
            continue;
          }

          const ancestorSeedPathname = deriveAncestorSeedPathname({
            requestPathname: requestUrl.pathname,
            ancestorPathname,
          });
          if (!ancestorSeedPathname) {
            continue;
          }

          if (!allowedSeedPaths.has(ancestorSeedPathname)) {
            const appNotFoundResponse = await maybeServeAppNotFound({
              request: requestWithMiddlewareMutations,
              resolution,
              indexes,
              options,
              routeMatches: hydratedRouteMatches,
            });
            if (appNotFoundResponse) {
              return appNotFoundResponse;
            }
            return withRouteMetadata(
              applyResolutionToResponse(
                notFoundResponse({ status: 404 }),
                resolution,
                404
              ),
              { kind: 'not-found' }
            );
          }
        }

        const response = await options.invokeFunction({
          request: requestWithMiddlewareMutations,
          matchedPathname: resolvedMatchedPathname,
          routeMatches: hydratedRouteMatches,
          resolution,
          output,
          source: 'function',
          prerenderSeed: null,
          cacheState: undefined,
        });
        if (
          output.type === 'PAGES' &&
          response.status === 404 &&
          shouldAttemptAppNotFoundFunction({
            requestPathname: requestUrl.pathname,
            basePath: manifest.build.basePath,
          })
        ) {
          const appNotFoundResponse = await maybeServeAppNotFound({
            request: requestWithMiddlewareMutations,
            resolution,
            indexes,
            options,
            routeMatches: hydratedRouteMatches,
          });
          if (appNotFoundResponse) {
            return appNotFoundResponse;
          }
        }
        return withRouteMetadata(
          withRscVaryForRequest(
            applyResolutionToResponse(response, resolution),
            requestWithMiddlewareMutations
          ),
          {
            kind: 'function',
            id: output.id,
          }
        );
      }

      if (
        resolvedMatchedPathname !== '/_not-found' &&
        shouldAttemptAppNotFoundFunction({
          requestPathname: requestUrl.pathname,
          basePath: manifest.build.basePath,
        })
      ) {
        const appNotFoundResponse = await maybeServeAppNotFound({
          request: requestWithMiddlewareMutations,
          resolution,
          indexes,
          options,
          routeMatches: hydratedRouteMatches,
        });
        if (appNotFoundResponse) {
          return appNotFoundResponse;
        }
      }

      const notFoundBody = resolveDefaultNotFoundBody({
        requestInfo: analyzeNotFoundRequest({
          requestPathname: requestUrl.pathname,
          basePath: manifest.build.basePath,
        }),
        hasBasePath: manifest.build.basePath.length > 0,
      });
      const response = options.handleNotFound
        ? await options.handleNotFound({
          request: requestWithMiddlewareMutations,
          resolution,
        })
        : notFoundResponse({
          status: resolution.status ?? 404,
          body: notFoundBody,
        });
      return withRouteMetadata(applyResolutionToResponse(response, resolution), {
        kind: 'not-found',
      });
    },
  };
}
