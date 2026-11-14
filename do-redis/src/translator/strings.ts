import type { Statement, Translation, ResultRow } from "./types";
import { ErrNotInteger, ErrWrongType, errWrongArgs } from "./errors";
import {
  LIVE_KEY,
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

function hasWrongType(results: ResultRow[][], index: number): boolean {
  return wrongTypeFor(results, index, "string");
}

type SetOptions = {
  nx: boolean;
  xx: boolean;
  get: boolean;
  keepTTL: boolean;
  expiresAt: number | null;
};

function parseSetOptions(args: string[]): SetOptions {
  const options: SetOptions = {
    nx: false,
    xx: false,
    get: false,
    keepTTL: false,
    expiresAt: null,
  };
  let hasExpiry = false;

  for (let i = 0; i < args.length; i++) {
    const token = args[i].toUpperCase();
    switch (token) {
      case "NX":
        options.nx = true;
        break;
      case "XX":
        options.xx = true;
        break;
      case "GET":
        options.get = true;
        break;
      case "KEEPTTL":
        options.keepTTL = true;
        break;
      case "EX":
      case "PX":
      case "EXAT":
      case "PXAT": {
        if (hasExpiry) {
          throw errWrongArgs("set");
        }
        if (i + 1 >= args.length) {
          throw errWrongArgs("set");
        }
        const parsed = parseIntStrict(args[i + 1]);
        if (parsed === null) {
          throw ErrNotInteger;
        }
        const now = Math.floor(Date.now() / 1000);
        let expiresAt: number;
        switch (token) {
          case "EX":
            expiresAt = now + parsed;
            break;
          case "PX":
            expiresAt = now + Math.trunc(parsed / 1000);
            break;
          case "EXAT":
            expiresAt = parsed;
            break;
          case "PXAT":
            expiresAt = Math.trunc(parsed / 1000);
            break;
          default:
            throw errWrongArgs("set");
        }
        options.expiresAt = expiresAt;
        hasExpiry = true;
        i++;
        break;
      }
      default:
        throw errWrongArgs("set");
    }
  }

  if (options.nx && options.xx) {
    throw errWrongArgs("set");
  }
  if (options.keepTTL && hasExpiry) {
    throw errWrongArgs("set");
  }

  return options;
}

export function translateGet(args: string[]): Translation {
  if (args.length !== 1) {
    throw errWrongArgs("get");
  }

  const key = args[0];
  const statements: Statement[] = [
    {
      sql: "SELECT k.type AS type, s.value AS value FROM keys k LEFT JOIN strings s ON s.key = k.key WHERE k.key = ? AND (k.expires_at IS NULL OR k.expires_at > unixepoch())",
      params: [key],
    },
  ];

  return {
    statements,
    mapResult: (results) => {
      const rows = results[0];
      if (!checkKeyType(rows, "string")) {
        return null;
      }
      return rowStringOrNull(rows[0], "value");
    },
  };
}

export function translateSet(args: string[]): Translation {
  if (args.length < 2) {
    throw errWrongArgs("set");
  }

  const key = args[0];
  const value = args[1];
  const options = parseSetOptions(args.slice(2));

  let expiresAt: number | null = null;
  if (!options.keepTTL) {
    expiresAt = options.expiresAt ?? null;
  }

  const conditional = options.nx || options.xx;
  const statements: Statement[] = [];

  // The plain SET path replaces the key unconditionally, so a separate
  // expired-key cleanup is redundant: the DELETE below removes the row (and its
  // cascaded children) either way.
  if (conditional || options.keepTTL) {
    statements.push(deleteIfExpired(key));
  }

  let getIndex = -1;
  if (options.get) {
    getIndex = statements.length;
    if (conditional || options.keepTTL) {
      statements.push({ sql: "SELECT value FROM strings WHERE key = ?", params: [key] });
    } else {
      statements.push({
        sql: "SELECT s.value AS value FROM strings s JOIN keys k ON k.key = s.key WHERE s.key = ? AND (k.expires_at IS NULL OR k.expires_at > unixepoch())",
        params: [key],
      });
    }
  }

  let okIndex = -1;
  if (options.nx) {
    okIndex = statements.length;
    statements.push(
      {
        sql: "INSERT OR IGNORE INTO keys (key, type, expires_at) VALUES (?, 'string', ?) RETURNING key",
        params: [key, expiresAt],
      },
      {
        sql: "INSERT INTO strings (key, value) SELECT ?, ? WHERE changes() > 0",
        params: [key, value],
      }
    );
  } else if (options.xx) {
    okIndex = statements.length;
    if (options.keepTTL) {
      statements.push({
        sql: "UPDATE keys SET type = 'string' WHERE key = ? RETURNING key",
        params: [key],
      });
    } else {
      statements.push({
        sql: "UPDATE keys SET type = 'string', expires_at = ? WHERE key = ? RETURNING key",
        params: [expiresAt, key],
      });
    }
    statements.push({
      sql: "INSERT OR REPLACE INTO strings (key, value) SELECT ?, ? WHERE changes() > 0",
      params: [key, value],
    });
  } else if (options.keepTTL) {
    statements.push(
      {
        sql: "UPDATE keys SET type = 'string' WHERE key = ? RETURNING key",
        params: [key],
      },
      {
        sql: "INSERT INTO keys (key, type) SELECT ?, 'string' WHERE changes() = 0",
        params: [key],
      },
      {
        sql: "INSERT OR REPLACE INTO strings (key, value) VALUES (?, ?)",
        params: [key, value],
      }
    );
  } else {
    statements.push(
      { sql: "DELETE FROM keys WHERE key = ?", params: [key] },
      {
        sql: "INSERT INTO keys (key, type, expires_at) VALUES (?, 'string', ?)",
        params: [key, expiresAt],
      },
      {
        sql: "INSERT INTO strings (key, value) VALUES (?, ?)",
        params: [key, value],
      }
    );
  }

  return {
    statements,
    mapResult: (results) => {
      let oldValue: unknown = null;
      if (getIndex >= 0) {
        if (results[getIndex].length === 0) {
          oldValue = null;
        } else {
          oldValue = rowString(results[getIndex][0], "value");
        }
      }

      if (okIndex >= 0 && results[okIndex].length === 0) {
        return null;
      }
      if (options.get) {
        return oldValue;
      }
      return "OK";
    },
  };
}

export function translateDel(args: string[]): Translation {
  if (args.length === 0) {
    throw errWrongArgs("del");
  }

  // Expired-but-not-yet-swept rows are dropped too, but only live keys count
  // towards the reply.
  const statements = chunk([...new Set(args)], MAX_ITEMS_PER_STATEMENT).map((keys) => ({
    sql: `DELETE FROM keys WHERE key IN (${placeholders(keys.length)}) RETURNING ${LIVE_KEY} AS live`,
    params: keys as unknown[],
  }));

  return {
    statements,
    mapResult: (results) => {
      let count = 0;
      for (const res of results) {
        for (const row of res) {
          if (row["live"]) {
            count++;
          }
        }
      }
      return count;
    },
  };
}

export function translateExists(args: string[]): Translation {
  if (args.length === 0) {
    throw errWrongArgs("exists");
  }

  const statements = chunk([...new Set(args)], MAX_ITEMS_PER_STATEMENT).map((keys) => ({
    sql: `SELECT key FROM keys WHERE key IN (${placeholders(keys.length)}) AND ${LIVE_KEY}`,
    params: keys as unknown[],
  }));

  return {
    statements,
    mapResult: (results) => {
      const live = new Set<string>();
      for (const res of results) {
        for (const row of res) {
          live.add(rowString(row, "key"));
        }
      }
      let count = 0;
      for (const key of args) {
        if (live.has(key)) {
          count++;
        }
      }
      return count;
    },
  };
}

function translateIncrByDelta(args: string[], delta: number, cmd: string): Translation {
  if (args.length !== 1) {
    throw errWrongArgs(cmd);
  }

  const key = args[0];
  const statements: Statement[] = [
    deleteIfExpired(key),
    {
      sql: "SELECT k.type AS type, s.value AS value FROM keys k LEFT JOIN strings s ON s.key = k.key WHERE k.key = ?",
      params: [key],
    },
    { sql: "INSERT OR IGNORE INTO keys (key, type) VALUES (?, 'string')", params: [key] },
    {
      sql: "INSERT OR IGNORE INTO strings (key, value) SELECT ?, '0' WHERE EXISTS (SELECT 1 FROM keys WHERE key = ? AND type = 'string')",
      params: [key, key],
    },
    {
      sql: "UPDATE strings SET value = CAST(CAST(value AS INTEGER) + ? AS INTEGER) WHERE key = ? AND CAST(CAST(value AS INTEGER) AS TEXT) = value RETURNING value",
      params: [delta, key],
    },
  ];

  return {
    statements,
    mapResult: (results) => {
      if (hasWrongType(results, 1)) {
        throw ErrWrongType;
      }
      // Missing rows are materialised as '0' by the statements above.
      const before =
        results[1].length === 0 ? "0" : (rowStringOrNull(results[1][0], "value") ?? "0");
      if (parseIntStrict(before) === null) {
        throw ErrNotInteger;
      }
      if (results[4].length === 0) {
        throw ErrNotInteger;
      }
      const after = rowString(results[4][0], "value");
      const value = parseIntStrict(after);
      if (value === null) {
        throw ErrNotInteger;
      }
      return value;
    },
  };
}

export function translateIncr(args: string[]): Translation {
  return translateIncrByDelta(args, 1, "incr");
}

export function translateIncrBy(args: string[]): Translation {
  if (args.length !== 2) {
    throw errWrongArgs("incrby");
  }
  const delta = parseIntStrict(args[1]);
  if (delta === null) {
    throw ErrNotInteger;
  }
  return translateIncrByDelta(args.slice(0, 1), delta, "incrby");
}

export function translateDecr(args: string[]): Translation {
  return translateIncrByDelta(args, -1, "decr");
}

export function translateDecrBy(args: string[]): Translation {
  if (args.length !== 2) {
    throw errWrongArgs("decrby");
  }
  const delta = parseIntStrict(args[1]);
  if (delta === null) {
    throw ErrNotInteger;
  }
  return translateIncrByDelta(args.slice(0, 1), -delta, "decrby");
}

export function translateMGet(args: string[]): Translation {
  if (args.length === 0) {
    throw errWrongArgs("mget");
  }

  const statements = chunk([...new Set(args)], MAX_ITEMS_PER_STATEMENT).map((keys) => ({
    sql: `SELECT s.key AS key, s.value AS value FROM strings s JOIN keys k ON k.key = s.key WHERE s.key IN (${placeholders(keys.length)}) AND (k.expires_at IS NULL OR k.expires_at > unixepoch())`,
    params: keys as unknown[],
  }));

  return {
    statements,
    mapResult: (results) => {
      const values = new Map<string, string>();
      for (const res of results) {
        for (const row of res) {
          values.set(rowString(row, "key"), rowString(row, "value"));
        }
      }
      return args.map((key) => values.get(key) ?? null);
    },
  };
}

export function translateMSet(args: string[]): Translation {
  if (args.length === 0 || args.length % 2 !== 0) {
    throw errWrongArgs("mset");
  }

  // Later assignments win, matching sequential SET semantics.
  const pairs = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    pairs.set(args[i], args[i + 1]);
  }

  const statements: Statement[] = [];
  for (const group of chunk([...pairs], MAX_ITEMS_PER_STATEMENT)) {
    const keys = group.map(([key]) => key);
    const values: unknown[] = [];
    for (const [key, value] of group) {
      values.push(key, value);
    }
    statements.push(
      {
        sql: `DELETE FROM keys WHERE key IN (${placeholders(keys.length)})`,
        params: keys,
      },
      {
        sql: `INSERT INTO keys (key, type) VALUES ${group.map(() => "(?, 'string')").join(", ")}`,
        params: keys,
      },
      {
        sql: `INSERT INTO strings (key, value) VALUES ${group.map(() => "(?, ?)").join(", ")}`,
        params: values,
      }
    );
  }

  return {
    statements,
    mapResult: () => "OK",
  };
}
