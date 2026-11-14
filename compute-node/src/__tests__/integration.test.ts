import { beforeEach, afterEach, describe, expect, it } from "vitest";
import { Harness, loadSqlite } from "./helpers/sqlite";

const Database = await loadSqlite();

const PAST = "1000000000";
const FUTURE = "4000000000";

describe.skipIf(!Database)("end-to-end behavior on real sqlite", () => {
  let db: Harness;

  beforeEach(() => {
    db = new Harness(Database!);
  });

  afterEach(() => {
    db.close();
  });

  describe("strings", () => {
    it("SET/GET round trips and overwrites", () => {
      expect(db.run(["SET", "k", "v"])).toBe("OK");
      expect(db.run(["GET", "k"])).toBe("v");
      expect(db.run(["SET", "k", "v2"])).toBe("OK");
      expect(db.run(["GET", "k"])).toBe("v2");
      expect(db.run(["GET", "missing"])).toBeNull();
    });

    it("SET NX/XX/GET/KEEPTTL semantics", () => {
      expect(db.run(["SET", "k", "a", "NX"])).toBe("OK");
      expect(db.run(["SET", "k", "b", "NX"])).toBeNull();
      expect(db.run(["GET", "k"])).toBe("a");
      expect(db.run(["SET", "k", "c", "XX"])).toBe("OK");
      expect(db.run(["GET", "k"])).toBe("c");
      expect(db.run(["SET", "missing", "x", "XX"])).toBeNull();
      expect(db.run(["GET", "missing"])).toBeNull();
      expect(db.run(["SET", "k", "d", "GET"])).toBe("c");
      expect(db.run(["SET", "fresh", "x", "GET"])).toBeNull();
      expect(db.run(["GET", "fresh"])).toBe("x");
    });

    it("SET clears TTL unless KEEPTTL is used", () => {
      db.run(["SET", "k", "v", "EXAT", FUTURE]);
      expect(db.run(["TTL", "k"])).toBeGreaterThan(0);
      db.run(["SET", "k", "v2"]);
      expect(db.run(["TTL", "k"])).toBe(-1);

      db.run(["SET", "k2", "v", "EXAT", FUTURE]);
      db.run(["SET", "k2", "v2", "KEEPTTL"]);
      expect(db.run(["TTL", "k2"])).toBeGreaterThan(0);
      expect(db.run(["GET", "k2"])).toBe("v2");
    });

    it("SET EX/PX/EXAT/PXAT all expire keys", () => {
      db.run(["SET", "a", "1", "EXAT", PAST]);
      expect(db.run(["GET", "a"])).toBeNull();
      db.run(["SET", "b", "1", "PXAT", `${Number(PAST) * 1000}`]);
      expect(db.run(["GET", "b"])).toBeNull();
      db.run(["SET", "c", "1", "EX", "100"]);
      expect(db.run(["GET", "c"])).toBe("1");
      db.run(["SET", "d", "1", "PX", "100000"]);
      expect(db.run(["GET", "d"])).toBe("1");
    });

    it("DEL and EXISTS count keys", () => {
      db.run(["MSET", "a", "1", "b", "2"]);
      expect(db.run(["EXISTS", "a", "b", "missing"])).toBe(2);
      expect(db.run(["EXISTS", "a", "a"])).toBe(2);
      expect(db.run(["DEL", "a", "a", "missing"])).toBe(1);
      expect(db.run(["DEL", "b"])).toBe(1);
      expect(db.run(["EXISTS", "a", "b"])).toBe(0);
    });

    it("DEL removes dependent rows", () => {
      db.run(["HSET", "h", "f", "v"]);
      db.run(["RPUSH", "l", "a"]);
      db.run(["SADD", "s", "m"]);
      db.run(["SET", "str", "v"]);
      expect(db.run(["DEL", "h", "l", "s", "str"])).toBe(4);
      expect(db.rows("SELECT * FROM hashes")).toHaveLength(0);
      expect(db.rows("SELECT * FROM lists")).toHaveLength(0);
      expect(db.rows("SELECT * FROM sets")).toHaveLength(0);
      expect(db.rows("SELECT * FROM strings")).toHaveLength(0);
    });

    it("MGET/MSET handle duplicates, misses and wrong types", () => {
      expect(db.run(["MSET", "a", "1", "b", "2", "a", "3"])).toBe("OK");
      expect(db.run(["MGET", "a", "b", "missing", "a"])).toEqual(["3", "2", null, "3"]);
      db.run(["HSET", "h", "f", "v"]);
      expect(db.run(["MGET", "a", "h"])).toEqual(["3", null]);
      expect(db.run(["MSET", "h", "now-a-string"])).toBe("OK");
      expect(db.run(["GET", "h"])).toBe("now-a-string");
      expect(db.rows("SELECT * FROM hashes")).toHaveLength(0);
    });

    it("INCR/DECR families", () => {
      expect(db.run(["INCR", "n"])).toBe(1);
      expect(db.run(["INCR", "n"])).toBe(2);
      expect(db.run(["INCRBY", "n", "10"])).toBe(12);
      expect(db.run(["DECR", "n"])).toBe(11);
      expect(db.run(["DECRBY", "n", "11"])).toBe(0);
      expect(db.run(["GET", "n"])).toBe("0");
      db.run(["SET", "s", "abc"]);
      expect(db.command(["INCR", "s"])).toEqual({
        error: "ERR value is not an integer or out of range",
      });
      expect(db.command(["INCRBY", "n", "abc"])).toEqual({
        error: "ERR value is not an integer or out of range",
      });
    });

    it("INCR on an expired key restarts from zero", () => {
      db.run(["SET", "n", "41", "EXAT", FUTURE]);
      db.run(["EXPIREAT", "n", PAST]);
      expect(db.run(["INCR", "n"])).toBe(1);
      expect(db.run(["TTL", "n"])).toBe(-1);
    });

    it("wrong type errors", () => {
      db.run(["HSET", "h", "f", "v"]);
      expect(db.command(["GET", "h"])).toEqual({
        error: "WRONGTYPE Operation against a key holding the wrong kind of value",
      });
      expect(db.command(["INCR", "h"])).toEqual({
        error: "WRONGTYPE Operation against a key holding the wrong kind of value",
      });
    });

    it("argument validation", () => {
      expect(db.command(["GET"])).toEqual({
        error: "ERR wrong number of arguments for 'get' command",
      });
      expect(db.command(["MSET", "a"])).toEqual({
        error: "ERR wrong number of arguments for 'mset' command",
      });
      expect(db.command(["NOPE"])).toEqual({ error: "ERR unknown command 'nope'" });
    });
  });

  describe("hashes", () => {
    it("HSET/HGET/HDEL and field counting", () => {
      expect(db.run(["HSET", "h", "a", "1", "b", "2"])).toBe(2);
      expect(db.run(["HSET", "h", "a", "9"])).toBe(0);
      expect(db.run(["HSET", "h", "c", "3", "c", "4"])).toBe(1);
      expect(db.run(["HGET", "h", "a"])).toBe("9");
      expect(db.run(["HGET", "h", "c"])).toBe("4");
      expect(db.run(["HGET", "h", "zz"])).toBeNull();
      expect(db.run(["HGET", "missing", "a"])).toBeNull();
      expect(db.run(["HDEL", "h", "a", "a", "zz"])).toBe(1);
      expect(db.run(["HDEL", "h", "b", "c"])).toBe(2);
      expect(db.run(["HGETALL", "h"])).toEqual([]);
    });

    it("HGETALL/HKEYS/HVALS/HEXISTS", () => {
      db.run(["HSET", "h", "b", "2", "a", "1"]);
      expect(db.run(["HGETALL", "h"])).toEqual(["a", "1", "b", "2"]);
      expect(db.run(["HKEYS", "h"])).toEqual(["a", "b"]);
      expect(db.run(["HVALS", "h"])).toEqual(["1", "2"]);
      expect(db.run(["HEXISTS", "h", "a"])).toBe(1);
      expect(db.run(["HEXISTS", "h", "zz"])).toBe(0);
      expect(db.run(["HEXISTS", "missing", "a"])).toBe(0);
      expect(db.run(["HGETALL", "missing"])).toEqual([]);
      expect(db.run(["HKEYS", "missing"])).toEqual([]);
      expect(db.run(["HVALS", "missing"])).toEqual([]);
    });

    it("hash commands reject wrong types", () => {
      db.run(["SET", "s", "v"]);
      const wrongType = {
        error: "WRONGTYPE Operation against a key holding the wrong kind of value",
      };
      expect(db.command(["HGET", "s", "f"])).toEqual(wrongType);
      expect(db.command(["HGETALL", "s"])).toEqual(wrongType);
      expect(db.command(["HKEYS", "s"])).toEqual(wrongType);
      expect(db.command(["HVALS", "s"])).toEqual(wrongType);
      expect(db.command(["HEXISTS", "s", "f"])).toEqual(wrongType);
      expect(db.command(["HDEL", "s", "f"])).toEqual(wrongType);
      expect(db.command(["HSET", "s", "f", "v"])).toEqual(wrongType);
    });

    it("expired hash keys behave as missing", () => {
      db.run(["HSET", "h", "f", "v"]);
      db.run(["EXPIREAT", "h", PAST]);
      expect(db.run(["HGET", "h", "f"])).toBeNull();
      expect(db.run(["HGETALL", "h"])).toEqual([]);
      expect(db.run(["HEXISTS", "h", "f"])).toBe(0);
      expect(db.run(["HSET", "h", "g", "1"])).toBe(1);
      expect(db.run(["HGETALL", "h"])).toEqual(["g", "1"]);
    });
  });

  describe("lists", () => {
    it("LPUSH/RPUSH ordering and LRANGE", () => {
      expect(db.run(["RPUSH", "l", "b", "c"])).toBe(2);
      expect(db.run(["LPUSH", "l", "a"])).toBe(3);
      expect(db.run(["LRANGE", "l", "0", "-1"])).toEqual(["a", "b", "c"]);
      expect(db.run(["LPUSH", "l", "x", "y"])).toBe(5);
      expect(db.run(["LRANGE", "l", "0", "-1"])).toEqual(["y", "x", "a", "b", "c"]);
      expect(db.run(["RPUSH", "l", "z", "w"])).toBe(7);
      expect(db.run(["LRANGE", "l", "0", "-1"])).toEqual(["y", "x", "a", "b", "c", "z", "w"]);
      expect(db.run(["LRANGE", "l", "1", "3"])).toEqual(["x", "a", "b"]);
      expect(db.run(["LRANGE", "l", "-2", "-1"])).toEqual(["z", "w"]);
      expect(db.run(["LRANGE", "l", "5", "1"])).toEqual([]);
      expect(db.run(["LRANGE", "missing", "0", "-1"])).toEqual([]);
      expect(db.run(["LLEN", "l"])).toBe(7);
      expect(db.run(["LLEN", "missing"])).toBe(0);
    });

    it("LPOP/RPOP with and without counts", () => {
      db.run(["RPUSH", "l", "a", "b", "c", "d", "e"]);
      expect(db.run(["LPOP", "l"])).toBe("a");
      expect(db.run(["RPOP", "l"])).toBe("e");
      expect(db.run(["LPOP", "l", "2"])).toEqual(["b", "c"]);
      expect(db.run(["RPOP", "l", "5"])).toEqual(["d"]);
      expect(db.run(["LPOP", "l"])).toBeNull();
      expect(db.run(["EXISTS", "l"])).toBe(0);
      expect(db.run(["LPOP", "missing"])).toBeNull();

      db.run(["RPUSH", "m", "a", "b"]);
      expect(db.run(["LPOP", "m", "0"])).toEqual([]);
      expect(db.run(["LLEN", "m"])).toBe(2);
    });

    it("list commands reject wrong types", () => {
      const wrongType = {
        error: "WRONGTYPE Operation against a key holding the wrong kind of value",
      };
      for (const cmd of [
        ["LPUSH", "s1", "v"],
        ["RPUSH", "s2", "v"],
        ["LPOP", "s3"],
        ["RPOP", "s4"],
        ["LRANGE", "s5", "0", "-1"],
        ["LLEN", "s6"],
      ]) {
        db.run(["SET", cmd[1], "v"]);
        expect(db.command(cmd)).toEqual(wrongType);
      }
    });

    it("expired list keys behave as missing", () => {
      db.run(["RPUSH", "l", "a", "b"]);
      db.run(["EXPIREAT", "l", PAST]);
      expect(db.run(["LLEN", "l"])).toBe(0);
      expect(db.run(["LRANGE", "l", "0", "-1"])).toEqual([]);
      expect(db.run(["RPUSH", "l", "c"])).toBe(1);
      expect(db.run(["LRANGE", "l", "0", "-1"])).toEqual(["c"]);
    });
  });

  describe("sets", () => {
    it("SADD/SREM/SMEMBERS/SCARD/SISMEMBER", () => {
      expect(db.run(["SADD", "s", "a", "b", "a"])).toBe(2);
      expect(db.run(["SADD", "s", "b", "c"])).toBe(1);
      expect(db.run(["SMEMBERS", "s"])).toEqual(["a", "b", "c"]);
      expect(db.run(["SCARD", "s"])).toBe(3);
      expect(db.run(["SISMEMBER", "s", "a"])).toBe(1);
      expect(db.run(["SISMEMBER", "s", "zz"])).toBe(0);
      expect(db.run(["SREM", "s", "a", "a", "zz"])).toBe(1);
      expect(db.run(["SREM", "s", "b", "c"])).toBe(2);
      expect(db.run(["EXISTS", "s"])).toBe(0);
      expect(db.run(["SMEMBERS", "missing"])).toEqual([]);
      expect(db.run(["SCARD", "missing"])).toBe(0);
      expect(db.run(["SISMEMBER", "missing", "a"])).toBe(0);
    });

    it("set commands reject wrong types", () => {
      const wrongType = {
        error: "WRONGTYPE Operation against a key holding the wrong kind of value",
      };
      for (const cmd of [
        ["SADD", "s1", "m"],
        ["SREM", "s2", "m"],
        ["SMEMBERS", "s3"],
        ["SCARD", "s4"],
        ["SISMEMBER", "s5", "m"],
      ]) {
        db.run(["SET", cmd[1], "v"]);
        expect(db.command(cmd)).toEqual(wrongType);
      }
    });

    it("expired set keys behave as missing", () => {
      db.run(["SADD", "s", "a"]);
      db.run(["EXPIREAT", "s", PAST]);
      expect(db.run(["SCARD", "s"])).toBe(0);
      expect(db.run(["SMEMBERS", "s"])).toEqual([]);
      expect(db.run(["SISMEMBER", "s", "a"])).toBe(0);
      expect(db.run(["SADD", "s", "b"])).toBe(1);
      expect(db.run(["SMEMBERS", "s"])).toEqual(["b"]);
    });
  });

  describe("expiry", () => {
    it("EXPIRE/EXPIREAT/TTL/PTTL/PERSIST", () => {
      db.run(["SET", "k", "v"]);
      expect(db.run(["TTL", "k"])).toBe(-1);
      expect(db.run(["TTL", "missing"])).toBe(-2);
      expect(db.run(["PTTL", "missing"])).toBe(-2);
      expect(db.run(["EXPIRE", "missing", "10"])).toBe(0);
      expect(db.run(["EXPIRE", "k", "100"])).toBe(1);
      expect(db.run(["TTL", "k"])).toBeGreaterThan(90);
      expect(db.run(["PTTL", "k"])).toBeGreaterThan(90000);
      expect(db.run(["PERSIST", "k"])).toBe(1);
      expect(db.run(["PERSIST", "k"])).toBe(0);
      expect(db.run(["TTL", "k"])).toBe(-1);
      expect(db.run(["EXPIREAT", "k", FUTURE])).toBe(1);
      expect(db.run(["TTL", "k"])).toBeGreaterThan(0);
    });

    it("EXPIRE NX/XX/GT/LT options", () => {
      db.run(["SET", "k", "v"]);
      expect(db.run(["EXPIRE", "k", "100", "XX"])).toBe(0);
      expect(db.run(["EXPIRE", "k", "100", "NX"])).toBe(1);
      expect(db.run(["EXPIRE", "k", "200", "NX"])).toBe(0);
      expect(db.run(["EXPIRE", "k", "200", "XX"])).toBe(1);
      expect(db.run(["EXPIRE", "k", "100", "GT"])).toBe(0);
      expect(db.run(["EXPIRE", "k", "300", "GT"])).toBe(1);
      expect(db.run(["EXPIRE", "k", "400", "LT"])).toBe(0);
      expect(db.run(["EXPIRE", "k", "100", "LT"])).toBe(1);
      expect(db.command(["EXPIRE", "k", "100", "ZZ"])).toEqual({
        error: "ERR wrong number of arguments for 'expire' command",
      });
    });

    it("expired keys are invisible to reads", () => {
      db.run(["SET", "k", "v"]);
      db.run(["EXPIREAT", "k", PAST]);
      expect(db.run(["GET", "k"])).toBeNull();
      expect(db.run(["EXISTS", "k"])).toBe(0);
      expect(db.run(["TTL", "k"])).toBe(-2);
      expect(db.run(["PTTL", "k"])).toBe(-2);
      expect(db.run(["MGET", "k"])).toEqual([null]);
      expect(db.run(["DBSIZE"])).toBe(0);
      expect(db.run(["KEYS", "*"])).toEqual([]);
      expect(db.run(["PERSIST", "k"])).toBe(0);
      expect(db.run(["EXPIRE", "k", "100"])).toBe(0);
    });

    it("expired keys are replaced by writes", () => {
      db.run(["SET", "k", "old"]);
      db.run(["EXPIREAT", "k", PAST]);
      expect(db.run(["SET", "k", "new"])).toBe("OK");
      expect(db.run(["GET", "k"])).toBe("new");
      expect(db.run(["TTL", "k"])).toBe(-1);
    });

    it("DEL reports expired keys as missing but still reclaims them", () => {
      db.run(["SET", "k", "v"]);
      db.run(["EXPIREAT", "k", PAST]);
      expect(db.run(["DEL", "k"])).toBe(0);
      expect(db.rows("SELECT key FROM keys")).toEqual([]);
    });

    it("sweep removes expired rows without changing results", () => {
      db.run(["SET", "k", "v"]);
      db.run(["SET", "live", "v"]);
      db.run(["EXPIREAT", "k", PAST]);
      db.sweep();
      expect(db.rows("SELECT key FROM keys")).toEqual([{ key: "live" }]);
      expect(db.rows("SELECT key FROM strings")).toEqual([{ key: "live" }]);
      expect(db.run(["GET", "k"])).toBeNull();
      expect(db.run(["GET", "live"])).toBe("v");
    });
  });

  describe("large commands", () => {
    const keys = Array.from({ length: 150 }, (_, i) => `k${String(i).padStart(3, "0")}`);

    it("MSET/MGET/EXISTS/DEL span multiple statement chunks", () => {
      const pairs = keys.flatMap((key, i) => [key, String(i)]);
      expect(db.run(["MSET", ...pairs])).toBe("OK");
      expect(db.run(["MGET", ...keys])).toEqual(keys.map((_, i) => String(i)));
      expect(db.run(["EXISTS", ...keys, "missing"])).toBe(150);
      expect(db.run(["DBSIZE"])).toBe(150);
      expect(db.run(["DEL", ...keys])).toBe(150);
      expect(db.run(["DBSIZE"])).toBe(0);
    });

    it("RPUSH/LPUSH keep ordering across chunks", () => {
      const values = keys.slice(0, 150);
      expect(db.run(["RPUSH", "l", ...values])).toBe(150);
      expect(db.run(["LRANGE", "l", "0", "-1"])).toEqual(values);
      expect(db.run(["LPUSH", "p", ...values])).toBe(150);
      expect(db.run(["LRANGE", "p", "0", "-1"])).toEqual([...values].reverse());
      expect(db.run(["LLEN", "p"])).toBe(150);
      expect(db.run(["LPOP", "p", "150"])).toEqual([...values].reverse());
    });

    it("SADD/SREM and HSET/HDEL span multiple statement chunks", () => {
      expect(db.run(["SADD", "s", ...keys])).toBe(150);
      expect(db.run(["SADD", "s", ...keys])).toBe(0);
      expect(db.run(["SCARD", "s"])).toBe(150);
      expect(db.run(["SREM", "s", ...keys])).toBe(150);
      expect(db.run(["EXISTS", "s"])).toBe(0);

      const pairs = keys.flatMap((key, i) => [key, String(i)]);
      expect(db.run(["HSET", "h", ...pairs])).toBe(150);
      expect(db.run(["HSET", "h", ...pairs])).toBe(0);
      expect(db.run(["HKEYS", "h"])).toEqual(keys);
      expect(db.run(["HDEL", "h", ...keys])).toBe(150);
      expect(db.run(["HGETALL", "h"])).toEqual([]);
    });
  });

  describe("wrong-type writes", () => {
    const WRONGTYPE = {
      error: "WRONGTYPE Operation against a key holding the wrong kind of value",
    };

    // One key per type, all carrying a TTL so expires_at changes are detected too.
    const seed = (): void => {
      db.run(["SET", "s", "str"]);
      db.run(["HSET", "h", "f1", "v1", "f2", "v2"]);
      db.run(["RPUSH", "l", "a", "b", "c"]);
      db.run(["SADD", "t", "m1", "m2"]);
      for (const key of ["s", "h", "l", "t"]) {
        db.run(["EXPIREAT", key, FUTURE]);
      }
    };

    const snapshot = (): unknown[] => [
      db.rows("SELECT key, type, expires_at FROM keys ORDER BY key"),
      db.rows("SELECT key, value FROM strings ORDER BY key"),
      db.rows("SELECT key, field, value FROM hashes ORDER BY key, field"),
      db.rows('SELECT key, "index", value FROM lists ORDER BY key, "index"'),
      db.rows("SELECT key, member FROM sets ORDER BY key, member"),
    ];

    const many = (prefix: string): string[] =>
      Array.from({ length: 150 }, (_, i) => `${prefix}${i}`);

    const cases: Array<{ cmd: string[]; wrongKeys: string[] }> = [
      { cmd: ["HSET", "KEY", "f1", "x", "new", "y"], wrongKeys: ["s", "l", "t"] },
      {
        cmd: ["HSET", "KEY", ...many("f").flatMap((f) => [f, "x"])],
        wrongKeys: ["s", "l", "t"],
      },
      { cmd: ["HDEL", "KEY", "f1", "f2", "m1", "a"], wrongKeys: ["s", "l", "t"] },
      { cmd: ["HDEL", "KEY", ...many("f"), "f1"], wrongKeys: ["s", "l", "t"] },
      { cmd: ["SADD", "KEY", "m1", "new"], wrongKeys: ["s", "h", "l"] },
      { cmd: ["SADD", "KEY", ...many("m")], wrongKeys: ["s", "h", "l"] },
      { cmd: ["SREM", "KEY", "m1", "m2", "f1"], wrongKeys: ["s", "h", "l"] },
      { cmd: ["SREM", "KEY", ...many("m"), "m1"], wrongKeys: ["s", "h", "l"] },
      { cmd: ["LPUSH", "KEY", "x", "y"], wrongKeys: ["s", "h", "t"] },
      { cmd: ["RPUSH", "KEY", "x", "y"], wrongKeys: ["s", "h", "t"] },
      { cmd: ["LPUSH", "KEY", ...many("v")], wrongKeys: ["s", "h", "t"] },
      { cmd: ["RPUSH", "KEY", ...many("v")], wrongKeys: ["s", "h", "t"] },
      { cmd: ["LPOP", "KEY"], wrongKeys: ["s", "h", "t"] },
      { cmd: ["RPOP", "KEY"], wrongKeys: ["s", "h", "t"] },
      { cmd: ["LPOP", "KEY", "2"], wrongKeys: ["s", "h", "t"] },
      { cmd: ["RPOP", "KEY", "2"], wrongKeys: ["s", "h", "t"] },
      { cmd: ["INCR", "KEY"], wrongKeys: ["h", "l", "t"] },
      { cmd: ["INCRBY", "KEY", "5"], wrongKeys: ["h", "l", "t"] },
      { cmd: ["DECR", "KEY"], wrongKeys: ["h", "l", "t"] },
      { cmd: ["DECRBY", "KEY", "5"], wrongKeys: ["h", "l", "t"] },
    ];

    for (const { cmd, wrongKeys } of cases) {
      for (const wrongKey of wrongKeys) {
        const name = `${cmd[0]} (${cmd.length} args) on ${wrongKey} is rejected without changes`;
        it(name, () => {
          seed();
          const before = snapshot();
          const actual = cmd.map((arg) => (arg === "KEY" ? wrongKey : arg));
          expect(db.command(actual)).toEqual(WRONGTYPE);
          expect(snapshot()).toEqual(before);
        });
      }
    }

    it("wrong-type pushes and pops on an empty-looking key do not delete it", () => {
      db.run(["SET", "s", "str"]);
      db.run(["HSET", "h", "f", "v"]);
      for (const cmd of [
        ["SREM", "s", "m"],
        ["LPOP", "s"],
        ["RPOP", "h", "3"],
        ["SREM", "h", "m"],
      ]) {
        expect(db.command(cmd)).toEqual(WRONGTYPE);
      }
      expect(db.run(["GET", "s"])).toBe("str");
      expect(db.run(["HGETALL", "h"])).toEqual(["f", "v"]);
    });

    it("correct-type writes still work after a rejected wrong-type write", () => {
      seed();
      expect(db.command(["SADD", "h", "x"])).toEqual(WRONGTYPE);
      expect(db.run(["HSET", "h", "f3", "v3"])).toBe(1);
      expect(db.run(["HDEL", "h", "f1"])).toBe(1);
      expect(db.run(["HGETALL", "h"])).toEqual(["f2", "v2", "f3", "v3"]);
      expect(db.run(["SREM", "t", "m1", "m2"])).toBe(2);
      expect(db.run(["EXISTS", "t"])).toBe(0);
      expect(db.run(["LPOP", "l", "3"])).toEqual(["a", "b", "c"]);
      expect(db.run(["EXISTS", "l"])).toBe(0);
    });

    it("SET and MSET still overwrite keys of any other type", () => {
      seed();
      expect(db.run(["SET", "h", "x"])).toBe("OK");
      expect(db.run(["SET", "l", "x"])).toBe("OK");
      expect(db.run(["MSET", "t", "x", "s", "y"])).toBe("OK");
      expect(db.run(["GET", "h"])).toBe("x");
      expect(db.run(["GET", "l"])).toBe("x");
      expect(db.run(["GET", "t"])).toBe("x");
      expect(db.run(["GET", "s"])).toBe("y");
      expect(db.rows("SELECT key FROM hashes")).toHaveLength(0);
      expect(db.rows("SELECT key FROM lists")).toHaveLength(0);
      expect(db.rows("SELECT key FROM sets")).toHaveLength(0);
    });

    it("SET XX and KEEPTTL still overwrite keys of another type", () => {
      seed();
      expect(db.run(["SET", "h", "x", "XX"])).toBe("OK");
      expect(db.run(["SET", "l", "x", "KEEPTTL"])).toBe("OK");
      expect(db.run(["GET", "h"])).toBe("x");
      expect(db.run(["GET", "l"])).toBe("x");
      expect(db.run(["TTL", "l"])).toBeGreaterThan(0);
      expect(db.command(["HSET", "h", "f", "v"])).toEqual(WRONGTYPE);
    });

    it("DEL, EXPIRE and PERSIST work on any type", () => {
      seed();
      expect(db.run(["PERSIST", "h"])).toBe(1);
      expect(db.run(["EXPIRE", "l", "100"])).toBe(1);
      expect(db.run(["DEL", "h", "l", "t"])).toBe(3);
      expect(db.rows("SELECT key FROM hashes")).toHaveLength(0);
    });
  });

  describe("utility", () => {
    it("PING/DBSIZE/KEYS/FLUSHDB", () => {
      expect(db.run(["PING"])).toBe("PONG");
      expect(db.run(["PING", "hi"])).toBe("hi");
      db.run(["MSET", "a", "1", "ab", "2", "b", "3"]);
      db.run(["HSET", "h", "f", "v"]);
      expect(db.run(["DBSIZE"])).toBe(4);
      expect(db.run(["KEYS", "*"])).toEqual(["a", "ab", "b", "h"]);
      expect(db.run(["KEYS", "a*"])).toEqual(["a", "ab"]);
      expect(db.run(["KEYS", "a?"])).toEqual(["ab"]);
      expect(db.run(["KEYS", "[ab]"])).toEqual(["a", "b"]);
      expect(db.run(["KEYS", "a"])).toEqual(["a"]);
      expect(db.run(["KEYS", "zz*"])).toEqual([]);
      expect(db.run(["FLUSHDB"])).toBe("OK");
      expect(db.run(["DBSIZE"])).toBe(0);
      expect(db.rows("SELECT * FROM strings")).toHaveLength(0);
      expect(db.rows("SELECT * FROM hashes")).toHaveLength(0);
    });

    it("KEYS matches literal prefixes with escapes and classes", () => {
      db.run(["MSET", "a*b", "1", "a:1", "2", "a:2", "3", "zz", "4"]);
      expect(db.run(["KEYS", "a\\*b"])).toEqual(["a*b"]);
      expect(db.run(["KEYS", "a:*"])).toEqual(["a:1", "a:2"]);
      expect(db.run(["KEYS", "a:[12]"])).toEqual(["a:1", "a:2"]);
      expect(db.run(["KEYS", "*"])).toEqual(["a*b", "a:1", "a:2", "zz"]);
    });
  });
});
