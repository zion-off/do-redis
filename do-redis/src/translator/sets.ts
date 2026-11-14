import type { Statement, Translation } from "./types";
import { ErrNotInteger, ErrWrongType, errWrongArgs } from "./errors";
import {
  MAX_ITEMS_PER_STATEMENT,
  checkKeyType,
  chunk,
  deleteIfExpired,
  parseIntStrict,
  placeholders,
  rowString,
  rowStringOrNull,
  wrongTypeFor,
} from "./helpers";

const LIVE_KEY_LOOKUP = "k.key = ? AND (k.expires_at IS NULL OR k.expires_at > unixepoch())";

export function translateSAdd(args: string[]): Translation {
  if (args.length < 2) {
    throw errWrongArgs("sadd");
  }

  const key = args[0];
  const members = [...new Set(args.slice(1))];
  const statements: Statement[] = [
    deleteIfExpired(key),
    { sql: "SELECT type FROM keys WHERE key = ?", params: [key] },
    { sql: "INSERT OR IGNORE INTO keys (key, type) VALUES (?, 'set')", params: [key] },
  ];

  const insertIndexes: number[] = [];
  for (const group of chunk(members, MAX_ITEMS_PER_STATEMENT)) {
    const params: unknown[] = [];
    for (const member of group) {
      params.push(key, member);
    }
    insertIndexes.push(statements.length);
    statements.push({
      sql: `INSERT OR IGNORE INTO sets (key, member) VALUES ${group
        .map(() => "(?, ?)")
        .join(", ")} RETURNING member`,
      params,
    });
  }

  return {
    statements,
    mapResult: (results) => {
      if (wrongTypeFor(results, 1, "set")) {
        throw ErrWrongType;
      }
      let count = 0;
      for (const index of insertIndexes) {
        count += results[index].length;
      }
      return count;
    },
  };
}

export function translateSRem(args: string[]): Translation {
  if (args.length < 2) {
    throw errWrongArgs("srem");
  }

  const key = args[0];
  const members = [...new Set(args.slice(1))];
  const statements: Statement[] = [
    deleteIfExpired(key),
    { sql: "SELECT type FROM keys WHERE key = ?", params: [key] },
  ];

  const deleteIndexes: number[] = [];
  for (const group of chunk(members, MAX_ITEMS_PER_STATEMENT)) {
    deleteIndexes.push(statements.length);
    statements.push({
      sql: `DELETE FROM sets WHERE key = ? AND member IN (${placeholders(
        group.length
      )}) RETURNING member`,
      params: [key, ...group],
    });
  }

  statements.push({
    sql: "DELETE FROM keys WHERE key = ? AND NOT EXISTS (SELECT 1 FROM sets WHERE key = ?)",
    params: [key, key],
  });

  return {
    statements,
    mapResult: (results) => {
      if (wrongTypeFor(results, 1, "set")) {
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

export function translateSMembers(args: string[]): Translation {
  if (args.length !== 1) {
    throw errWrongArgs("smembers");
  }

  const key = args[0];
  const statements: Statement[] = [
    {
      sql: `SELECT k.type AS type, s.member AS member FROM keys k LEFT JOIN sets s ON s.key = k.key WHERE ${LIVE_KEY_LOOKUP} ORDER BY s.member`,
      params: [key],
    },
  ];

  return {
    statements,
    mapResult: (results) => {
      const rows = results[0];
      if (!checkKeyType(rows, "set")) {
        return [];
      }
      const out: string[] = [];
      for (const row of rows) {
        const member = rowStringOrNull(row, "member");
        if (member === null) {
          continue;
        }
        out.push(member);
      }
      return out;
    },
  };
}

export function translateSIsMember(args: string[]): Translation {
  if (args.length !== 2) {
    throw errWrongArgs("sismember");
  }

  const key = args[0];
  const member = args[1];
  const statements: Statement[] = [
    {
      sql: `SELECT k.type AS type, EXISTS (SELECT 1 FROM sets s WHERE s.key = k.key AND s.member = ?) AS present FROM keys k WHERE ${LIVE_KEY_LOOKUP}`,
      params: [member, key],
    },
  ];

  return {
    statements,
    mapResult: (results) => {
      const rows = results[0];
      if (!checkKeyType(rows, "set")) {
        return 0;
      }
      return Number(rows[0]["present"] ?? 0) > 0 ? 1 : 0;
    },
  };
}

export function translateSCard(args: string[]): Translation {
  if (args.length !== 1) {
    throw errWrongArgs("scard");
  }

  const key = args[0];
  const statements: Statement[] = [
    {
      sql: `SELECT k.type AS type, (SELECT COUNT(*) FROM sets s WHERE s.key = k.key) AS count FROM keys k WHERE ${LIVE_KEY_LOOKUP}`,
      params: [key],
    },
  ];

  return {
    statements,
    mapResult: (results) => {
      const rows = results[0];
      if (!checkKeyType(rows, "set")) {
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
