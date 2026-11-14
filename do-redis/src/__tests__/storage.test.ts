import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({
  DurableObject: class {
    ctx: unknown;
    env: unknown;
    constructor(ctx: unknown, env: unknown) {
      this.ctx = ctx;
      this.env = env;
    }
  },
}));

import { StorageDurableObject } from "../storage";
import type { Statement } from "../translator/types";
import { loadSqlite } from "./helpers/sqlite";

const Database = await loadSqlite();

type Fake = {
  storage: StorageDurableObject;
  depth: () => number;
  maxDepth: () => number;
  query: (sql: string) => Record<string, unknown>[];
  close: () => void;
};

function makeStorage(): Fake {
  const db = new Database!(":memory:");
  let depth = 0;
  let maxDepth = 0;

  const ctx = {
    storage: {
      sql: {
        exec(sql: string, ...params: unknown[]) {
          const rows = db.prepare(sql).all(...params);
          return { toArray: () => rows };
        },
      },
      transactionSync<T>(callback: () => T): T {
        depth++;
        maxDepth = Math.max(maxDepth, depth);
        db.exec(depth === 1 ? "BEGIN" : `SAVEPOINT nested${depth}`);
        try {
          const value = callback();
          db.exec(depth === 1 ? "COMMIT" : `RELEASE nested${depth}`);
          return value;
        } catch (err) {
          db.exec(depth === 1 ? "ROLLBACK" : `ROLLBACK TO nested${depth}`);
          throw err;
        } finally {
          depth--;
        }
      },
    },
  };

  const storage = new StorageDurableObject(
    ctx as unknown as DurableObjectState,
    {} as never
  ) as StorageDurableObject;

  return {
    storage,
    depth: () => depth,
    maxDepth: () => maxDepth,
    query: (sql: string) => db.prepare(sql).all(),
    close: () => db.close(),
  };
}

const set = (key: string, value: string): Statement[] => [
  { sql: "DELETE FROM keys WHERE key = ?", params: [key] },
  { sql: "INSERT INTO keys (key, type) VALUES (?, 'string')", params: [key] },
  { sql: "INSERT INTO strings (key, value) VALUES (?, ?)", params: [key, value] },
];

describe.skipIf(!Database)("storage durable object", () => {
  let fake: Fake;

  beforeEach(() => {
    fake = makeStorage();
    fake.storage.init();
  });

  afterEach(() => {
    fake.close();
  });

  it("returns one result array per statement", () => {
    const results = fake.storage.execBatch([
      ...set("a", "1"),
      { sql: "SELECT value FROM strings WHERE key = ?", params: ["a"] },
    ]);
    expect(results).toHaveLength(4);
    expect(results[3]).toEqual([{ value: "1" }]);
  });

  it("runs a whole pipeline inside a single transaction", () => {
    const before = fake.maxDepth();
    const results = fake.storage.execPipeline([
      set("a", "1"),
      set("b", "2"),
      [{ sql: "SELECT key, value FROM strings ORDER BY key", params: [] }],
    ]);
    expect(results).toHaveLength(3);
    expect(results[2][0]).toEqual([
      { key: "a", value: "1" },
      { key: "b", value: "2" },
    ]);
    // one additional transaction for the pipeline, never nested
    expect(fake.maxDepth()).toBe(Math.max(before, 1));
    expect(fake.depth()).toBe(0);
  });

  it("replays command by command when a pipeline command fails", () => {
    expect(() =>
      fake.storage.execPipeline([
        set("a", "1"),
        [{ sql: "INSERT INTO keys (key, type) VALUES (?, 'bogus')", params: ["b"] }],
        set("c", "3"),
      ])
    ).toThrow();

    // commands before the failure stay committed, later ones never ran
    expect(fake.query("SELECT key FROM keys ORDER BY key")).toEqual([{ key: "a" }]);
  });

  it("skips the transaction for single statement batches", () => {
    const before = fake.maxDepth();
    fake.storage.execBatch([{ sql: "SELECT 1 AS one", params: [] }]);
    expect(fake.maxDepth()).toBe(before);
  });

  it("sweeps expired keys in the background", () => {
    fake.storage.execBatch([
      ...set("gone", "1"),
      { sql: "UPDATE keys SET expires_at = 1 WHERE key = ?", params: ["gone"] },
    ]);
    fake.storage.execBatch(set("live", "1"));
    expect(fake.query("SELECT key FROM keys ORDER BY key")).toHaveLength(2);

    vi.useFakeTimers();
    try {
      vi.setSystemTime(Date.now() + 10_000);
      fake.storage.execBatch([{ sql: "SELECT 1 AS one", params: [] }]);
    } finally {
      vi.useRealTimers();
    }

    expect(fake.query("SELECT key FROM keys")).toEqual([{ key: "live" }]);
    expect(fake.query("SELECT key FROM strings")).toEqual([{ key: "live" }]);
  });
});
