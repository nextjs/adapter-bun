import type {
  BunDeploymentManifest,
  BunStaticAsset,
  BuildCompleteContext,
} from './types.ts';

export function collectOutputPathnames(
  outputs: BuildCompleteContext['outputs']
): string[] {
  const pathnames = new Set<string>();

  for (const output of [
    ...outputs.pages,
    ...outputs.pagesApi,
    ...outputs.appPages,
    ...outputs.appRoutes,
    ...outputs.prerenders,
    ...outputs.staticFiles,
  ]) {
    pathnames.add(output.pathname);
  }

  if (outputs.middleware) {
    pathnames.add(outputs.middleware.pathname);
  }

  if (pathnames.has('/index') && !pathnames.has('/')) {
    pathnames.add('/');
  }

  return [...pathnames].sort((a, b) => a.localeCompare(b));
}

export function buildDeploymentManifest({
  adapterName,
  adapterOutDir,
  ctx,
  generatedAt,
  pathnames,
  staticAssets,
  port,
  hostname,
  previewProps,
  cacheRuntime,
}: {
  adapterName: string;
  adapterOutDir: string;
  ctx: BuildCompleteContext;
  generatedAt: string;
  pathnames: string[];
  staticAssets: BunStaticAsset[];
  port: number;
  hostname: string;
  previewProps?: NonNullable<BunDeploymentManifest['runtime']>['previewProps'];
  cacheRuntime?: NonNullable<BunDeploymentManifest['runtime']>['cache'];
}): BunDeploymentManifest {
  return {
    schemaVersion: 1,
    generatedAt,
    adapter: {
      name: adapterName,
      outDir: adapterOutDir,
    },
    build: {
      buildId: ctx.buildId,
      nextVersion: ctx.nextVersion,
      projectDir: ctx.projectDir,
      repoRoot: ctx.repoRoot,
      distDir: ctx.distDir,
      basePath: ctx.config.basePath,
      trailingSlash: Boolean(ctx.config.trailingSlash),
      i18n: ctx.config.i18n ?? null,
    },
    server: {
      port,
      hostname,
    },
    pathnames,
    runtime: {
      previewProps: previewProps ?? null,
      cache: cacheRuntime ?? null,
    },
    staticAssets,
    summary: {
      staticAssetsTotal: staticAssets.length,
    },
  };
}
