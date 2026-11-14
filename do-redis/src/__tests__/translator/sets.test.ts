import { describe, expect, it } from "vitest";
import { translate } from "../../translator";
import type { ResultRow } from "../../translator/types";

describe("sets translator", () => {
  it("SADD inserts members in one statement", () => {
    const translation = translate(["SADD", "k", "a", "b"]);
    expect(translation.statements).toHaveLength(4);
    expect(translation.statements[3].params).toEqual(["k", "a", "k", "b"]);
    const results: ResultRow[][] = [[], [], [], [{ member: "a" }, { member: "b" }]];
    expect(translation.mapResult(results)).toBe(2);
  });

  it("SMEMBERS returns members", () => {
    const translation = translate(["SMEMBERS", "k"]);
    expect(translation.statements).toHaveLength(1);
    const results: ResultRow[][] = [
      [
        { type: "set", member: "a" },
        { type: "set", member: "b" },
      ],
    ];
    expect(translation.mapResult(results)).toEqual(["a", "b"]);
    expect(translation.mapResult([[{ type: "set", member: null }]])).toEqual([]);
  });

  it("SREM returns count", () => {
    const translation = translate(["SREM", "k", "a"]);
    expect(translation.statements).toHaveLength(4);
    const results: ResultRow[][] = [[], [], [{ member: "a" }], []];
    expect(translation.mapResult(results)).toBe(1);
  });

  it("SCARD and SISMEMBER read a single row", () => {
    const scard = translate(["SCARD", "k"]);
    expect(scard.statements).toHaveLength(1);
    expect(scard.mapResult([[{ type: "set", count: 2 }]])).toBe(2);
    expect(scard.mapResult([[]])).toBe(0);

    const sismember = translate(["SISMEMBER", "k", "a"]);
    expect(sismember.statements).toHaveLength(1);
    expect(sismember.mapResult([[{ type: "set", present: 1 }]])).toBe(1);
    expect(sismember.mapResult([[{ type: "set", present: 0 }]])).toBe(0);
    expect(() => sismember.mapResult([[{ type: "string", present: 0 }]])).toThrow(
      "WRONGTYPE Operation against a key holding the wrong kind of value"
    );
  });
});
