import { describe, expect, it } from "vitest";
import { translate } from "../../translator";
import { ErrNotInteger } from "../../translator/errors";
import type { ResultRow } from "../../translator/types";

describe("strings translator", () => {
  it("GET reads the key and its value in one statement", () => {
    const translation = translate(["GET", "missing"]);
    expect(translation.statements).toHaveLength(1);
    expect(translation.mapResult([[]])).toBeNull();
    expect(translation.mapResult([[{ type: "string", value: "v" }]])).toBe("v");
    expect(() => translation.mapResult([[{ type: "hash", value: null }]])).toThrow(
      "WRONGTYPE Operation against a key holding the wrong kind of value"
    );
  });

  it("SET basic returns OK", () => {
    const translation = translate(["SET", "k", "v"]);
    expect(translation.statements).toHaveLength(3);
    const results: ResultRow[][] = [[], [], []];
    expect(translation.mapResult(results)).toBe("OK");
  });

  it("SET NX when key exists returns null", () => {
    const translation = translate(["SET", "k", "v", "NX"]);
    expect(translation.statements).toHaveLength(3);
    const results: ResultRow[][] = [[], [], []];
    expect(translation.mapResult(results)).toBeNull();
  });

  it("SET XX when key missing returns null", () => {
    const translation = translate(["SET", "k", "v", "XX"]);
    expect(translation.statements).toHaveLength(3);
    const results: ResultRow[][] = [[], [], []];
    expect(translation.mapResult(results)).toBeNull();
  });

  it("SET EX 10 sets expires_at param", () => {
    const translation = translate(["SET", "k", "v", "EX", "10"]);
    const hasExpiryValue = translation.statements.some((stmt) =>
      stmt.params.some((param) => typeof param === "number" && Number.isFinite(param))
    );
    expect(hasExpiryValue).toBe(true);
  });

  it("INCR returns new value from RETURNING", () => {
    const translation = translate(["INCR", "k"]);
    expect(translation.statements).toHaveLength(5);
    const results: ResultRow[][] = [[], [], [], [], [{ value: 1 }]];
    expect(translation.mapResult(results)).toBe(1);
  });

  it("INCRBY uses delta", () => {
    const translation = translate(["INCRBY", "k", "5"]);
    expect(translation.statements).toHaveLength(5);
    const results: ResultRow[][] = [[], [{ type: "string", value: "0" }], [], [], [{ value: 5 }]];
    expect(translation.mapResult(results)).toBe(5);
  });

  it("INCR throws on non-integer key", () => {
    const translation = translate(["INCR", "k"]);
    const results: ResultRow[][] = [[], [{ type: "string", value: "abc" }], [], [], []];
    expect(() => translation.mapResult(results)).toThrow(ErrNotInteger);
  });

  it("DEL counts only live keys and dedupes", () => {
    const translation = translate(["DEL", "a", "a", "b"]);
    expect(translation.statements).toHaveLength(1);
    expect(translation.statements[0].params).toEqual(["a", "b"]);
    expect(translation.mapResult([[{ live: 1 }, { live: 0 }]])).toBe(1);
  });

  it("EXISTS counts duplicates from a single lookup", () => {
    const translation = translate(["EXISTS", "a", "a", "b"]);
    expect(translation.statements).toHaveLength(1);
    expect(translation.mapResult([[{ key: "a" }]])).toBe(2);
  });

  it("MGET preserves argument order and duplicates", () => {
    const translation = translate(["MGET", "a", "b", "a"]);
    expect(translation.statements).toHaveLength(1);
    expect(translation.mapResult([[{ key: "a", value: "1" }]])).toEqual(["1", null, "1"]);
  });

  it("MSET collapses pairs into three statements per batch", () => {
    const translation = translate(["MSET", "a", "1", "b", "2"]);
    expect(translation.statements).toHaveLength(3);
    expect(translation.statements[2].params).toEqual(["a", "1", "b", "2"]);
    expect(translation.mapResult([[], [], []])).toBe("OK");
  });

  it("chunks very large variadic commands", () => {
    const keys = Array.from({ length: 200 }, (_, i) => `k${i}`);
    expect(translate(["MGET", ...keys]).statements).toHaveLength(4);
    expect(translate(["DEL", ...keys]).statements).toHaveLength(4);
    expect(translate(["EXISTS", ...keys]).statements).toHaveLength(4);
    const pairs = keys.flatMap((key) => [key, "v"]);
    expect(translate(["MSET", ...pairs]).statements).toHaveLength(12);
  });

  it("rejects wrong args and invalid options", () => {
    expect(() => translate(["GET"])).toThrow("ERR wrong number of arguments for 'get' command");
    expect(() => translate(["SET", "k", "v", "NX", "XX"])).toThrow(
      "ERR wrong number of arguments for 'set' command"
    );
  });

  it("rejects unknown command", () => {
    expect(() => translate(["NOPE"])).toThrow("ERR unknown command 'nope'");
  });
});
