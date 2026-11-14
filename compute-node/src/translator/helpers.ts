import { ErrWrongType } from "./errors";
import type { ResultRow, Statement } from "./types";

/**
 * Maximum number of keys/values folded into a single statement. Keeps bound
 * parameter counts far below SQLite's limit while still collapsing variadic
 * commands into a handful of statements.
 */
export const MAX_ITEMS_PER_STATEMENT = 64;

/** Matches rows in `keys` that have not expired yet. */
export const LIVE_KEY = "(expires_at IS NULL OR expires_at > unixepoch())";

/**
 * SQL predicate (one bound parameter: the key) that holds only while the key
 * exists with the given type. Mutating child-table statements embed it so a
 * wrong-typed key is left untouched even though the whole batch still runs
 * before the type check in mapResult reports WRONGTYPE.
 */
export function keyHasType(type: string): string {
  return `EXISTS (SELECT 1 FROM keys WHERE key = ? AND type = '${type}')`;
}

export function deleteIfExpired(key: string): Statement {
  return {
    sql: "DELETE FROM keys WHERE key = ? AND expires_at IS NOT NULL AND expires_at <= unixepoch()",
    params: [key],
  };
}

export function placeholders(count: number): string {
  return new Array(count).fill("?").join(", ");
}

export function chunk<T>(values: T[], size: number): T[][] {
  if (values.length <= size) {
    return [values];
  }
  const out: T[][] = [];
  for (let i = 0; i < values.length; i += size) {
    out.push(values.slice(i, i + size));
  }
  return out;
}

export function rowString(row: ResultRow, field: string): string {
  if (!(field in row)) {
    return "";
  }
  const value = row[field];
  if (value === null || value === undefined) {
    return "";
  }
  if (typeof value === "string") {
    return value;
  }
  return String(value);
}

/** Reads a column that is NULL when the joined row is absent. */
export function rowStringOrNull(row: ResultRow, field: string): string | null {
  const value = row[field];
  if (value === null || value === undefined) {
    return null;
  }
  return typeof value === "string" ? value : String(value);
}

export function parseIntStrict(value: string): number | null {
  if (!/^-?\d+$/.test(value)) {
    return null;
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    return null;
  }
  return parsed;
}

export function wrongTypeFor(results: ResultRow[][], index: number, expected: string): boolean {
  if (index < 0 || index >= results.length) {
    return false;
  }
  if (results[index].length === 0) {
    return false;
  }
  const row = results[index][0];
  const value = row["type"];
  if (value === null || value === undefined) {
    return false;
  }
  return String(value).toLowerCase() !== expected;
}

/**
 * Checks the `type` column of a combined key lookup. Returns false when the key
 * does not exist (or has expired) and throws WRONGTYPE on a type mismatch.
 */
export function checkKeyType(rows: ResultRow[], expected: string): boolean {
  if (rows.length === 0) {
    return false;
  }
  const value = rows[0]["type"];
  if (value === null || value === undefined) {
    return false;
  }
  if (String(value).toLowerCase() !== expected) {
    throw ErrWrongType;
  }
  return true;
}
