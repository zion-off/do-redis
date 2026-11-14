import { describe, expect, it } from "vitest";
import { translate } from "../../translator";

describe("utility translator", () => {
  it("PING returns PONG", () => {
    const translation = translate(["PING"]);
    expect(translation.statements).toHaveLength(0);
    expect(translation.mapResult([])).toBe("PONG");
  });

  it("KEYS narrows the scan to the literal prefix of the pattern", () => {
    const prefixed = translate(["KEYS", "user:*"]);
    expect(prefixed.statements[0].sql).toContain("key >= ?");
    expect(prefixed.statements[0].params).toEqual(["user:", "user;"]);

    const escaped = translate(["KEYS", "a\\*b*"]);
    expect(escaped.statements[0].params).toEqual(["a*b", "a*c"]);

    const wildcard = translate(["KEYS", "*"]);
    expect(wildcard.statements[0].params).toEqual([]);
    expect(wildcard.statements[0].sql).not.toContain("key >= ?");
  });

  it("KEYS still filters with the glob pattern", () => {
    const translation = translate(["KEYS", "a?"]);
    const rows = [{ key: "ab" }, { key: "abc" }];
    expect(translation.mapResult([rows])).toEqual(["ab"]);
  });
});
