# adapter-bun

A Next.js adapter that runs your app on [Bun](https://bun.sh).

Takes the output of `next build` and produces a self-contained `bun-dist/` directory you can start with `bun bun-dist/server.js`.

## Quick start

Install the adapter alongside Next.js:

```bash
bun add adapter-bun
```

Point your `next.config.ts` at it:

```ts
import type { NextConfig } from 'next';

const config: NextConfig = {
  experimental: {
    adapterPath: require.resolve('adapter-bun'),
  },
};

export default config;
```

Build and run:

```bash
bun --bun next build
bun bun-dist/server.js
```

## Configuration

Pass options to `createBunAdapter()` in your adapter entry:

```ts
import { createBunAdapter } from 'adapter-bun';

export default createBunAdapter({
  outDir: 'bun-dist',       // output directory (default: 'bun-dist')
  port: 3000,               // listen port (default: 3000)
  hostname: '0.0.0.0',      // bind address (default: '0.0.0.0')
  deploymentHost: 'app.example.com', // CSRF allow-list for Server Actions
});
```

`deploymentHost` can also be set via the `BUN_ADAPTER_DEPLOYMENT_HOST` environment variable.

## What it supports

- **App Router** — static pages, dynamic SSR, streaming, `generateStaticParams`
- **Pages Router** — `getStaticProps`, `getServerSideProps`, `getStaticPaths` with fallback
- **API Routes** — both app route handlers and pages API routes
- **Middleware** — handled by Next.js' runtime
- **ISR** — time-based revalidation and on-demand revalidation via `revalidateTag()`, `revalidatePath()`, and `res.revalidate()`
- **Image optimization** — `next/image` backed by Sharp
- **Draft mode** — preview bypass cookies
- **`next.config` routing** — headers, redirects, rewrites (including external rewrites)
- **Mixed routers** — app and pages router in the same project

## How it works

### Build time

The adapter hooks into Next.js via the `onBuildComplete` callback. It takes the `.next/` build output and produces a deployment-ready directory:

```
bun-dist/
  server.js                 # entry point (Bun.serve)
  deployment-manifest.json  # assets, build metadata, runtime flags
  cache.db                  # SQLite cache for prerender and incremental data
  runtime-next-config.json  # serialized Next config for runtime boot
  static/                   # static assets (/_next/static + public/)
  runtime/                  # SQLite-backed cache handlers
```

Prerender seeds (SSG pages) are written into the SQLite cache during build so they are available immediately on first request.

### Runtime

`server.js` starts two layers:

1. **Public listener** — `Bun.serve` accepts incoming requests.
2. **Static fast path** — when the build has no middleware and no `beforeFiles` rewrites, `Bun.serve` can serve staged static assets directly from `bun-dist/static`.
3. **Next.js backend** — all other requests are proxied to an internal loopback `http.createServer`, which calls `app.getRequestHandler()`.
4. **Cache integration** — Next.js uses SQLite-backed cache handlers staged into `bun-dist/runtime`.

This keeps Bun at the edge of the deployment while still relying on Next.js' own runtime for routing, middleware, rendering, and rewrites when needed.

### Caching

The adapter uses SQLite (`cache.db`) for persistent caching:

- **Prerender cache** — stores rendered pages with TTL and tag-based invalidation
- **Incremental/cache-components data** — stored through Next.js cache handlers
- **Tag manifest** — tracks `revalidateTag()` / `revalidatePath()` invalidations
- **Revalidation locks** — prevents duplicate background regeneration

Cached bodies are stored as SQLite BLOBs rather than base64 text.

### On-demand revalidation

Three mechanisms are supported:

- **`revalidateTag(tag)`** / **`revalidatePath(path)`** from `next/cache`
- **`res.revalidate(path)`** for pages-router ISR

## Project structure

```
src/
  adapter.ts                # build hook + generated server template
  manifest.ts               # deployment manifest generation
  staging.ts                # stages assets and writes deployment files
  types.ts                  # adapter types
  runtime/
    cache-handler.ts        # Next.js cache-components handler
    cache-store.ts          # shared SQLite store access
    incremental-cache-handler.ts # Next.js incremental cache handler
    isr.ts                  # cache entry types
    sqlite-cache.ts         # SQLite cache stores
```

## Development

```bash
# build the adapter
bun run build

# type-check
bun run typecheck

# run live E2E checks against a real bun-dist server
cd fixtures/verbose-mixed-router
bun run build:e2e
```
