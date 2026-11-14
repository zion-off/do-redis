import { describe, expect, it, vi } from "vitest";
import type { DurableObjectNamespace, DurableObjectState } from "@cloudflare/workers-types";

type StorageEnv = {
  STORAGE_SECRET: string;
  STORAGE: DurableObjectNamespace;
};

vi.mock("cloudflare:workers", () => ({
  DurableObject: class {
    ctx: DurableObjectState;
    env: StorageEnv;
    constructor(ctx: DurableObjectState, env: StorageEnv) {
      this.ctx = ctx;
      this.env = env;
    }
  },
}));

import { StorageDurableObject } from "../index";

type ExecResult = { toArray: () => unknown[] };
type SqlExec = (sql: string, ...params: unknown[]) => ExecResult;

type StorageCtx = {
  storage: {
    sql: { exec: SqlExec };
    transactionSync: <T>(fn: () => T) => T;
  };
};

function makeCtx(exec: SqlExec): StorageCtx & { transactions: () => number } {
  let transactions = 0;
  return {
    storage: {
      sql: { exec },
      transactionSync: <T>(fn: () => T): T => {
        transactions++;
        return fn();
      },
    },
    transactions: () => transactions,
  };
}

describe("StorageDurableObject", () => {
  it("init creates tables", () => {
    const exec = vi.fn<SqlExec>(() => ({ toArray: () => [] }));
    const ctx = makeCtx(exec) as unknown as DurableObjectState;
    const env: StorageEnv = { STORAGE_SECRET: "secret", STORAGE: {} as DurableObjectNamespace };
    const storage = new StorageDurableObject(ctx, env);

    storage.init();

    expect(exec).toHaveBeenCalledTimes(6);
    const calls = exec.mock.calls.map((call) => call[0]);
    expect(calls[0]).toContain("CREATE TABLE IF NOT EXISTS keys");
    expect(calls[1]).toContain("CREATE TABLE IF NOT EXISTS strings");
    expect(calls[2]).toContain("CREATE TABLE IF NOT EXISTS hashes");
    expect(calls[3]).toContain("CREATE TABLE IF NOT EXISTS lists");
    expect(calls[4]).toContain("CREATE TABLE IF NOT EXISTS sets");
    expect(calls[5]).toContain("CREATE INDEX IF NOT EXISTS keys_expires_at");
  });

  it("execBatch runs statements in order", () => {
    const exec = vi
      .fn<SqlExec>()
      .mockImplementationOnce(() => ({ toArray: () => [{ a: 1 }] }))
      .mockImplementationOnce(() => ({ toArray: () => [{ b: 2 }] }));
    const ctx = makeCtx(exec) as unknown as DurableObjectState;
    const env: StorageEnv = { STORAGE_SECRET: "secret", STORAGE: {} as DurableObjectNamespace };
    const storage = new StorageDurableObject(ctx, env);

    const results = storage.execBatch([
      { sql: "SELECT 1", params: [] },
      { sql: "SELECT 2", params: [] },
    ]);

    expect(exec).toHaveBeenCalledTimes(2);
    expect(results).toEqual([[{ a: 1 }], [{ b: 2 }]]);
  });

  it("execPipeline runs every batch in a single transaction", () => {
    const exec = vi.fn<SqlExec>(() => ({ toArray: () => [] }));
    const fake = makeCtx(exec);
    const ctx = fake as unknown as DurableObjectState;
    const env: StorageEnv = { STORAGE_SECRET: "secret", STORAGE: {} as DurableObjectNamespace };
    const storage = new StorageDurableObject(ctx, env);

    const results = storage.execPipeline([
      [{ sql: "SELECT 1", params: [] }],
      [{ sql: "SELECT 2", params: [] }],
    ]);

    expect(results).toEqual([[[]], [[]]]);
    expect(exec).toHaveBeenCalledTimes(2);
    expect(fake.transactions()).toBe(1);
  });

  it("execPipeline replays batch by batch when a statement fails", () => {
    let calls = 0;
    const exec = vi.fn<SqlExec>(() => {
      calls++;
      // fail only while the whole pipeline runs as one transaction
      if (calls === 2) {
        throw new Error("boom");
      }
      return { toArray: () => [] };
    });
    const fake = makeCtx(exec);
    const ctx = fake as unknown as DurableObjectState;
    const env: StorageEnv = { STORAGE_SECRET: "secret", STORAGE: {} as DurableObjectNamespace };
    const storage = new StorageDurableObject(ctx, env);

    const results = storage.execPipeline([
      [{ sql: "SELECT 1", params: [] }],
      [{ sql: "SELECT 2", params: [] }],
    ]);

    expect(results).toEqual([[[]], [[]]]);
    expect(fake.transactions()).toBe(1);
  });

  it("rejects missing or wrong auth", async () => {
    const exec = vi.fn<SqlExec>(() => ({ toArray: () => [] }));
    const ctx = makeCtx(exec) as unknown as DurableObjectState;
    const env: StorageEnv = { STORAGE_SECRET: "secret", STORAGE: {} as DurableObjectNamespace };
    const storage = new StorageDurableObject(ctx, env);

    const missing = await storage.fetch(new Request("http://localhost", { method: "POST" }));
    expect(missing.status).toBe(401);

    const wrong = await storage.fetch(
      new Request("http://localhost", {
        method: "POST",
        headers: { Authorization: "Bearer wrong" },
      })
    );
    expect(wrong.status).toBe(401);
  });

  it("handles statements payload", async () => {
    const exec = vi.fn<SqlExec>(() => ({ toArray: () => [{ ok: true }] }));
    const ctx = makeCtx(exec) as unknown as DurableObjectState;
    const env: StorageEnv = { STORAGE_SECRET: "secret", STORAGE: {} as DurableObjectNamespace };
    const storage = new StorageDurableObject(ctx, env);
    const execBatchSpy = vi.spyOn(storage, "execBatch");

    const response = await storage.fetch(
      new Request("http://localhost", {
        method: "POST",
        headers: { Authorization: "Bearer secret" },
        body: JSON.stringify({ statements: [{ sql: "SELECT 1", params: [] }] }),
      })
    );

    const body = await response.json();
    expect(execBatchSpy).toHaveBeenCalledTimes(1);
    expect(body).toEqual({ results: [[{ ok: true }]] });
  });

  it("handles pipeline payload", async () => {
    const exec = vi.fn<SqlExec>(() => ({ toArray: () => [] }));
    const ctx = makeCtx(exec) as unknown as DurableObjectState;
    const env: StorageEnv = { STORAGE_SECRET: "secret", STORAGE: {} as DurableObjectNamespace };
    const storage = new StorageDurableObject(ctx, env);

    const response = await storage.fetch(
      new Request("http://localhost", {
        method: "POST",
        headers: { Authorization: "Bearer secret" },
        body: JSON.stringify({
          pipeline: [
            { statements: [{ sql: "SELECT 1", params: [] }] },
            { statements: [{ sql: "SELECT 2", params: [] }] },
          ],
        }),
      })
    );

    const body = await response.json();
    expect(exec).toHaveBeenCalledTimes(2);
    expect(body).toEqual({ results: [[[]], [[]]] });
  });
});
