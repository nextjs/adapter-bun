import { Database } from 'bun:sqlite';
import path from 'node:path';
import { SCHEMA_SQL, SqlitePrerenderCacheStore } from './sqlite-cache.js';

let sharedStore: SqlitePrerenderCacheStore | null = null;

function isSqliteBusyError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const code =
    'code' in error && typeof error.code === 'string' ? error.code : '';
  const message =
    'message' in error && typeof error.message === 'string'
      ? error.message
      : '';
  return code === 'SQLITE_BUSY' || /database is locked/i.test(message);
}

function resolveCacheDbPath(): string {
  return (
    process.env.BUN_ADAPTER_CACHE_DB_PATH ||
    path.join(import.meta.dirname, '..', 'cache.db')
  );
}

export function getSharedPrerenderCacheStore(): SqlitePrerenderCacheStore {
  if (sharedStore) return sharedStore;

  const db = new Database(resolveCacheDbPath());
  db.run('PRAGMA busy_timeout = 60000');
  db.run('PRAGMA synchronous = NORMAL');

  // Multiple Next.js workers can initialize the cache DB concurrently.
  // WAL is a best-effort optimization; ignore SQLITE_BUSY and continue.
  try {
    db.run('PRAGMA journal_mode = WAL');
  } catch (error) {
    if (!isSqliteBusyError(error)) {
      throw error;
    }
  }
  db.run(SCHEMA_SQL);

  sharedStore = new SqlitePrerenderCacheStore(db);
  return sharedStore;
}
