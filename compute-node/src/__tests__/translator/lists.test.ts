import { describe, expect, it } from "vitest";
import { translate } from "../../translator";
import type { ResultRow } from "../../translator/types";

function expectIndexQuoted(sql: string): void {
  expect(sql).toContain('"index"');
  const stripped = sql.replaceAll('"index"', "");
  expect(stripped.includes("index")).toBe(false);
}

describe("lists translator", () => {
  it("LPUSH pushes every value in one statement", () => {
    const translation = translate(["LPUSH", "k", "a", "b"]);
    expect(translation.statements).toHaveLength(5);
    expect(translation.statements[3].params).toEqual(["k", "k", 1, "a", 2, "b", "k"]);
    expectIndexQuoted(translation.statements[3].sql);
    const results: ResultRow[][] = [[], [], [], [], [{ count: "2" }]];
    expect(translation.mapResult(results)).toBe(2);
  });

  it("RPUSH returns count", () => {
    const translation = translate(["RPUSH", "k", "a"]);
    expect(translation.statements).toHaveLength(5);
    const results: ResultRow[][] = [[], [], [], [], [{ count: "1" }]];
    expect(translation.mapResult(results)).toBe(1);
  });

  it("pushes are chunked for very large argument lists", () => {
    const values = Array.from({ length: 200 }, (_, i) => `v${i}`);
    const translation = translate(["RPUSH", "k", ...values]);
    // delete-if-expired, type lookup, key insert, 4 inserts, count
    expect(translation.statements).toHaveLength(8);
  });

  it("LPOP uses quoted index", () => {
    const translation = translate(["LPOP", "k"]);
    expectIndexQuoted(translation.statements[2].sql);
    const results: ResultRow[][] = [[], [], [{ value: "v" }], []];
    expect(translation.mapResult(results)).toBe("v");
  });

  it("RPOP uses quoted index", () => {
    const translation = translate(["RPOP", "k"]);
    expectIndexQuoted(translation.statements[2].sql);
    const results: ResultRow[][] = [[], [], [{ value: "v" }], []];
    expect(translation.mapResult(results)).toBe("v");
  });

  it("LRANGE handles positive and negative indices", () => {
    const translation = translate(["LRANGE", "k", "1", "2"]);
    expect(translation.statements).toHaveLength(1);
    const results: ResultRow[][] = [
      [
        { type: "list", value: "a" },
        { type: "list", value: "b" },
        { type: "list", value: "c" },
        { type: "list", value: "d" },
      ],
    ];
    expect(translation.mapResult(results)).toEqual(["b", "c"]);

    const negative = translate(["LRANGE", "k", "-2", "-1"]);
    expect(negative.mapResult(results)).toEqual(["c", "d"]);
    expect(negative.mapResult([[{ type: "list", value: null }]])).toEqual([]);
    expect(negative.mapResult([[]])).toEqual([]);
  });

  it("LLEN reads the count alongside the type", () => {
    const translation = translate(["LLEN", "k"]);
    expect(translation.statements).toHaveLength(1);
    expect(translation.mapResult([[{ type: "list", count: 3 }]])).toBe(3);
    expect(translation.mapResult([[]])).toBe(0);
    expect(() => translation.mapResult([[{ type: "string", count: 0 }]])).toThrow(
      "WRONGTYPE Operation against a key holding the wrong kind of value"
    );
  });
});
