import { describe, expect, it } from "vitest";
import { translate } from "../../translator";
import type { ResultRow } from "../../translator/types";

describe("hashes translator", () => {
  it("HSET returns the number of new fields", () => {
    const translation = translate(["HSET", "k", "f", "v"]);
    expect(translation.statements).toHaveLength(4);
    expect(translation.mapResult([[], [], [], []])).toBe(1);
    expect(translation.mapResult([[], [{ type: "hash", existing: 1 }], [], []])).toBe(0);
  });

  it("HSET keeps the last value for repeated fields", () => {
    const translation = translate(["HSET", "k", "f", "1", "f", "2"]);
    const upsert = translation.statements[translation.statements.length - 1];
    expect(upsert.params).toEqual(["k", "f", "2", "k"]);
    expect(translation.mapResult([[], [], [], []])).toBe(1);
  });

  it("HSET chunks large field lists", () => {
    const pairs = Array.from({ length: 200 }, (_, i) => [`f${i}`, "v"]).flat();
    const translation = translate(["HSET", "k", ...pairs]);
    // delete-if-expired, type lookup, 4 count probes, key insert, 4 upserts
    expect(translation.statements).toHaveLength(11);
  });

  it("HGET missing returns null", () => {
    const translation = translate(["HGET", "k", "f"]);
    expect(translation.statements).toHaveLength(1);
    expect(translation.mapResult([[]])).toBeNull();
    expect(translation.mapResult([[{ type: "hash", value: "v" }]])).toBe("v");
  });

  it("HDEL collapses fields into one delete", () => {
    const translation = translate(["HDEL", "k", "a", "b", "a"]);
    expect(translation.statements).toHaveLength(3);
    expect(translation.statements[2].params).toEqual(["k", "a", "b", "k"]);
    expect(translation.mapResult([[], [], [{ field: "a" }]])).toBe(1);
  });

  it("HGETALL returns flattened list", () => {
    const translation = translate(["HGETALL", "k"]);
    expect(translation.statements).toHaveLength(1);
    const results: ResultRow[][] = [
      [
        { type: "hash", field: "a", value: "1" },
        { type: "hash", field: "b", value: "2" },
      ],
    ];
    expect(translation.mapResult(results)).toEqual(["a", "1", "b", "2"]);
    expect(translation.mapResult([[{ type: "hash", field: null, value: null }]])).toEqual([]);
  });

  it("HEXISTS maps the EXISTS projection", () => {
    const translation = translate(["HEXISTS", "k", "f"]);
    expect(translation.statements).toHaveLength(1);
    expect(translation.mapResult([[{ type: "hash", present: 1 }]])).toBe(1);
    expect(translation.mapResult([[{ type: "hash", present: 0 }]])).toBe(0);
    expect(translation.mapResult([[]])).toBe(0);
  });

  it("hash reads reject other key types", () => {
    const wrongType = "WRONGTYPE Operation against a key holding the wrong kind of value";
    expect(() => translate(["HGET", "k", "f"]).mapResult([[{ type: "string" }]])).toThrow(
      wrongType
    );
    expect(() => translate(["HKEYS", "k"]).mapResult([[{ type: "list" }]])).toThrow(wrongType);
    expect(() => translate(["HVALS", "k"]).mapResult([[{ type: "set" }]])).toThrow(wrongType);
  });
});
