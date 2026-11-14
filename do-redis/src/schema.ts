export const SCHEMA_STATEMENTS: string[] = [
  "CREATE TABLE IF NOT EXISTS keys (key TEXT PRIMARY KEY, type TEXT NOT NULL CHECK(type IN ('string', 'hash', 'list', 'set')), expires_at INTEGER)",
  "CREATE TABLE IF NOT EXISTS strings (key TEXT PRIMARY KEY REFERENCES keys(key) ON DELETE CASCADE, value TEXT NOT NULL)",
  "CREATE TABLE IF NOT EXISTS hashes (key TEXT NOT NULL REFERENCES keys(key) ON DELETE CASCADE, field TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (key, field))",
  'CREATE TABLE IF NOT EXISTS lists (key TEXT NOT NULL REFERENCES keys(key) ON DELETE CASCADE, "index" REAL NOT NULL, value TEXT NOT NULL, PRIMARY KEY (key, "index"))',
  "CREATE TABLE IF NOT EXISTS sets (key TEXT NOT NULL REFERENCES keys(key) ON DELETE CASCADE, member TEXT NOT NULL, PRIMARY KEY (key, member))",
  "CREATE INDEX IF NOT EXISTS keys_expires_at ON keys (expires_at) WHERE expires_at IS NOT NULL",
];

export const SWEEP_SQL =
  "DELETE FROM keys WHERE expires_at IS NOT NULL AND expires_at <= unixepoch()";
