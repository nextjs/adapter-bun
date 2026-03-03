import { Database } from 'bun:sqlite';
import path from 'node:path';
import { SCHEMA_SQL, SqlitePrerenderCacheStore } from './sqlite-cache.js';
let sharedStore = null;
function resolveCacheDbPath() {
    return (process.env.BUN_ADAPTER_CACHE_DB_PATH ||
        path.join(import.meta.dirname, '..', 'cache.db'));
}
export function getSharedPrerenderCacheStore() {
    if (sharedStore)
        return sharedStore;
    const db = new Database(resolveCacheDbPath());
    db.exec('PRAGMA journal_mode = WAL');
    db.exec(SCHEMA_SQL);
    sharedStore = new SqlitePrerenderCacheStore(db);
    return sharedStore;
}
