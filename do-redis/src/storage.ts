import { DurableObject } from "cloudflare:workers";
import { SCHEMA_STATEMENTS, SWEEP_SQL } from "./schema";

type Statement = { sql: string; params: unknown[] };

type ResultRow = Record<string, unknown>;

interface Env {}

/** Minimum delay between active expiry sweeps. */
const SWEEP_INTERVAL_MS = 1000;

export class StorageDurableObject extends DurableObject {
  private sql: SqlStorage;
  private lastSweep = Date.now();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
  }

  init(): void {
    this.ctx.storage.transactionSync(() => {
      for (const sql of SCHEMA_STATEMENTS) {
        this.sql.exec(sql).toArray();
      }
    });
    this.lastSweep = Date.now();
  }

  /**
   * Drops expired rows in the background of regular traffic. Commands already
   * filter expired keys out, so this only reclaims space; failures (for example
   * before `init()` has created the tables) are ignored on purpose.
   */
  private maybeSweep(): void {
    const now = Date.now();
    if (now - this.lastSweep < SWEEP_INTERVAL_MS) {
      return;
    }
    this.lastSweep = now;
    try {
      this.sql.exec(SWEEP_SQL).toArray();
    } catch {
      // best effort
    }
  }

  private run(statements: Statement[]): ResultRow[][] {
    const results: ResultRow[][] = new Array(statements.length);
    for (let i = 0; i < statements.length; i++) {
      const { sql, params } = statements[i];
      results[i] = this.sql.exec(sql, ...params).toArray();
    }
    return results;
  }

  execBatch(statements: Statement[]): ResultRow[][] {
    this.maybeSweep();
    // A single statement is already atomic, so the explicit transaction only
    // adds overhead.
    if (statements.length <= 1) {
      return this.run(statements);
    }
    return this.ctx.storage.transactionSync(() => this.run(statements));
  }

  execPipeline(batches: Statement[][]): ResultRow[][][] {
    this.maybeSweep();
    try {
      return this.ctx.storage.transactionSync(() => batches.map((batch) => this.run(batch)));
    } catch {
      // The outer transaction rolled back, so replay command by command to keep
      // the pre-existing semantics: commands before the failing one commit, and
      // the original error is surfaced to the caller.
      return this.execPipelineIsolated(batches);
    }
  }

  private execPipelineIsolated(batches: Statement[][]): ResultRow[][][] {
    const pipelineResults: ResultRow[][][] = [];
    for (const statements of batches) {
      if (statements.length <= 1) {
        pipelineResults.push(this.run(statements));
        continue;
      }
      pipelineResults.push(this.ctx.storage.transactionSync(() => this.run(statements)));
    }
    return pipelineResults;
  }
}
