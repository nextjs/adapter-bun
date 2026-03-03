# verbose-mixed-router fixture

This fixture intentionally mixes App Router and Pages Router behaviors for Bun adapter conformance coverage.

## Included coverage

- App Router routes:
  - fully static page: `/app-router/static`
  - `next/image` page: `/app-router/image` (expects `/_next/image?...` URLs)
  - fully dynamic page: `/app-router/dynamic`
  - dynamic SSR page: `/app-router/ssr-dynamic/[slug]`
  - dynamic ISR page: `/app-router/isr-dynamic/[slug]`
  - streaming page with suspense boundaries: `/app-router/streaming`
  - cache-path target: `/app-router/cache-path`
  - cache-tag target: `/app-router/cache-tag`
- App Router route handlers:
  - static: `GET /api/app-static`
  - dynamic: `GET /api/app-dynamic`
- Pages Router pages:
  - fully static page: `/pages-router/static`
  - `getServerSideProps`: `/pages-router/ssr`
  - dynamic `getServerSideProps`: `/pages-router/ssr-dynamic/[id]`
  - `getStaticProps`: `/pages-router/ssg`
  - `getStaticPaths/getStaticProps`: `/pages-router/products/[id]`
- Draft mode coverage:
  - toggle endpoint: `GET/POST /api/draft-mode`
  - draft indicator + toggle controls are rendered on draft-capable routes
  - fully static routes (`/app-router/static`, `/pages-router/static`) do not render draft-mode indicators
- Middleware:
  - applies to app + pages routes
  - sets `x-fixture-middleware` and `x-fixture-pathname` headers
  - rewrite test route: `/middleware-rewrite -> /app-router/static`
- `next.config.ts` routing primitives:
  - headers route: `/cfg/:path*` sets `x-fixture-next-config-header: cfg`
  - redirect route: `/cfg/redirect-old -> /pages-router/static`
  - beforeFiles rewrite: `/cfg/rewrite-order/:id -> /pages-router/ssr`
  - afterFiles rewrite: `/cfg/rewrite-order/:id -> /pages-router/products/:id`
  - fallback rewrites:
    - `/cfg/rewrite-fallback/:path* -> /app-router/static`
    - `/cfg/external/:path* -> https://example.vercel.sh/:path*`

## Build and run

```bash
bun install
bun --bun next build
bun bun-dist/server.js
```

## Live E2E validation

Run against a real `bun-dist/server.js` process:

```bash
bun run build:e2e
```

Or build/start manually and execute only the assertions:

```bash
bun --bun next build
bun run e2e:live
```

## Revalidation endpoints

- Home page quick-actions:
  - `revalidateTag()` equivalent (`tagExpire: 0`)
  - `revalidateTag()` with stale time (`tagExpire: 120`)
  - `revalidatePath('/app-router/cache-path')`
  - `res.revalidate('/pages-router/ssg')`
- App Router revalidate endpoint (`revalidatePath`, `revalidateTag`):
  - `POST /api/revalidate-app`
  - body accepts
    - `{ "path": string, "paths": string[] }`
    - `{ "tag": string, "tags": string[] }` (`revalidateTag(...)`)
    - optional tag profile overrides:
      - `{ "tagProfile": "max" }`
      - `{ "tagExpire": number }` (translated to `revalidateTag(tag, { expire })`)
- Pages Router revalidate endpoint (`res.revalidate()`):
  - `POST /api/revalidate-pages`
  - body accepts `{ "path": string, "paths": string[] }`

If `REVALIDATE_SECRET` is set, both endpoints require either:

- `x-revalidate-secret` header, or
- `?secret=...` query parameter.

## Draft mode endpoint

- `GET /api/draft-mode`
  - returns current draft-mode status
- `POST /api/draft-mode`
  - body: `{ "enabled": true | false }`
  - toggles Next draft mode cookies via `res.setDraftMode(...)`
- UI behavior:
  - draft-capable routes show a Draft Mode panel with enable/disable controls and a live indicator
  - fully static routes intentionally omit that panel

## Validation checklist

1. Confirm middleware + routing:
   - `GET /middleware-rewrite` returns app static content.
   - Response contains `x-fixture-middleware`.
2. Confirm next.config rewrites/redirects/headers + route order:
   - `GET /cfg/rewrite-order/alpha` resolves to `/pages-router/ssr` (beforeFiles wins over afterFiles).
   - `GET /cfg/rewrite-after/alpha` resolves to `/pages-router/products/[id]`.
   - `GET /cfg/rewrite-fallback/foo/bar` resolves to `/app-router/static`.
   - `GET /cfg/redirect-old` returns redirect to `/pages-router/static`.
   - `GET /cfg/external` proxies to `https://example.vercel.sh/`.
   - response includes `x-fixture-next-config-header`.
   - request headers are not reflected back in response headers.
3. Confirm image optimization:
   - `GET /app-router/image` HTML references `/_next/image?...`.
   - `GET /_next/image?url=/images/fixture-landscape.png&w=640&q=75` returns optimized bytes.
   - disallowed remote hosts (not present in `images.remotePatterns`) are rejected.
4. Confirm Pages ISR:
   - `GET /pages-router/ssg` twice (expect cache hit behavior).
   - `POST /api/revalidate-pages` with `{ "path": "/pages-router/ssg" }`.
   - request `/pages-router/ssg` again and verify content timestamp changes.
   - `GET /_next/data/<build-id>/pages-router/ssg.json` behaves as prerender (MISS then HIT).
   - `GET /_next/data/<build-id>/pages-router/ssr.json` routes to function output.
5. Confirm Pages static routing is static (not ISR):
   - `GET /pages-router/static` returns as static asset.
   - response does not include ISR cache headers.
6. Confirm App Router tag/path revalidate:
   - `GET /app-router/cache-tag` and `/app-router/cache-path`.
   - `POST /api/revalidate-app` with `{ "tag": "app-router-tag" }` and `{ "path": "/app-router/cache-path" }`.
   - verify regenerated payloads.
7. Confirm server action bypass:
   - `POST /app-router/static` with `next-action` header bypasses prerender cache.
   - `POST /app-router/static` with `multipart/form-data` bypasses prerender cache.
   - `GET /app-router/static` with `__prerender_bypass` cookie bypasses prerender cache.
8. Confirm RSC routing and internal headers:
   - `GET /app-router/static` with `rsc: 1` routes to `/app-router/static.rsc`.
   - `GET /app-router/static` with `rsc: 1` + `next-router-segment-prefetch` routes to segment RSC output.
   - app responses should not expose `x-next-cache-tags`; tag tracking remains internal-only.
