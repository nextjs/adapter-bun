import type { NextAdapter } from 'next';

export type BuildCompleteContext = Parameters<
  NonNullable<NextAdapter['onBuildComplete']>
>[0];

export interface BunAdapterOptions {
  /**
   * Relative output path under the project directory (or absolute path).
   */
  outDir?: string;
  /**
   * Port to listen on (written into deployment manifest).
   */
  port?: number;
  /**
   * Hostname to bind to (written into deployment manifest).
   */
  hostname?: string;
  /**
   * Canonical deployed host used for Server Actions CSRF allow-listing
   * (for example `app.example.com` or `https://app.example.com`).
   */
  deploymentHost?: string;
  /**
   * Cache transport used by Next's cache handlers. `http` is the default and
   * uses fetch against a Bun-owned cache endpoint so Edge runtimes avoid direct
   * Node/Bun storage imports. `sqlite` forces direct Bun-local SQLite access.
   */
  cacheHandlerMode?: 'sqlite' | 'http';
  /**
   * Internal path used when `cacheHandlerMode` is `http`.
   */
  cacheEndpointPath?: string;
  /**
   * Shared secret for the internal cache endpoint. If omitted in `http` mode,
   * the Bun server generates a random token at startup and injects it into the
   * runtime environment for the cache handlers.
   */
  cacheAuthToken?: string;
}

export interface BunStaticAsset {
  id: string;
  pathname: string;
  sourceType: 'next-static' | 'public';
  sourcePath: string;
  stagedPath: string;
  objectKey: string;
  contentType: string | null;
  cacheControl: string | null;
}

export interface BunDeploymentManifest {
  schemaVersion: 1;
  generatedAt: string;
  adapter: {
    name: string;
    outDir: string;
  };
  build: {
    buildId: string;
    nextVersion: string;
    projectDir: string;
    repoRoot: string;
    distDir: string;
    basePath: string;
    trailingSlash: boolean;
    i18n: BuildCompleteContext['config']['i18n'] | null;
  };
  server: {
    port: number;
    hostname: string;
  };
  pathnames: string[];
  runtime?: {
    previewProps?: {
      previewModeId: string;
      previewModeSigningKey: string;
      previewModeEncryptionKey: string;
    } | null;
  };
  staticAssets: BunStaticAsset[];
  summary: {
    staticAssetsTotal: number;
  };
}
