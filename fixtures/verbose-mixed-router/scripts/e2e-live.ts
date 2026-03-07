import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { Database } from 'bun:sqlite';

type CachePayload = {
  generatedAt: string;
  random: number;
};

type RevalidateResponse = {
  ok: boolean;
  source: string;
  revalidatedPaths?: string[];
  revalidatedTags?: string[];
};

const HOST = '127.0.0.1';
const PORT = Number.parseInt(process.env.PORT ?? '3110', 10);
const BASE_URL = `http://${HOST}:${PORT}`;
const SERVER_START_TIMEOUT_MS = 20_000;
const REVALIDATE_TIMEOUT_MS = 12_000;
const REVALIDATE_POLL_MS = 250;

const logs: string[] = [];

function logStep(message: string): void {
  console.log(`\n[e2e-live] ${message}`);
}

function decodeHtmlEntities(input: string): string {
  return input
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function extractPreJson(html: string): Record<string, unknown> {
  const match = html.match(/<pre>([\s\S]*?)<\/pre>/i);
  assert.ok(match, 'Expected a <pre> payload in route HTML');
  return JSON.parse(decodeHtmlEntities(match[1]));
}

function toCachePayload(value: Record<string, unknown>): CachePayload {
  const generatedAt = value.generatedAt;
  const random = value.random;

  assert.equal(typeof generatedAt, 'string', 'Expected payload.generatedAt to be a string');
  assert.equal(typeof random, 'number', 'Expected payload.random to be a number');

  return {
    generatedAt,
    random,
  };
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const body = await response.text();
  if (!response.ok) {
    throw new Error(
      `Request failed ${response.status} ${response.statusText} for ${url}\n${body}`
    );
  }
  return JSON.parse(body) as T;
}

async function fetchText(url: string, init?: RequestInit): Promise<Response> {
  const response = await fetch(url, init);
  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `Request failed ${response.status} ${response.statusText} for ${url}\n${body}`
    );
  }
  return response;
}

function isSamePayload(left: CachePayload, right: CachePayload): boolean {
  return left.generatedAt === right.generatedAt && left.random === right.random;
}

async function waitForServerReady(): Promise<void> {
  const deadline = Date.now() + SERVER_START_TIMEOUT_MS;
  let lastError: unknown = null;

  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${BASE_URL}/api/app-static`, { method: 'GET' });
      if (response.ok) {
        return;
      }
      lastError = new Error(`Unexpected status ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await sleep(200);
  }

  throw new Error(`Server did not become ready in time: ${String(lastError)}`);
}

async function waitForPayloadChange(
  routePath: string,
  previous: CachePayload
): Promise<CachePayload> {
  const deadline = Date.now() + REVALIDATE_TIMEOUT_MS;

  while (Date.now() < deadline) {
    const response = await fetchText(`${BASE_URL}${routePath}`);
    const html = await response.text();
    const next = toCachePayload(extractPreJson(html));
    if (!isSamePayload(previous, next)) {
      return next;
    }
    await sleep(REVALIDATE_POLL_MS);
  }

  throw new Error(`Payload for ${routePath} did not change after revalidation`);
}

function verifySqliteArtifacts(): void {
  const db = new Database('./bun-dist/cache.db', { readonly: true });
  try {
    const prerenderRows = db
      .query<{ c: number }, [string]>(
        'SELECT COUNT(*) AS c FROM prerender_entries WHERE cache_key LIKE ?'
      )
      .get('/%').c;

    const binaryRows = db
      .query<{ c: number }, [string, string]>(
        'SELECT COUNT(*) AS c FROM prerender_entries WHERE typeof(body) = ? AND body_encoding = ?'
      )
      .get('blob', 'binary').c;

    const appRouterTag = db
      .query<{ stale_at: number | null; expired_at: number | null }, [string]>(
        'SELECT stale_at, expired_at FROM tag_manifest WHERE tag = ?'
      )
      .get('app-router-tag');

    assert.ok(
      prerenderRows > 0,
      'Expected prerender entries to be persisted in bun-dist/cache.db'
    );
    assert.ok(
      binaryRows > 0,
      'Expected prerender bodies to be stored as binary blobs in bun-dist/cache.db'
    );
    assert.ok(appRouterTag, 'Expected app-router-tag to exist in tag_manifest');
    assert.ok(
      appRouterTag.stale_at !== null || appRouterTag.expired_at !== null,
      'Expected app-router-tag to have stale_at or expired_at set'
    );
  } finally {
    db.close();
  }
}

async function main(): Promise<void> {
  const server = Bun.spawn({
    cmd: ['bun', 'bun-dist/server.js'],
    env: {
      ...process.env,
      PORT: String(PORT),
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const readStream = async (
    stream: ReadableStream<Uint8Array> | null,
    prefix: 'stdout' | 'stderr'
  ) => {
    if (!stream) return;
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      const text = decoder.decode(chunk.value, { stream: true });
      if (text.length > 0) {
        logs.push(`[${prefix}] ${text}`);
      }
    }
  };

  const stdoutPump = readStream(server.stdout, 'stdout');
  const stderrPump = readStream(server.stderr, 'stderr');

  try {
    logStep('waiting for live bun server');
    await waitForServerReady();

    logStep('asserting app route cache is sticky before revalidate');
    const appStaticA = await fetchJson<CachePayload>(`${BASE_URL}/api/app-static`);
    const appStaticB = await fetchJson<CachePayload>(`${BASE_URL}/api/app-static`);
    assert.ok(
      isSamePayload(appStaticA, appStaticB),
      'Expected /api/app-static to return cached payload before revalidate'
    );

    logStep('asserting app-router tag revalidation changes cached payload');
    const tagHtmlA = await (await fetchText(`${BASE_URL}/app-router/cache-tag`)).text();
    const tagPayloadA = toCachePayload(extractPreJson(tagHtmlA));
    const tagHtmlB = await (await fetchText(`${BASE_URL}/app-router/cache-tag`)).text();
    const tagPayloadB = toCachePayload(extractPreJson(tagHtmlB));
    assert.ok(
      isSamePayload(tagPayloadA, tagPayloadB),
      'Expected /app-router/cache-tag to return same cached payload before tag revalidate'
    );
    const tagRevalidate = await fetchJson<RevalidateResponse>(
      `${BASE_URL}/api/revalidate-app`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          tag: 'app-router-tag',
          tagExpire: 0,
        }),
      }
    );
    assert.equal(tagRevalidate.ok, true, 'Expected tag revalidate request to succeed');
    const tagPayloadC = await waitForPayloadChange('/app-router/cache-tag', tagPayloadB);
    assert.ok(
      !isSamePayload(tagPayloadB, tagPayloadC),
      'Expected /app-router/cache-tag payload to change after tag revalidate'
    );

    logStep('asserting app-router path revalidation changes cached payload');
    const pathHtmlA = await (await fetchText(`${BASE_URL}/app-router/cache-path`)).text();
    const pathPayloadA = toCachePayload(extractPreJson(pathHtmlA));
    const pathHtmlB = await (await fetchText(`${BASE_URL}/app-router/cache-path`)).text();
    const pathPayloadB = toCachePayload(extractPreJson(pathHtmlB));
    assert.ok(
      isSamePayload(pathPayloadA, pathPayloadB),
      'Expected /app-router/cache-path to return same cached payload before path revalidate'
    );
    const pathRevalidate = await fetchJson<RevalidateResponse>(
      `${BASE_URL}/api/revalidate-app`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          path: '/app-router/cache-path',
        }),
      }
    );
    assert.equal(pathRevalidate.ok, true, 'Expected path revalidate request to succeed');
    const pathPayloadC = await waitForPayloadChange('/app-router/cache-path', pathPayloadB);
    assert.ok(
      !isSamePayload(pathPayloadB, pathPayloadC),
      'Expected /app-router/cache-path payload to change after path revalidate'
    );

    logStep('asserting cache tags are internal-only in app responses');
    const headerCheckResponse = await fetchText(`${BASE_URL}/app-router/cache-tag`);
    assert.equal(
      headerCheckResponse.headers.get('x-next-cache-tags'),
      null,
      'Expected x-next-cache-tags header to be hidden from end users'
    );

    logStep('asserting sqlite cache artifacts');
    verifySqliteArtifacts();

    console.log('\n[e2e-live] success');
  } finally {
    server.kill();
    await server.exited;
    await Promise.all([stdoutPump, stderrPump]);
  }
}

main().catch((error) => {
  console.error('\n[e2e-live] failure');
  console.error(error);
  if (logs.length > 0) {
    console.error('\n[e2e-live] captured server logs:');
    console.error(logs.join(''));
  }
  process.exitCode = 1;
});
