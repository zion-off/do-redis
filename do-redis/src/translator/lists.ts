import type { Statement, Translation } from "./types";
import { ErrNotInteger, ErrWrongType, errWrongArgs } from "./errors";
import {
  MAX_ITEMS_PER_STATEMENT,
  checkKeyType,
  chunk,
  deleteIfExpired,
  parseIntStrict,
  rowString,
  rowStringOrNull,
  wrongTypeFor,
} from "./helpers";

const LIVE_KEY_LOOKUP = "k.key = ? AND (k.expires_at IS NULL OR k.expires_at > unixepoch())";

function pushStatement(key: string, values: string[], left: boolean): Statement {
  // One statement per batch: the anchor index is read once as an aggregate
  // sub-select and each value gets its own offset from it.
  const rows = values
    .map((_, position) => (position === 0 ? "SELECT ? AS ord, ? AS val" : "SELECT ?, ?"))
    .join(" UNION ALL ");
  const params: unknown[] = [key, key];
  for (let i = 0; i < values.length; i++) {
    params.push(i + 1, values[i]);
  }

  const anchor = left
    ? 'COALESCE(MIN("index"), 1.0) AS base'
    : 'COALESCE(MAX("index"), 0.0) AS base';
  const offset = left ? "b.base - v.ord" : "b.base + v.ord";

  return {
    sql: `INSERT INTO lists (key, "index", value) SELECT ?, ${offset}, v.val FROM (SELECT ${anchor} FROM lists WHERE key = ?) AS b, (${rows}) AS v`,
    params,
  };
}

function translatePush(args: string[], cmd: string, left: boolean): Translation {
  if (args.length < 2) {
    throw errWrongArgs(cmd);
  }

  const key = args[0];
  const values = args.slice(1);
  const statements: Statement[] = [
    deleteIfExpired(key),
    { sql: "SELECT type FROM keys WHERE key = ?", params: [key] },
    { sql: "INSERT OR IGNORE INTO keys (key, type) VALUES (?, 'list')", params: [key] },
  ];

  for (const group of chunk(values, MAX_ITEMS_PER_STATEMENT)) {
    statements.push(pushStatement(key, group, left));
  }

  const countIndex = statements.length;
  statements.push({ sql: "SELECT COUNT(*) AS count FROM lists WHERE key = ?", params: [key] });

  return {
    statements,
    mapResult: (results) => {
      if (wrongTypeFor(results, 1, "list")) {
        throw ErrWrongType;
      }
      if (results[countIndex].length === 0) {
        return 0;
      }
      const count = parseIntStrict(rowString(results[countIndex][0], "count"));
      if (count === null) {
        throw ErrNotInteger;
      }
      return count;
    },
  };
}

export function translateLPush(args: string[]): Translation {
  return translatePush(args, "lpush", true);
}

export function translateRPush(args: string[]): Translation {
  return translatePush(args, "rpush", false);
}

function translatePop(args: string[], cmd: string, left: boolean): Translation {
  if (args.length < 1 || args.length > 2) {
    throw errWrongArgs(cmd);
  }

  const key = args[0];
  let count = 0;
  let hasCount = false;
  if (args.length === 2) {
    const parsed = parseIntStrict(args[1]);
    if (parsed === null || parsed < 0) {
      throw ErrNotInteger;
    }
    hasCount = true;
    count = parsed;
  }

  const statements: Statement[] = [
    deleteIfExpired(key),
    { sql: "SELECT type FROM keys WHERE key = ?", params: [key] },
  ];

  let popSQL = "";
  let popParams: unknown[] = [];
  if (hasCount) {
    const order = left ? "ASC" : "DESC";
    popSQL = `DELETE FROM lists WHERE key = ? AND "index" IN (SELECT "index" FROM lists WHERE key = ? ORDER BY "index" ${order} LIMIT ?) RETURNING "index", value`;
    popParams = [key, key, count];
  } else if (left) {
    popSQL =
      'DELETE FROM lists WHERE key = ? AND "index" = (SELECT MIN("index") FROM lists WHERE key = ?) RETURNING "index", value';
    popParams = [key, key];
  } else {
    popSQL =
      'DELETE FROM lists WHERE key = ? AND "index" = (SELECT MAX("index") FROM lists WHERE key = ?) RETURNING "index", value';
    popParams = [key, key];
  }

  const popIndex = statements.length;
  statements.push({ sql: popSQL, params: popParams });
  statements.push({
    sql: "DELETE FROM keys WHERE key = ? AND NOT EXISTS (SELECT 1 FROM lists WHERE key = ?)",
    params: [key, key],
  });

  return {
    statements,
    mapResult: (results) => {
      if (wrongTypeFor(results, 1, "list")) {
        throw ErrWrongType;
      }
      const rows = results[popIndex];
      if (!hasCount) {
        if (rows.length === 0) {
          return null;
        }
        return rowString(rows[0], "value");
      }
      if (count === 0) {
        return [];
      }
      const values = rows.map((row) => {
        const indexValue = Number(rowString(row, "index"));
        if (!Number.isFinite(indexValue)) {
          throw ErrNotInteger;
        }
        return { index: indexValue, value: rowString(row, "value") };
      });

      values.sort((a, b) => (left ? a.index - b.index : b.index - a.index));
      return values.map((item) => item.value);
    },
  };
}

export function translateLPop(args: string[]): Translation {
  return translatePop(args, "lpop", true);
}

export function translateRPop(args: string[]): Translation {
  return translatePop(args, "rpop", false);
}

export function translateLRange(args: string[]): Translation {
  if (args.length !== 3) {
    throw errWrongArgs("lrange");
  }

  const key = args[0];
  const start = parseIntStrict(args[1]);
  const stop = parseIntStrict(args[2]);
  if (start === null || stop === null) {
    throw ErrNotInteger;
  }

  const statements: Statement[] = [
    {
      sql: `SELECT k.type AS type, l.value AS value FROM keys k LEFT JOIN lists l ON l.key = k.key WHERE ${LIVE_KEY_LOOKUP} ORDER BY l."index" ASC`,
      params: [key],
    },
  ];

  return {
    statements,
    mapResult: (results) => {
      const rows = results[0];
      if (!checkKeyType(rows, "list")) {
        return [];
      }
      const values: string[] = [];
      for (const row of rows) {
        const value = rowStringOrNull(row, "value");
        if (value === null) {
          continue;
        }
        values.push(value);
      }
      const length = values.length;
      if (length === 0) {
        return [];
      }
      let startIndex = start;
      let stopIndex = stop;
      if (startIndex < 0) {
        startIndex = length + startIndex;
      }
      if (stopIndex < 0) {
        stopIndex = length + stopIndex;
      }
      if (startIndex < 0) {
        startIndex = 0;
      }
      if (stopIndex > length - 1) {
        stopIndex = length - 1;
      }
      if (startIndex > stopIndex || startIndex >= length || stopIndex < 0) {
        return [];
      }
      return values.slice(startIndex, stopIndex + 1);
    },
  };
}

export function translateLLen(args: string[]): Translation {
  if (args.length !== 1) {
    throw errWrongArgs("llen");
  }

  const key = args[0];
  const statements: Statement[] = [
    {
      sql: `SELECT k.type AS type, (SELECT COUNT(*) FROM lists l WHERE l.key = k.key) AS count FROM keys k WHERE ${LIVE_KEY_LOOKUP}`,
      params: [key],
    },
  ];

  return {
    statements,
    mapResult: (results) => {
      const rows = results[0];
      if (!checkKeyType(rows, "list")) {
        return 0;
      }
      const count = parseIntStrict(rowString(rows[0], "count"));
      if (count === null) {
        throw ErrNotInteger;
      }
      return count;
    },
  };
}
