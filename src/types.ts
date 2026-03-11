import type { NextAdapter } from 'next';

export type BuildCompleteContext = Parameters<
  NonNullable<NextAdapter['onBuildComplete']>
>[0];

export type BunRouteGraph = BuildCompleteContext['routing'];

type BuildCompleteMiddlewareOutput = NonNullable<
  BuildCompleteContext['outputs']['middleware']
>;
type BuildCompleteRouteOutput =
  | BuildCompleteContext['outputs']['pages'][number]
  | BuildCompleteContext['outputs']['pagesApi'][number]
  | BuildCompleteContext['outputs']['appPages'][number]
  | BuildCompleteContext['outputs']['appRoutes'][number];
type BuildCompletePrerenderOutput =
  BuildCompleteContext['outputs']['prerenders'][number];

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
}

export interface BunStaticAsset {
  id: string;
  pathname: string;
  sourceType: 'next-static' | 'public' | 'prerender';
  sourcePath: string;
  stagedPath: string;
  objectKey: string;
  status: number;
  headers?: Record<string, string>;
  contentType: string | null;
  cacheControl: string | null;
}

export interface BunMiddlewareArtifact {
  id: BuildCompleteMiddlewareOutput['id'];
  pathname: BuildCompleteMiddlewareOutput['pathname'];
  sourcePage: BuildCompleteMiddlewareOutput['sourcePage'];
  runtime: BuildCompleteMiddlewareOutput['runtime'];
  filePath: string;
  assets?: Record<string, string>;
  wasmAssets?: Record<string, string>;
  env?: NonNullable<BuildCompleteMiddlewareOutput['config']['env']>;
}

export interface BunRouteArtifact {
  id: BuildCompleteRouteOutput['id'];
  pathname: BuildCompleteRouteOutput['pathname'];
  sourcePage: BuildCompleteRouteOutput['sourcePage'];
  runtime: BuildCompleteRouteOutput['runtime'];
  type: BuildCompleteRouteOutput['type'];
  filePath: string;
  assets?: Record<string, string>;
  wasmAssets?: Record<string, string>;
  env?: NonNullable<BuildCompleteRouteOutput['config']['env']>;
}

export interface BunPrerenderArtifact {
  id: BuildCompletePrerenderOutput['id'];
  pathname: BuildCompletePrerenderOutput['pathname'];
  parentOutputId: BuildCompletePrerenderOutput['parentOutputId'];
  parentFallbackMode?: BuildCompletePrerenderOutput['parentFallbackMode'];
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
  prerenderedPathnames: string[];
  prerenderArtifacts: BunPrerenderArtifact[];
  prerenderFallbackFalseMap: Record<string, string[]>;
  routeOutputs: BunRouteArtifact[];
  routeGraph: BunRouteGraph;
  middleware?: BunMiddlewareArtifact | null;
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
