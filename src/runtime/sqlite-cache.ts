import { Database } from 'bun:sqlite';
import path from 'node:path';
import type {
  CacheBodyEncoding,
  PrerenderCacheEntry,
  PrerenderCacheStore,
  PrerenderRevalidateTarget,
  PrerenderTagManifestEntry,
  PrerenderTagManifestUpdate,
  ImageCacheEntry,
  ImageCacheStore,
} from './isr.ts';
import { readCacheTagsFromHeaders } from './isr.ts';

export interface SqliteCacheOptions {
  dbPath?: string;
}

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS prerender_entries (
  cache_key TEXT PRIMARY KEY,
  pathname TEXT NOT NULL,
  group_id INTEGER NOT NULL,
  status INTEGER NOT NULL,
  headers TEXT NOT NULL,
  body BLOB NOT NULL,
  body_encoding TEXT NOT NULL DEFAULT 'binary',
  created_at INTEGER NOT NULL,
  revalidate_at INTEGER,
  expires_at INTEGER,
  cache_query TEXT,
  cache_headers TEXT
);
CREATE INDEX IF NOT EXISTS idx_prerender_pathname ON prerender_entries(pathname);

CREATE TABLE IF NOT EXISTS image_entries (
  cache_key TEXT PRIMARY KEY,
  pathname TEXT NOT NULL,
  status INTEGER NOT NULL,
  headers TEXT NOT NULL,
  body BLOB NOT NULL,
  body_encoding TEXT NOT NULL DEFAULT 'binary',
  created_at INTEGER NOT NULL,
  revalidate_at INTEGER,
  expires_at INTEGER
);

CREATE TABLE IF NOT EXISTS tag_manifest (
  tag TEXT PRIMARY KEY,
  stale_at INTEGER,
  expired_at INTEGER
);

CREATE TABLE IF NOT EXISTS revalidate_targets (
  cache_key TEXT PRIMARY KEY,
  pathname TEXT NOT NULL,
  group_id INTEGER NOT NULL,
  tags TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_targets_pathname ON revalidate_targets(pathname);

CREATE TABLE IF NOT EXISTS revalidate_target_tags (
  tag TEXT NOT NULL,
  cache_key TEXT NOT NULL,
  PRIMARY KEY (tag, cache_key)
);
CREATE INDEX IF NOT EXISTS idx_target_tags_tag ON revalidate_target_tags(tag);

CREATE TABLE IF NOT EXISTS revalidate_locks (
  cache_key TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL
);
`;

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`);
}

type SqliteBodyValue = Uint8Array | string;

type PrerenderEntryRow = {
  cache_key: string;
  pathname: string;
  group_id: number;
  status: number;
  headers: string;
  body: SqliteBodyValue;
  body_encoding: string;
  created_at: number;
  revalidate_at: number | null;
  expires_at: number | null;
  cache_query: string | null;
  cache_headers: string | null;
};

type ImageEntryRow = {
  cache_key: string;
  pathname: string;
  status: number;
  headers: string;
  body: SqliteBodyValue;
  body_encoding: string;
  created_at: number;
  revalidate_at: number | null;
  expires_at: number | null;
};

function normalizeStoredBody(
  body: SqliteBodyValue,
  bodyEncoding: string
): {
  body: SqliteBodyValue;
  bodyEncoding: CacheBodyEncoding;
} {
  if (bodyEncoding === 'binary') {
    if (body instanceof Uint8Array) {
      return {
        body,
        bodyEncoding: 'binary',
      };
    }

    return {
      body: new TextEncoder().encode(body),
      bodyEncoding: 'binary',
    };
  }

  if (typeof body === 'string') {
    return {
      body,
      bodyEncoding: 'base64',
    };
  }

  return {
    body: Buffer.from(body).toString('utf8'),
    bodyEncoding: 'base64',
  };
}

export class SqlitePrerenderCacheStore implements PrerenderCacheStore {
  #db: Database;

  constructor(db: Database) {
    this.#db = db;
  }

  #toPrerenderEntry(row: PrerenderEntryRow): PrerenderCacheEntry {
    const normalizedBody = normalizeStoredBody(row.body, row.body_encoding);

    return {
      cacheKey: row.cache_key,
      pathname: row.pathname,
      groupId: row.group_id,
      status: row.status,
      headers: JSON.parse(row.headers) as Record<string, string>,
      body: normalizedBody.body,
      bodyEncoding: normalizedBody.bodyEncoding,
      createdAt: row.created_at,
      revalidateAt: row.revalidate_at,
      expiresAt: row.expires_at,
      cacheQuery: row.cache_query
        ? (JSON.parse(row.cache_query) as Record<string, string[]>)
        : undefined,
      cacheHeaders: row.cache_headers
        ? (JSON.parse(row.cache_headers) as Record<string, string>)
        : undefined,
    };
  }

  get(cacheKey: string): PrerenderCacheEntry | null {
    const row = this.#db
      .query<PrerenderEntryRow, [string]>('SELECT * FROM prerender_entries WHERE cache_key = ?')
      .get(cacheKey);

    if (!row) return null;

    return this.#toPrerenderEntry(row);
  }

  findByPrefix(cacheKeyPrefix: string): PrerenderCacheEntry[] {
    const escapedPrefix = escapeLikePattern(cacheKeyPrefix);
    const pattern = `${escapedPrefix}%`;
    const rows = this.#db
      .query<PrerenderEntryRow, [string]>(
        "SELECT * FROM prerender_entries WHERE cache_key LIKE ? ESCAPE '\\' ORDER BY cache_key ASC"
      )
      .all(pattern);

    return rows.map((row) => this.#toPrerenderEntry(row));
  }

  set(cacheKey: string, entry: PrerenderCacheEntry): void {
    const tags = readCacheTagsFromHeaders(entry.headers);

    this.#db.transaction(() => {
      this.#db
        .query(
          `INSERT OR REPLACE INTO prerender_entries
           (cache_key, pathname, group_id, status, headers, body, body_encoding,
            created_at, revalidate_at, expires_at, cache_query, cache_headers)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          cacheKey,
          entry.pathname,
          entry.groupId,
          entry.status,
          JSON.stringify(entry.headers),
          entry.body,
          entry.bodyEncoding,
          entry.createdAt,
          entry.revalidateAt,
          entry.expiresAt,
          entry.cacheQuery ? JSON.stringify(entry.cacheQuery) : null,
          entry.cacheHeaders ? JSON.stringify(entry.cacheHeaders) : null
        );

      // Upsert revalidate target
      this.#db
        .query(
          `INSERT OR REPLACE INTO revalidate_targets (cache_key, pathname, group_id, tags)
           VALUES (?, ?, ?, ?)`
        )
        .run(cacheKey, entry.pathname, entry.groupId, JSON.stringify(tags));

      // Clean old tag associations for this cache key
      this.#db
        .query('DELETE FROM revalidate_target_tags WHERE cache_key = ?')
        .run(cacheKey);

      // Insert new tag associations
      if (tags.length > 0) {
        const insertTag = this.#db.query(
          'INSERT OR IGNORE INTO revalidate_target_tags (tag, cache_key) VALUES (?, ?)'
        );
        for (const tag of tags) {
          insertTag.run(tag, cacheKey);
        }
      }
    })();
  }

  delete(cacheKey: string): void {
    this.#db.transaction(() => {
      this.#db.query('DELETE FROM prerender_entries WHERE cache_key = ?').run(cacheKey);
      this.#db.query('DELETE FROM revalidate_targets WHERE cache_key = ?').run(cacheKey);
      this.#db.query('DELETE FROM revalidate_target_tags WHERE cache_key = ?').run(cacheKey);
    })();
  }

  acquireRevalidateLock(cacheKey: string, ttlSeconds: number): boolean {
    const now = Date.now();

    // Clean expired lock, then try to insert
    return this.#db.transaction(() => {
      this.#db
        .query('DELETE FROM revalidate_locks WHERE cache_key = ? AND expires_at <= ?')
        .run(cacheKey, now);

      const existing = this.#db
        .query<{ expires_at: number }, [string]>(
          'SELECT expires_at FROM revalidate_locks WHERE cache_key = ?'
        )
        .get(cacheKey);

      if (existing) {
        return false;
      }

      this.#db
        .query('INSERT INTO revalidate_locks (cache_key, expires_at) VALUES (?, ?)')
        .run(cacheKey, now + ttlSeconds * 1000);

      return true;
    })();
  }

  getTagManifestEntries(tags: string[]): Record<string, PrerenderTagManifestEntry> {
    const entries: Record<string, PrerenderTagManifestEntry> = {};
    const uniqueTags = unique(tags);

    if (uniqueTags.length === 0) return entries;

    const placeholders = uniqueTags.map(() => '?').join(',');
    const rows = this.#db
      .query<
        { tag: string; stale_at: number | null; expired_at: number | null },
        string[]
      >(`SELECT tag, stale_at, expired_at FROM tag_manifest WHERE tag IN (${placeholders})`)
      .all(...uniqueTags);

    for (const row of rows) {
      const entry: PrerenderTagManifestEntry = {};
      if (row.stale_at !== null) entry.staleAt = row.stale_at;
      if (row.expired_at !== null) entry.expiredAt = row.expired_at;
      entries[row.tag] = entry;
    }

    return entries;
  }

  updateTagManifest(tags: string[], update: PrerenderTagManifestUpdate): void {
    const now = update.now ?? Date.now();
    const uniqueTags = unique(tags);

    this.#db.transaction(() => {
      for (const tag of uniqueTags) {
        if (!tag) continue;

        if (update.mode === 'stale') {
          const expiredAt =
            typeof update.expireSeconds === 'number' && Number.isFinite(update.expireSeconds)
              ? now + update.expireSeconds * 1000
              : null;

          this.#db
            .query(
              `INSERT INTO tag_manifest (tag, stale_at, expired_at) VALUES (?, ?, ?)
               ON CONFLICT(tag) DO UPDATE SET stale_at = excluded.stale_at,
               expired_at = COALESCE(excluded.expired_at, tag_manifest.expired_at)`
            )
            .run(tag, now, expiredAt);
        } else {
          this.#db
            .query(
              `INSERT INTO tag_manifest (tag, expired_at) VALUES (?, ?)
               ON CONFLICT(tag) DO UPDATE SET expired_at = excluded.expired_at`
            )
            .run(tag, now);
        }
      }
    })();
  }

  findRevalidateTargets(query: {
    tags?: string[];
    pathnames?: string[];
  }): PrerenderRevalidateTarget[] {
    const cacheKeys = new Set<string>();

    if (query.pathnames && query.pathnames.length > 0) {
      const uniquePathnames = unique(query.pathnames);
      const placeholders = uniquePathnames.map(() => '?').join(',');
      const rows = this.#db
        .query<{ cache_key: string }, string[]>(
          `SELECT cache_key FROM revalidate_targets WHERE pathname IN (${placeholders})`
        )
        .all(...uniquePathnames);
      for (const row of rows) {
        cacheKeys.add(row.cache_key);
      }
    }

    if (query.tags && query.tags.length > 0) {
      const uniqueTags = unique(query.tags);
      const placeholders = uniqueTags.map(() => '?').join(',');
      const rows = this.#db
        .query<{ cache_key: string }, string[]>(
          `SELECT DISTINCT cache_key FROM revalidate_target_tags WHERE tag IN (${placeholders})`
        )
        .all(...uniqueTags);
      for (const row of rows) {
        cacheKeys.add(row.cache_key);
      }
    }

    if (cacheKeys.size === 0) return [];

    const keysArray = [...cacheKeys];
    const placeholders = keysArray.map(() => '?').join(',');
    const rows = this.#db
      .query<
        { cache_key: string; pathname: string; group_id: number },
        string[]
      >(
        `SELECT cache_key, pathname, group_id FROM revalidate_targets WHERE cache_key IN (${placeholders})`
      )
      .all(...keysArray);

    return rows
      .map((row) => ({
        cacheKey: row.cache_key,
        pathname: row.pathname,
        groupId: row.group_id,
      }))
      .sort((left, right) => {
        const byPathname = left.pathname.localeCompare(right.pathname);
        if (byPathname !== 0) return byPathname;
        return left.cacheKey.localeCompare(right.cacheKey);
      });
  }
}

export class SqliteImageCacheStore implements ImageCacheStore {
  #db: Database;

  constructor(db: Database) {
    this.#db = db;
  }

  get(cacheKey: string): ImageCacheEntry | null {
    const row = this.#db
      .query<ImageEntryRow, [string]>('SELECT * FROM image_entries WHERE cache_key = ?')
      .get(cacheKey);

    if (!row) return null;

    const normalizedBody = normalizeStoredBody(row.body, row.body_encoding);

    return {
      cacheKey: row.cache_key,
      pathname: row.pathname,
      status: row.status,
      headers: JSON.parse(row.headers) as Record<string, string>,
      body: normalizedBody.body,
      bodyEncoding: normalizedBody.bodyEncoding,
      createdAt: row.created_at,
      revalidateAt: row.revalidate_at,
      expiresAt: row.expires_at,
    };
  }

  set(cacheKey: string, entry: ImageCacheEntry): void {
    this.#db
      .query(
        `INSERT OR REPLACE INTO image_entries
         (cache_key, pathname, status, headers, body, body_encoding,
          created_at, revalidate_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        cacheKey,
        entry.pathname,
        entry.status,
        JSON.stringify(entry.headers),
        entry.body,
        entry.bodyEncoding,
        entry.createdAt,
        entry.revalidateAt,
        entry.expiresAt
      );
  }

  delete(cacheKey: string): void {
    this.#db.query('DELETE FROM image_entries WHERE cache_key = ?').run(cacheKey);
  }
}

export function createSqliteCacheStores(options: SqliteCacheOptions & { adapterDir?: string } = {}): {
  prerenderCacheStore: SqlitePrerenderCacheStore;
  imageCacheStore: SqliteImageCacheStore;
} {
  const dbPath = options.dbPath ?? path.join(options.adapterDir ?? '.', 'cache.db');
  const db = new Database(dbPath);

  db.run('PRAGMA journal_mode = WAL');
  db.run(SCHEMA_SQL);

  return {
    prerenderCacheStore: new SqlitePrerenderCacheStore(db),
    imageCacheStore: new SqliteImageCacheStore(db),
  };
}
