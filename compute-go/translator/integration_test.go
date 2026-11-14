package translator

import (
	"database/sql"
	"fmt"
	"reflect"
	"testing"

	_ "modernc.org/sqlite"
)

// Mirrors the schema created by durable-object/src/index.ts.
var schemaStatements = []string{
	"CREATE TABLE IF NOT EXISTS keys (key TEXT PRIMARY KEY, type TEXT NOT NULL CHECK(type IN ('string', 'hash', 'list', 'set')), expires_at INTEGER)",
	"CREATE TABLE IF NOT EXISTS strings (key TEXT PRIMARY KEY REFERENCES keys(key) ON DELETE CASCADE, value TEXT NOT NULL)",
	"CREATE TABLE IF NOT EXISTS hashes (key TEXT NOT NULL REFERENCES keys(key) ON DELETE CASCADE, field TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (key, field))",
	`CREATE TABLE IF NOT EXISTS lists (key TEXT NOT NULL REFERENCES keys(key) ON DELETE CASCADE, "index" REAL NOT NULL, value TEXT NOT NULL, PRIMARY KEY (key, "index"))`,
	"CREATE TABLE IF NOT EXISTS sets (key TEXT NOT NULL REFERENCES keys(key) ON DELETE CASCADE, member TEXT NOT NULL, PRIMARY KEY (key, member))",
	"CREATE INDEX IF NOT EXISTS keys_expires_at ON keys (expires_at) WHERE expires_at IS NOT NULL",
}

const sweepSQL = "DELETE FROM keys WHERE expires_at IS NOT NULL AND expires_at <= unixepoch()"

const (
	pastTimestamp   = "1000000000"
	futureTimestamp = "4000000000"
)

// harness executes translated statements against a real SQLite database, the
// same way the storage Durable Object does.
type harness struct {
	t  *testing.T
	db *sql.DB
}

func newHarness(t *testing.T) *harness {
	t.Helper()
	db, err := sql.Open("sqlite", ":memory:?_pragma=foreign_keys(1)")
	if err != nil {
		t.Fatalf("open sqlite: %v", err)
	}
	db.SetMaxOpenConns(1)
	for _, stmt := range schemaStatements {
		if _, err := db.Exec(stmt); err != nil {
			t.Fatalf("schema: %v", err)
		}
	}
	t.Cleanup(func() { db.Close() })
	return &harness{t: t, db: db}
}

func (h *harness) query(sqlText string, params ...any) []map[string]any {
	rows, err := h.db.Query(sqlText, params...)
	if err != nil {
		h.t.Fatalf("query %q: %v", sqlText, err)
	}
	defer rows.Close()
	return scanRows(h.t, rows)
}

func scanRows(t *testing.T, rows *sql.Rows) []map[string]any {
	t.Helper()
	columns, err := rows.Columns()
	if err != nil {
		t.Fatalf("columns: %v", err)
	}
	out := []map[string]any{}
	for rows.Next() {
		cells := make([]any, len(columns))
		pointers := make([]any, len(columns))
		for i := range cells {
			pointers[i] = &cells[i]
		}
		if err := rows.Scan(pointers...); err != nil {
			t.Fatalf("scan: %v", err)
		}
		row := make(map[string]any, len(columns))
		for i, name := range columns {
			row[name] = cells[i]
		}
		out = append(out, row)
	}
	if err := rows.Err(); err != nil {
		t.Fatalf("rows: %v", err)
	}
	return out
}

func (h *harness) sweep() {
	if _, err := h.db.Exec(sweepSQL); err != nil {
		h.t.Fatalf("sweep: %v", err)
	}
}

// command runs a Redis command and returns its reply or the error message.
func (h *harness) command(cmd ...string) (any, string) {
	translation, err := Translate(cmd)
	if err != nil {
		return nil, err.Error()
	}

	results := make([][]map[string]any, 0, len(translation.Statements))
	tx, err := h.db.Begin()
	if err != nil {
		h.t.Fatalf("begin: %v", err)
	}
	for _, stmt := range translation.Statements {
		rows, queryErr := tx.Query(stmt.SQL, stmt.Params...)
		if queryErr != nil {
			tx.Rollback()
			return nil, queryErr.Error()
		}
		results = append(results, scanRows(h.t, rows))
		rows.Close()
	}
	if err := tx.Commit(); err != nil {
		h.t.Fatalf("commit: %v", err)
	}

	value, mapErr := translation.MapResult(results)
	if mapErr != nil {
		return nil, mapErr.Error()
	}
	return value, ""
}

func (h *harness) run(cmd ...string) any {
	h.t.Helper()
	value, errMessage := h.command(cmd...)
	if errMessage != "" {
		h.t.Fatalf("%v: unexpected error %s", cmd, errMessage)
	}
	return value
}

func (h *harness) expect(want any, cmd ...string) {
	h.t.Helper()
	got := h.run(cmd...)
	if !equalValue(got, want) {
		h.t.Fatalf("%v = %#v, want %#v", cmd, got, want)
	}
}

func (h *harness) expectError(want string, cmd ...string) {
	h.t.Helper()
	_, errMessage := h.command(cmd...)
	if errMessage != want {
		h.t.Fatalf("%v error = %q, want %q", cmd, errMessage, want)
	}
}

func equalValue(got, want any) bool {
	if want == nil || got == nil {
		return got == nil && want == nil
	}
	switch wanted := want.(type) {
	case int:
		return fmt.Sprint(got) == fmt.Sprint(wanted)
	case int64:
		return fmt.Sprint(got) == fmt.Sprint(wanted)
	case string:
		gotString, ok := got.(string)
		return ok && gotString == wanted
	default:
		return reflect.DeepEqual(got, want)
	}
}

const wrongTypeMessage = "WRONGTYPE Operation against a key holding the wrong kind of value"

func TestStringsEndToEnd(t *testing.T) {
	h := newHarness(t)

	h.expect("OK", "SET", "k", "v")
	h.expect("v", "GET", "k")
	h.expect("OK", "SET", "k", "v2")
	h.expect("v2", "GET", "k")
	h.expect(nil, "GET", "missing")

	h.expect("OK", "SET", "nx", "a", "NX")
	h.expect(nil, "SET", "nx", "b", "NX")
	h.expect("a", "GET", "nx")
	h.expect("OK", "SET", "nx", "c", "XX")
	h.expect("c", "GET", "nx")
	h.expect(nil, "SET", "absent", "x", "XX")
	h.expect("c", "SET", "nx", "d", "GET")
	h.expect(nil, "SET", "fresh", "x", "GET")
	h.expect("x", "GET", "fresh")

	h.expect("OK", "SET", "ttl", "v", "EXAT", futureTimestamp)
	if ttl := h.run("TTL", "ttl"); fmt.Sprint(ttl) == "-1" {
		t.Fatalf("expected a positive ttl, got %v", ttl)
	}
	h.expect("OK", "SET", "ttl", "v2")
	h.expect(-1, "TTL", "ttl")

	h.expect("OK", "SET", "keep", "v", "EXAT", futureTimestamp)
	h.expect("OK", "SET", "keep", "v2", "KEEPTTL")
	h.expect("v2", "GET", "keep")
	if ttl := fmt.Sprint(h.run("TTL", "keep")); ttl == "-1" || ttl == "-2" {
		t.Fatalf("KEEPTTL lost the expiry: %v", ttl)
	}

	h.expect("OK", "SET", "expired", "v", "EXAT", pastTimestamp)
	h.expect(nil, "GET", "expired")
}

func TestDelExistsAndMulti(t *testing.T) {
	h := newHarness(t)

	h.expect("OK", "MSET", "a", "1", "b", "2", "a", "3")
	h.expect([]any{"3", "2", nil, "3"}, "MGET", "a", "b", "missing", "a")
	h.expect(2, "EXISTS", "a", "b", "missing")
	h.expect(2, "EXISTS", "a", "a")
	h.expect(1, "DEL", "a", "a", "missing")
	h.expect(1, "DEL", "b")
	h.expect(0, "EXISTS", "a", "b")

	h.expect(1, "HSET", "h", "f", "v")
	h.expect([]any{nil}, "MGET", "h")
	h.expect("OK", "MSET", "h", "now-a-string")
	h.expect("now-a-string", "GET", "h")
	if rows := h.query("SELECT * FROM hashes"); len(rows) != 0 {
		t.Fatalf("hash rows survived MSET: %v", rows)
	}

	h.expect(1, "RPUSH", "l", "a")
	h.expect(1, "SADD", "s", "m")
	h.expect(2, "DEL", "l", "s")
	if rows := h.query("SELECT * FROM lists"); len(rows) != 0 {
		t.Fatalf("list rows survived DEL: %v", rows)
	}
	if rows := h.query("SELECT * FROM sets"); len(rows) != 0 {
		t.Fatalf("set rows survived DEL: %v", rows)
	}
}

func TestIncrementsEndToEnd(t *testing.T) {
	h := newHarness(t)

	h.expect(1, "INCR", "n")
	h.expect(2, "INCR", "n")
	h.expect(12, "INCRBY", "n", "10")
	h.expect(11, "DECR", "n")
	h.expect(0, "DECRBY", "n", "11")
	h.expect("0", "GET", "n")

	h.expect("OK", "SET", "s", "abc")
	h.expectError("ERR value is not an integer or out of range", "INCR", "s")
	h.expectError("ERR value is not an integer or out of range", "INCRBY", "n", "abc")

	h.expect("OK", "SET", "gone", "41", "EXAT", pastTimestamp)
	h.expect(1, "INCR", "gone")
	h.expect(-1, "TTL", "gone")

	h.expect(1, "HSET", "hash", "f", "v")
	h.expectError(wrongTypeMessage, "INCR", "hash")
	h.expectError(wrongTypeMessage, "GET", "hash")
}

func TestHashesEndToEnd(t *testing.T) {
	h := newHarness(t)

	h.expect(2, "HSET", "h", "a", "1", "b", "2")
	h.expect(0, "HSET", "h", "a", "9")
	h.expect(1, "HSET", "h", "c", "3", "c", "4")
	h.expect("9", "HGET", "h", "a")
	h.expect("4", "HGET", "h", "c")
	h.expect(nil, "HGET", "h", "zz")
	h.expect(nil, "HGET", "missing", "a")
	h.expect(1, "HDEL", "h", "a", "a", "zz")
	h.expect(2, "HDEL", "h", "b", "c")
	h.expect([]any{}, "HGETALL", "h")

	h.expect(2, "HSET", "g", "b", "2", "a", "1")
	h.expect([]any{"a", "1", "b", "2"}, "HGETALL", "g")
	h.expect([]any{"a", "b"}, "HKEYS", "g")
	h.expect([]any{"1", "2"}, "HVALS", "g")
	h.expect(1, "HEXISTS", "g", "a")
	h.expect(0, "HEXISTS", "g", "zz")
	h.expect(0, "HEXISTS", "missing", "a")
	h.expect([]any{}, "HGETALL", "missing")
	h.expect([]any{}, "HKEYS", "missing")
	h.expect([]any{}, "HVALS", "missing")

	for _, cmd := range [][]string{
		{"HGET", "s1", "f"},
		{"HGETALL", "s2"},
		{"HKEYS", "s3"},
		{"HVALS", "s4"},
		{"HEXISTS", "s5", "f"},
		{"HDEL", "s6", "f"},
		{"HSET", "s7", "f", "v"},
	} {
		h.expect("OK", "SET", cmd[1], "v")
		h.expectError(wrongTypeMessage, cmd...)
	}

	h.expect(1, "HSET", "exp", "f", "v")
	h.expect(1, "EXPIREAT", "exp", pastTimestamp)
	h.expect(nil, "HGET", "exp", "f")
	h.expect([]any{}, "HGETALL", "exp")
	h.expect(0, "HEXISTS", "exp", "f")
	h.expect(1, "HSET", "exp", "g", "1")
	h.expect([]any{"g", "1"}, "HGETALL", "exp")
}

func TestListsEndToEnd(t *testing.T) {
	h := newHarness(t)

	h.expect(2, "RPUSH", "l", "b", "c")
	h.expect(3, "LPUSH", "l", "a")
	h.expect([]any{"a", "b", "c"}, "LRANGE", "l", "0", "-1")
	h.expect(5, "LPUSH", "l", "x", "y")
	h.expect([]any{"y", "x", "a", "b", "c"}, "LRANGE", "l", "0", "-1")
	h.expect(7, "RPUSH", "l", "z", "w")
	h.expect([]any{"y", "x", "a", "b", "c", "z", "w"}, "LRANGE", "l", "0", "-1")
	h.expect([]any{"x", "a", "b"}, "LRANGE", "l", "1", "3")
	h.expect([]any{"z", "w"}, "LRANGE", "l", "-2", "-1")
	h.expect([]any{}, "LRANGE", "l", "5", "1")
	h.expect([]any{}, "LRANGE", "missing", "0", "-1")
	h.expect(7, "LLEN", "l")
	h.expect(0, "LLEN", "missing")

	h.expect(5, "RPUSH", "p", "a", "b", "c", "d", "e")
	h.expect("a", "LPOP", "p")
	h.expect("e", "RPOP", "p")
	h.expect([]any{"b", "c"}, "LPOP", "p", "2")
	h.expect([]any{"d"}, "RPOP", "p", "5")
	h.expect(nil, "LPOP", "p")
	h.expect(0, "EXISTS", "p")
	h.expect(nil, "LPOP", "missing")

	h.expect(2, "RPUSH", "m", "a", "b")
	h.expect([]any{}, "LPOP", "m", "0")
	h.expect(2, "LLEN", "m")

	for _, cmd := range [][]string{
		{"LPUSH", "s1", "v"},
		{"RPUSH", "s2", "v"},
		{"LPOP", "s3"},
		{"RPOP", "s4"},
		{"LRANGE", "s5", "0", "-1"},
		{"LLEN", "s6"},
	} {
		h.expect("OK", "SET", cmd[1], "v")
		h.expectError(wrongTypeMessage, cmd...)
	}

	h.expect(2, "RPUSH", "exp", "a", "b")
	h.expect(1, "EXPIREAT", "exp", pastTimestamp)
	h.expect(0, "LLEN", "exp")
	h.expect([]any{}, "LRANGE", "exp", "0", "-1")
	h.expect(1, "RPUSH", "exp", "c")
	h.expect([]any{"c"}, "LRANGE", "exp", "0", "-1")
}

func TestSetsEndToEnd(t *testing.T) {
	h := newHarness(t)

	h.expect(2, "SADD", "s", "a", "b", "a")
	h.expect(1, "SADD", "s", "b", "c")
	h.expect([]any{"a", "b", "c"}, "SMEMBERS", "s")
	h.expect(3, "SCARD", "s")
	h.expect(1, "SISMEMBER", "s", "a")
	h.expect(0, "SISMEMBER", "s", "zz")
	h.expect(1, "SREM", "s", "a", "a", "zz")
	h.expect(2, "SREM", "s", "b", "c")
	h.expect(0, "EXISTS", "s")
	h.expect([]any{}, "SMEMBERS", "missing")
	h.expect(0, "SCARD", "missing")
	h.expect(0, "SISMEMBER", "missing", "a")

	for _, cmd := range [][]string{
		{"SADD", "s1", "m"},
		{"SREM", "s2", "m"},
		{"SMEMBERS", "s3"},
		{"SCARD", "s4"},
		{"SISMEMBER", "s5", "m"},
	} {
		h.expect("OK", "SET", cmd[1], "v")
		h.expectError(wrongTypeMessage, cmd...)
	}

	h.expect(1, "SADD", "exp", "a")
	h.expect(1, "EXPIREAT", "exp", pastTimestamp)
	h.expect(0, "SCARD", "exp")
	h.expect([]any{}, "SMEMBERS", "exp")
	h.expect(0, "SISMEMBER", "exp", "a")
	h.expect(1, "SADD", "exp", "b")
	h.expect([]any{"b"}, "SMEMBERS", "exp")
}

func TestExpiryEndToEnd(t *testing.T) {
	h := newHarness(t)

	h.expect("OK", "SET", "k", "v")
	h.expect(-1, "TTL", "k")
	h.expect(-2, "TTL", "missing")
	h.expect(-2, "PTTL", "missing")
	h.expect(0, "EXPIRE", "missing", "10")
	h.expect(1, "EXPIRE", "k", "100")
	h.expect(1, "PERSIST", "k")
	h.expect(0, "PERSIST", "k")
	h.expect(-1, "TTL", "k")
	h.expect(1, "EXPIREAT", "k", futureTimestamp)

	h.expect("OK", "SET", "o", "v")
	h.expect(0, "EXPIRE", "o", "100", "XX")
	h.expect(1, "EXPIRE", "o", "100", "NX")
	h.expect(0, "EXPIRE", "o", "200", "NX")
	h.expect(1, "EXPIRE", "o", "200", "XX")
	h.expect(0, "EXPIRE", "o", "100", "GT")
	h.expect(1, "EXPIRE", "o", "300", "GT")
	h.expect(0, "EXPIRE", "o", "400", "LT")
	h.expect(1, "EXPIRE", "o", "100", "LT")
	h.expectError("ERR wrong number of arguments for 'expire' command", "EXPIRE", "o", "100", "ZZ")

	h.expect("OK", "SET", "e", "v")
	h.expect(1, "EXPIREAT", "e", pastTimestamp)
	h.expect(nil, "GET", "e")
	h.expect(0, "EXISTS", "e")
	h.expect(-2, "TTL", "e")
	h.expect(-2, "PTTL", "e")
	h.expect([]any{nil}, "MGET", "e")
	h.expect(0, "PERSIST", "e")
	h.expect(0, "EXPIRE", "e", "100")

	h.expect("OK", "SET", "r", "old")
	h.expect(1, "EXPIREAT", "r", pastTimestamp)
	h.expect("OK", "SET", "r", "new")
	h.expect("new", "GET", "r")
	h.expect(-1, "TTL", "r")
}

func TestSweepEndToEnd(t *testing.T) {
	h := newHarness(t)

	h.expect("OK", "SET", "gone", "v")
	h.expect("OK", "SET", "live", "v")
	h.expect(1, "EXPIREAT", "gone", pastTimestamp)
	h.sweep()

	rows := h.query("SELECT key FROM keys")
	if len(rows) != 1 || fmt.Sprint(rows[0]["key"]) != "live" {
		t.Fatalf("sweep left %v", rows)
	}
	if rows := h.query("SELECT key FROM strings"); len(rows) != 1 {
		t.Fatalf("cascade left %v", rows)
	}
	h.expect(nil, "GET", "gone")
	h.expect("v", "GET", "live")
}

func TestUtilityEndToEnd(t *testing.T) {
	h := newHarness(t)

	h.expect("PONG", "PING")
	h.expect("hi", "PING", "hi")
	h.expect("OK", "MSET", "a", "1", "ab", "2", "b", "3")
	h.expect(1, "HSET", "h", "f", "v")
	h.expect(4, "DBSIZE")
	h.expect([]any{"a", "ab", "b", "h"}, "KEYS", "*")
	h.expect([]any{"a", "ab"}, "KEYS", "a*")
	h.expect([]any{"ab"}, "KEYS", "a?")
	h.expect([]any{"a", "b"}, "KEYS", "[ab]")
	h.expect([]any{"a"}, "KEYS", "a")
	h.expect([]any{}, "KEYS", "zz*")
	h.expect("OK", "FLUSHDB")
	h.expect(0, "DBSIZE")
	if rows := h.query("SELECT * FROM strings"); len(rows) != 0 {
		t.Fatalf("flushdb left strings: %v", rows)
	}

	h.expect("OK", "MSET", "a*b", "1", "a:1", "2", "a:2", "3", "zz", "4")
	h.expect([]any{"a*b"}, "KEYS", `a\*b`)
	h.expect([]any{"a:1", "a:2"}, "KEYS", "a:*")
	h.expect([]any{"a:1", "a:2"}, "KEYS", "a:[12]")
	h.expect([]any{"a*b", "a:1", "a:2", "zz"}, "KEYS", "*")
}

func TestLargeCommandsEndToEnd(t *testing.T) {
	h := newHarness(t)

	keys := make([]string, 150)
	for i := range keys {
		keys[i] = fmt.Sprintf("k%03d", i)
	}

	pairs := make([]string, 0, len(keys)*2)
	values := make([]any, 0, len(keys))
	for i, key := range keys {
		pairs = append(pairs, key, fmt.Sprint(i))
		values = append(values, fmt.Sprint(i))
	}

	h.expect("OK", append([]string{"MSET"}, pairs...)...)
	h.expect(values, append([]string{"MGET"}, keys...)...)
	h.expect(150, append([]string{"EXISTS"}, append(append([]string{}, keys...), "missing")...)...)
	h.expect(150, "DBSIZE")
	h.expect(150, append([]string{"DEL"}, keys...)...)
	h.expect(0, "DBSIZE")

	listValues := make([]any, len(keys))
	reversed := make([]any, len(keys))
	for i, key := range keys {
		listValues[i] = key
		reversed[len(keys)-1-i] = key
	}
	h.expect(150, append([]string{"RPUSH", "l"}, keys...)...)
	h.expect(listValues, "LRANGE", "l", "0", "-1")
	h.expect(150, append([]string{"LPUSH", "p"}, keys...)...)
	h.expect(reversed, "LRANGE", "p", "0", "-1")
	h.expect(150, "LLEN", "p")

	h.expect(150, append([]string{"SADD", "s"}, keys...)...)
	h.expect(0, append([]string{"SADD", "s"}, keys...)...)
	h.expect(150, "SCARD", "s")
	h.expect(150, append([]string{"SREM", "s"}, keys...)...)
	h.expect(0, "EXISTS", "s")

	hashArgs := append([]string{"HSET", "h"}, pairs...)
	h.expect(150, hashArgs...)
	h.expect(0, hashArgs...)
	keyValues := make([]any, len(keys))
	for i, key := range keys {
		keyValues[i] = key
	}
	h.expect(keyValues, "HKEYS", "h")
	h.expect(150, append([]string{"HDEL", "h"}, keys...)...)
	h.expect([]any{}, "HGETALL", "h")
}

// snapshot dumps every table so tests can assert a command changed nothing.
func (h *harness) snapshot() []any {
	return []any{
		h.query("SELECT key, type, expires_at FROM keys ORDER BY key"),
		h.query("SELECT key, value FROM strings ORDER BY key"),
		h.query("SELECT key, field, value FROM hashes ORDER BY key, field"),
		h.query(`SELECT key, "index", value FROM lists ORDER BY key, "index"`),
		h.query("SELECT key, member FROM sets ORDER BY key, member"),
	}
}

func seedOneKeyPerType(h *harness) {
	h.expect("OK", "SET", "s", "str")
	h.expect(2, "HSET", "h", "f1", "v1", "f2", "v2")
	h.expect(3, "RPUSH", "l", "a", "b", "c")
	h.expect(2, "SADD", "t", "m1", "m2")
	// A TTL on every key makes expires_at changes visible in the snapshot.
	for _, key := range []string{"s", "h", "l", "t"} {
		h.expect(1, "EXPIREAT", key, futureTimestamp)
	}
}

func TestWrongTypeWritesLeaveDatabaseUntouched(t *testing.T) {
	many := make([]string, 150)
	manyPairs := make([]string, 0, 300)
	for i := range many {
		many[i] = fmt.Sprintf("x%d", i)
		manyPairs = append(manyPairs, many[i], "v")
	}
	with := func(prefix []string, rest ...string) []string {
		return append(append([]string{}, prefix...), rest...)
	}

	cases := []struct {
		cmd       []string // "KEY" is replaced by each wrong-typed key
		wrongKeys []string
	}{
		{[]string{"HSET", "KEY", "f1", "x", "new", "y"}, []string{"s", "l", "t"}},
		{with([]string{"HSET", "KEY"}, manyPairs...), []string{"s", "l", "t"}},
		{[]string{"HDEL", "KEY", "f1", "f2", "m1", "a"}, []string{"s", "l", "t"}},
		{with([]string{"HDEL", "KEY"}, many...), []string{"s", "l", "t"}},
		{[]string{"SADD", "KEY", "m1", "new"}, []string{"s", "h", "l"}},
		{with([]string{"SADD", "KEY"}, many...), []string{"s", "h", "l"}},
		{[]string{"SREM", "KEY", "m1", "m2", "f1"}, []string{"s", "h", "l"}},
		{with([]string{"SREM", "KEY"}, many...), []string{"s", "h", "l"}},
		{[]string{"LPUSH", "KEY", "x", "y"}, []string{"s", "h", "t"}},
		{[]string{"RPUSH", "KEY", "x", "y"}, []string{"s", "h", "t"}},
		{with([]string{"LPUSH", "KEY"}, many...), []string{"s", "h", "t"}},
		{with([]string{"RPUSH", "KEY"}, many...), []string{"s", "h", "t"}},
		{[]string{"LPOP", "KEY"}, []string{"s", "h", "t"}},
		{[]string{"RPOP", "KEY"}, []string{"s", "h", "t"}},
		{[]string{"LPOP", "KEY", "2"}, []string{"s", "h", "t"}},
		{[]string{"RPOP", "KEY", "2"}, []string{"s", "h", "t"}},
		{[]string{"INCR", "KEY"}, []string{"h", "l", "t"}},
		{[]string{"INCRBY", "KEY", "5"}, []string{"h", "l", "t"}},
		{[]string{"DECR", "KEY"}, []string{"h", "l", "t"}},
		{[]string{"DECRBY", "KEY", "5"}, []string{"h", "l", "t"}},
	}

	for _, tc := range cases {
		for _, wrongKey := range tc.wrongKeys {
			cmd := make([]string, len(tc.cmd))
			for i, arg := range tc.cmd {
				cmd[i] = arg
				if arg == "KEY" {
					cmd[i] = wrongKey
				}
			}
			t.Run(fmt.Sprintf("%s/%d args/%s", cmd[0], len(cmd), wrongKey), func(t *testing.T) {
				h := newHarness(t)
				seedOneKeyPerType(h)
				before := h.snapshot()
				h.expectError(wrongTypeMessage, cmd...)
				if after := h.snapshot(); !reflect.DeepEqual(before, after) {
					t.Fatalf("%v changed the database:\nbefore %v\nafter  %v", cmd, before, after)
				}
			})
		}
	}
}

func TestSetAndMSetStillOverwriteOtherTypes(t *testing.T) {
	h := newHarness(t)
	seedOneKeyPerType(h)

	h.expect("OK", "SET", "h", "x")
	h.expect("OK", "SET", "l", "x", "XX")
	h.expect("OK", "SET", "t", "x", "KEEPTTL")
	h.expect("OK", "MSET", "s", "y", "h", "z")
	h.expect("z", "GET", "h")
	h.expect("x", "GET", "l")
	h.expect("x", "GET", "t")
	h.expect("y", "GET", "s")
	h.expectError(wrongTypeMessage, "HSET", "h", "f", "v")
}

func TestWrongTypeRejectionKeepsCorrectTypeWorking(t *testing.T) {
	h := newHarness(t)
	seedOneKeyPerType(h)

	h.expectError(wrongTypeMessage, "SADD", "h", "x")
	h.expect(1, "HSET", "h", "f3", "v3")
	h.expect(1, "HDEL", "h", "f1")
	h.expect([]any{"f2", "v2", "f3", "v3"}, "HGETALL", "h")
	h.expect(2, "SREM", "t", "m1", "m2")
	h.expect(0, "EXISTS", "t")
	h.expect([]any{"a", "b", "c"}, "LPOP", "l", "3")
	h.expect(0, "EXISTS", "l")
}
