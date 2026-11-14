/* eslint-disable @typescript-eslint/no-explicit-any */
import { translate } from "../../translator";
import type { ResultRow, Statement } from "../../translator/types";

/** Mirrors the schema created by `durable-object/src/index.ts`. */
const SCHEMA_STATEMENTS: string[] = [
  "CREATE TABLE IF NOT EXISTS keys (key TEXT PRIMARY KEY, type TEXT NOT NULL CHECK(type IN ('string', 'hash', 'list', 'set')), expires_at INTEGER)",
  "CREATE TABLE IF NOT EXISTS strings (key TEXT PRIMARY KEY REFERENCES keys(key) ON DELETE CASCADE, value TEXT NOT NULL)",
  "CREATE TABLE IF NOT EXISTS hashes (key TEXT NOT NULL REFERENCES keys(key) ON DELETE CASCADE, field TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (key, field))",
  'CREATE TABLE IF NOT EXISTS lists (key TEXT NOT NULL REFERENCES keys(key) ON DELETE CASCADE, "index" REAL NOT NULL, value TEXT NOT NULL, PRIMARY KEY (key, "index"))',
  "CREATE TABLE IF NOT EXISTS sets (key TEXT NOT NULL REFERENCES keys(key) ON DELETE CASCADE, member TEXT NOT NULL, PRIMARY KEY (key, member))",
  "CREATE INDEX IF NOT EXISTS keys_expires_at ON keys (expires_at) WHERE expires_at IS NOT NULL",
];

const SWEEP_SQL = "DELETE FROM keys WHERE expires_at IS NOT NULL AND expires_at <= unixepoch()";

type SqliteDatabase = {
  exec(sql: string): void;
  prepare(sql: string): { all(...params: any[]): ResultRow[] };
  close(): void;
};

type SqliteConstructor = new (path: string) => SqliteDatabase;

let cached: SqliteConstructor | null | undefined;

export async function loadSqlite(): Promise<SqliteConstructor | null> {
  if (cached !== undefined) {
    return cached;
  }
  // `process.getBuiltinModule` avoids the bundler rewriting the import, which
  // matters because older bundlers do not know about `node:sqlite`.
  const getBuiltinModule = (globalThis as any).process?.getBuiltinModule;
  try {
    const specifier = "node:sqlite";
    const mod: any = getBuiltinModule
      ? getBuiltinModule.call((globalThis as any).process, specifier)
      : await import(/* @vite-ignore */ specifier);
    cached = (mod?.DatabaseSync as SqliteConstructor) ?? null;
  } catch {
    cached = null;
  }
  return cached;
}

export type CommandResult = { result: unknown } | { error: string };

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Minimal in-process stand-in for the Durable Object storage layer, backed by a
 * real SQLite database so translator SQL is exercised end to end.
 */
export class Harness {
  private db: SqliteDatabase;

  constructor(Database: SqliteConstructor) {
    this.db = new Database(":memory:");
    for (const sql of SCHEMA_STATEMENTS) {
      this.db.exec(sql);
    }
  }

  close(): void {
    this.db.close();
  }

  sweep(): void {
    this.db.prepare(SWEEP_SQL).all();
  }

  rows(sql: string, ...params: unknown[]): ResultRow[] {
    return this.db.prepare(sql).all(...params);
  }

  private execBatch(statements: Statement[]): ResultRow[][] {
    const results: ResultRow[][] = [];
    this.db.exec("BEGIN");
    try {
      for (const { sql, params } of statements) {
        results.push(this.db.prepare(sql).all(...params));
      }
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
    return results;
  }

  command(cmd: string[]): CommandResult {
    try {
      const translation = translate(cmd);
      const results =
        translation.statements.length > 0 ? this.execBatch(translation.statements) : [];
      return { result: translation.mapResult(results) };
    } catch (err) {
      return { error: errorMessage(err) };
    }
  }

  /** Runs a command and returns its value, throwing when the command errored. */
  run(cmd: string[]): unknown {
    const outcome = this.command(cmd);
    if ("error" in outcome) {
      throw new Error(outcome.error);
    }
    return outcome.result;
  }
}
