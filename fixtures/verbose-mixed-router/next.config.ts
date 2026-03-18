import type { NextConfig } from 'next';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const fixtureRoot = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

const adapterPath = require.resolve('adapter-bun');

const config: NextConfig = {
  adapterPath,
  turbopack: {
    root: fixtureRoot,
  },
  images: {
    path: '/_next/image',
    remotePatterns: [
      {
        protocol: 'https',
        hostname: 'assets.example.com',
        pathname: '/**',
      },
    ],
    localPatterns: [
      {
        pathname: '/images/**',
      },
    ],
    qualities: [70, 75],
  },
  async headers() {
    return [
      {
        source: '/cfg/:path*',
        headers: [
          {
            key: 'x-fixture-next-config-header',
            value: 'cfg',
          },
        ],
      },
      {
        source: '/pages-router/ssr',
        headers: [
          {
            key: 'x-fixture-ssr-header',
            value: 'from-next-config',
          },
        ],
      },
    ];
  },
  async redirects() {
    return [
      {
        source: '/cfg/redirect-old',
        destination: '/pages-router/static',
        permanent: false,
      },
    ];
  },
  async rewrites() {
    return {
      beforeFiles: [
        {
          source: '/cfg/rewrite-order/:id',
          destination: '/pages-router/ssr?from=before&id=:id',
        },
      ],
      afterFiles: [
        {
          source: '/cfg/rewrite-order/:id',
          destination: '/pages-router/products/:id',
        },
        {
          source: '/cfg/rewrite-after/:id',
          destination: '/pages-router/products/:id',
        },
      ],
      fallback: [
        {
          source: '/cfg/rewrite-fallback/:path*',
          destination: '/app-router/static',
        },
        {
          source: '/cfg/external',
          destination: 'https://example.vercel.sh',
        },
      ],
    };
  },
};

export default config;
