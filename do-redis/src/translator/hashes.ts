import type { Statement, Translation } from "./types";
import { ErrWrongType, errWrongArgs } from "./errors";
import {
  MAX_ITEMS_PER_STATEMENT,
  checkKeyType,
  chunk,
  deleteIfExpired,
  keyHasType,
  placeholders,
  rowString,
  rowStringOrNull,
  wrongTypeFor,
} from "./helpers";

const LIVE_KEY_LOOKUP = "k.key = ? AND (k.expires_at IS NULL OR k.expires_at > unixepoch())";

export function translateHGet(args: string[]): Translation {
  if (args.length !== 2) {
    throw errWrongArgs("hget");
  }

  const key = args[0];
  const field = args[1];
  const statements: Statement[] = [
    {
      sql: `SELECT k.type AS type, h.value AS value FROM keys k LEFT JOIN hashes h ON h.key = k.key AND h.field = ? WHERE ${LIVE_KEY_LOOKUP}`,
      params: [field, key],
    },
  ];

  return {
    statements,
    mapResult: (results) => {
      const rows = results[0];
      if (!checkKeyType(rows, "hash")) {
        return null;
      }
      return rowStringOrNull(rows[0], "value");
    },
  };
}

export function translateHSet(args: string[]): Translation {
  if (args.length < 3 || (args.length - 1) % 2 !== 0) {
    throw errWrongArgs("hset");
  }

  const key = args[0];
  // Later assignments to the same field win, and a repeated field only counts
  // once towards the "fields added" reply.
  const pairs = new Map<string, string>();
  for (let i = 1; i < args.length; i += 2) {
    pairs.set(args[i], args[i + 1]);
  }
  const fields = [...pairs.keys()];

  const statements: Statement[] = [deleteIfExpired(key)];
  const existingIndexes: number[] = [];

  if (fields.length <= MAX_ITEMS_PER_STATEMENT) {
    existingIndexes.push(statements.length);
    statements.push({
      sql: `SELECT k.type AS type, (SELECT COUNT(*) FROM hashes h WHERE h.key = k.key AND h.field IN (${placeholders(
        fields.length
      )})) AS existing FROM keys k WHERE k.key = ?`,
      params: [...fields, key],
    });
  } else {
    statements.push({ sql: "SELECT type FROM keys WHERE key = ?", params: [key] });
    for (const group of chunk(fields, MAX_ITEMS_PER_STATEMENT)) {
      existingIndexes.push(statements.length);
      statements.push({
        sql: `SELECT COUNT(*) AS existing FROM hashes WHERE key = ? AND field IN (${placeholders(
          group.length
        )})`,
        params: [key, ...group],
      });
    }
  }

  statements.push({
    sql: "INSERT OR IGNORE INTO keys (key, type) VALUES (?, 'hash')",
    params: [key],
  });

  for (const group of chunk([...pairs], MAX_ITEMS_PER_STATEMENT)) {
    const params: unknown[] = [];
    for (const [field, value] of group) {
      params.push(key, field, value);
    }
    params.push(key);
    statements.push({
      sql: `INSERT INTO hashes (key, field, value) SELECT column1, column2, column3 FROM (VALUES ${group
        .map(() => "(?, ?, ?)")
        .join(", ")}) WHERE ${keyHasType(
        "hash"
      )} ON CONFLICT(key, field) DO UPDATE SET value = excluded.value`,
      params,
    });
  }

  return {
    statements,
    mapResult: (results) => {
      if (wrongTypeFor(results, 1, "hash")) {
        throw ErrWrongType;
      }
      let existing = 0;
      for (const index of existingIndexes) {
        const rows = results[index];
        if (rows.length > 0) {
          existing += Number(rows[0]["existing"] ?? 0);
        }
      }
      return fields.length - existing;
    },
  };
}

export function translateHDel(args: string[]): Translation {
  if (args.length < 2) {
    throw errWrongArgs("hdel");
  }

  const key = args[0];
  const fields = [...new Set(args.slice(1))];
  const statements: Statement[] = [
    deleteIfExpired(key),
    { sql: "SELECT type FROM keys WHERE key = ?", params: [key] },
  ];

  const deleteIndexes: number[] = [];
  for (const group of chunk(fields, MAX_ITEMS_PER_STATEMENT)) {
    deleteIndexes.push(statements.length);
    statements.push({
      sql: `DELETE FROM hashes WHERE key = ? AND field IN (${placeholders(
        group.length
      )}) AND ${keyHasType("hash")} RETURNING field`,
      params: [key, ...group, key],
    });
  }

  return {
    statements,
    mapResult: (results) => {
      if (wrongTypeFor(results, 1, "hash")) {
        throw ErrWrongType;
      }
      let count = 0;
      for (const index of deleteIndexes) {
        count += results[index].length;
      }
      return count;
    },
  };
}

export function translateHGetAll(args: string[]): Translation {
  if (args.length !== 1) {
    throw errWrongArgs("hgetall");
  }

  const key = args[0];
  const statements: Statement[] = [
    {
      sql: `SELECT k.type AS type, h.field AS field, h.value AS value FROM keys k LEFT JOIN hashes h ON h.key = k.key WHERE ${LIVE_KEY_LOOKUP} ORDER BY h.field`,
      params: [key],
    },
  ];

  return {
    statements,
    mapResult: (results) => {
      const rows = results[0];
      if (!checkKeyType(rows, "hash")) {
        return [];
      }
      const out: unknown[] = [];
      for (const row of rows) {
        if (rowStringOrNull(row, "field") === null) {
          continue;
        }
        out.push(rowString(row, "field"), rowString(row, "value"));
      }
      return out;
    },
  };
}

export function translateHExists(args: string[]): Translation {
  if (args.length !== 2) {
    throw errWrongArgs("hexists");
  }

  const key = args[0];
  const field = args[1];
  const statements: Statement[] = [
    {
      sql: `SELECT k.type AS type, EXISTS (SELECT 1 FROM hashes h WHERE h.key = k.key AND h.field = ?) AS present FROM keys k WHERE ${LIVE_KEY_LOOKUP}`,
      params: [field, key],
    },
  ];

  return {
    statements,
    mapResult: (results) => {
      const rows = results[0];
      if (!checkKeyType(rows, "hash")) {
        return 0;
      }
      return Number(rows[0]["present"] ?? 0) > 0 ? 1 : 0;
    },
  };
}

function translateHashColumn(args: string[], cmd: string, column: "field" | "value"): Translation {
  if (args.length !== 1) {
    throw errWrongArgs(cmd);
  }

  const key = args[0];
  const statements: Statement[] = [
    {
      sql: `SELECT k.type AS type, h.${column} AS ${column} FROM keys k LEFT JOIN hashes h ON h.key = k.key WHERE ${LIVE_KEY_LOOKUP} ORDER BY h.field`,
      params: [key],
    },
  ];

  return {
    statements,
    mapResult: (results) => {
      const rows = results[0];
      if (!checkKeyType(rows, "hash")) {
        return [];
      }
      const out: string[] = [];
      for (const row of rows) {
        const value = rowStringOrNull(row, column);
        if (value === null) {
          continue;
        }
        out.push(value);
      }
      return out;
    },
  };
}

export function translateHKeys(args: string[]): Translation {
  return translateHashColumn(args, "hkeys", "field");
}

export function translateHVals(args: string[]): Translation {
  return translateHashColumn(args, "hvals", "value");
}
