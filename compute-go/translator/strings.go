package translator

import (
	"fmt"
	"strconv"
	"strings"
	"time"
)

func translateGet(args []string) (Translation, error) {
	if len(args) != 1 {
		return Translation{}, errWrongArgs("get")
	}

	key := args[0]
	stmts := []Statement{
		{
			SQL:    "SELECT k.type AS type, s.value AS value FROM keys k LEFT JOIN strings s ON s.key = k.key WHERE " + liveKeyLookup,
			Params: []any{key},
		},
	}

	return Translation{
		Statements: stmts,
		MapResult: func(results [][]map[string]any) (any, error) {
			rows := results[0]
			found, err := checkKeyType(rows, "string")
			if err != nil {
				return nil, err
			}
			if !found {
				return nil, nil
			}
			value, ok := rowStringOrNull(rows[0], "value")
			if !ok {
				return nil, nil
			}
			return value, nil
		},
	}, nil
}

// clearOtherTypes drops rows left over from a previous non-string type: XX and
// KEEPTTL retype an existing key in place, so the cascade never runs.
func clearOtherTypes(key string) []Statement {
	stmts := make([]Statement, 0, 3)
	for _, table := range []string{"hashes", "lists", "sets"} {
		stmts = append(stmts, Statement{SQL: "DELETE FROM " + table + " WHERE key = ?", Params: []any{key}})
	}
	return stmts
}

func translateSet(args []string) (Translation, error) {
	if len(args) < 2 {
		return Translation{}, errWrongArgs("set")
	}

	key := args[0]
	value := args[1]
	options, err := parseSetOptions(args[2:])
	if err != nil {
		return Translation{}, err
	}

	var expiresAt any
	if !options.keepTTL {
		if options.expiresAt != nil {
			expiresAt = *options.expiresAt
		} else {
			expiresAt = nil
		}
	}

	conditional := options.nx || options.xx

	// The plain SET path replaces the key unconditionally, so a separate
	// expired-key cleanup is redundant: the DELETE below removes the row (and
	// its cascaded children) either way.
	stmts := []Statement{}
	if conditional || options.keepTTL {
		stmts = append(stmts, deleteIfExpired(key))
	}

	getIndex := -1
	if options.get {
		getIndex = len(stmts)
		if conditional || options.keepTTL {
			stmts = append(stmts, Statement{
				SQL:    "SELECT value FROM strings WHERE key = ?",
				Params: []any{key},
			})
		} else {
			stmts = append(stmts, Statement{
				SQL:    "SELECT s.value AS value FROM strings s JOIN keys k ON k.key = s.key WHERE s.key = ? AND (k.expires_at IS NULL OR k.expires_at > unixepoch())",
				Params: []any{key},
			})
		}
	}

	okIndex := -1
	switch {
	case options.nx:
		okIndex = len(stmts)
		stmts = append(stmts,
			Statement{
				SQL:    "INSERT OR IGNORE INTO keys (key, type, expires_at) VALUES (?, 'string', ?) RETURNING key",
				Params: []any{key, expiresAt},
			},
			Statement{
				SQL:    "INSERT INTO strings (key, value) SELECT ?, ? WHERE changes() > 0",
				Params: []any{key, value},
			},
		)
	case options.xx:
		stmts = append(stmts, clearOtherTypes(key)...)
		okIndex = len(stmts)
		if options.keepTTL {
			stmts = append(stmts, Statement{
				SQL:    "UPDATE keys SET type = 'string' WHERE key = ? RETURNING key",
				Params: []any{key},
			})
		} else {
			stmts = append(stmts, Statement{
				SQL:    "UPDATE keys SET type = 'string', expires_at = ? WHERE key = ? RETURNING key",
				Params: []any{expiresAt, key},
			})
		}
		stmts = append(stmts, Statement{
			SQL:    "INSERT OR REPLACE INTO strings (key, value) SELECT ?, ? WHERE changes() > 0",
			Params: []any{key, value},
		})
	default:
		if options.keepTTL {
			stmts = append(stmts, clearOtherTypes(key)...)
			stmts = append(stmts,
				Statement{
					SQL:    "UPDATE keys SET type = 'string' WHERE key = ? RETURNING key",
					Params: []any{key},
				},
				Statement{
					SQL:    "INSERT INTO keys (key, type) SELECT ?, 'string' WHERE changes() = 0",
					Params: []any{key},
				},
				Statement{
					SQL:    "INSERT OR REPLACE INTO strings (key, value) VALUES (?, ?)",
					Params: []any{key, value},
				},
			)
		} else {
			stmts = append(stmts,
				Statement{
					SQL:    "DELETE FROM keys WHERE key = ?",
					Params: []any{key},
				},
				Statement{
					SQL:    "INSERT INTO keys (key, type, expires_at) VALUES (?, 'string', ?)",
					Params: []any{key, expiresAt},
				},
				Statement{
					SQL:    "INSERT INTO strings (key, value) VALUES (?, ?)",
					Params: []any{key, value},
				},
			)
		}
	}

	return Translation{
		Statements: stmts,
		MapResult: func(results [][]map[string]any) (any, error) {
			var oldValue any
			if getIndex >= 0 {
				if len(results[getIndex]) == 0 {
					oldValue = nil
				} else {
					oldValue = rowString(results[getIndex][0], "value")
				}
			}

			if okIndex >= 0 && len(results[okIndex]) == 0 {
				return nil, nil
			}
			if options.get {
				return oldValue, nil
			}
			return "OK", nil
		},
	}, nil
}

func translateDel(args []string) (Translation, error) {
	if len(args) == 0 {
		return Translation{}, errWrongArgs("del")
	}

	// Expired-but-not-yet-swept rows are dropped too, but only live keys count
	// towards the reply.
	groups := chunkStrings(uniqueStrings(args), maxItemsPerStatement)
	stmts := make([]Statement, 0, len(groups))
	for _, group := range groups {
		stmts = append(stmts, Statement{
			SQL:    "DELETE FROM keys WHERE key IN (" + placeholders(len(group)) + ") RETURNING " + liveKey + " AS live",
			Params: toAnySlice(group),
		})
	}

	return Translation{
		Statements: stmts,
		MapResult: func(results [][]map[string]any) (any, error) {
			var count int64
			for _, res := range results {
				for _, row := range res {
					if rowTruthy(row, "live") {
						count++
					}
				}
			}
			return count, nil
		},
	}, nil
}

func translateExists(args []string) (Translation, error) {
	if len(args) == 0 {
		return Translation{}, errWrongArgs("exists")
	}

	groups := chunkStrings(uniqueStrings(args), maxItemsPerStatement)
	stmts := make([]Statement, 0, len(groups))
	for _, group := range groups {
		stmts = append(stmts, Statement{
			SQL:    "SELECT key FROM keys WHERE key IN (" + placeholders(len(group)) + ") AND " + liveKey,
			Params: toAnySlice(group),
		})
	}

	return Translation{
		Statements: stmts,
		MapResult: func(results [][]map[string]any) (any, error) {
			live := make(map[string]struct{})
			for _, res := range results {
				for _, row := range res {
					live[rowString(row, "key")] = struct{}{}
				}
			}
			var count int64
			for _, key := range args {
				if _, ok := live[key]; ok {
					count++
				}
			}
			return count, nil
		},
	}, nil
}

func translateIncr(args []string) (Translation, error) {
	return translateIncrByDelta(args, 1, "incr")
}

func translateIncrBy(args []string) (Translation, error) {
	if len(args) != 2 {
		return Translation{}, errWrongArgs("incrby")
	}

	delta, ok := parseInt64(args[1])
	if !ok {
		return Translation{}, ErrNotInteger
	}
	return translateIncrByDelta(args[:1], delta, "incrby")
}

func translateDecr(args []string) (Translation, error) {
	return translateIncrByDelta(args, -1, "decr")
}

func translateDecrBy(args []string) (Translation, error) {
	if len(args) != 2 {
		return Translation{}, errWrongArgs("decrby")
	}

	delta, ok := parseInt64(args[1])
	if !ok {
		return Translation{}, ErrNotInteger
	}
	return translateIncrByDelta(args[:1], -delta, "decrby")
}

func translateIncrByDelta(args []string, delta int64, cmd string) (Translation, error) {
	if len(args) != 1 {
		return Translation{}, errWrongArgs(cmd)
	}

	key := args[0]
	stmts := []Statement{
		deleteIfExpired(key),
		{
			SQL:    "SELECT k.type AS type, s.value AS value FROM keys k LEFT JOIN strings s ON s.key = k.key WHERE k.key = ?",
			Params: []any{key},
		},
		{
			SQL:    "INSERT OR IGNORE INTO keys (key, type) VALUES (?, 'string')",
			Params: []any{key},
		},
		{
			SQL:    "INSERT OR IGNORE INTO strings (key, value) SELECT ?, '0' WHERE EXISTS (SELECT 1 FROM keys WHERE key = ? AND type = 'string')",
			Params: []any{key, key},
		},
		{
			SQL:    "UPDATE strings SET value = CAST(CAST(value AS INTEGER) + ? AS INTEGER) WHERE key = ? AND " + keyHasType("string") + " AND CAST(CAST(value AS INTEGER) AS TEXT) = value RETURNING value",
			Params: []any{delta, key, key},
		},
	}

	return Translation{
		Statements: stmts,
		MapResult: func(results [][]map[string]any) (any, error) {
			if hasWrongType(results, 1) {
				return nil, ErrWrongType
			}
			// Missing rows are materialised as '0' by the statements above.
			before := "0"
			if len(results[1]) > 0 {
				if current, ok := rowStringOrNull(results[1][0], "value"); ok {
					before = current
				}
			}
			if _, ok := parseInt64(before); !ok {
				return nil, ErrNotInteger
			}
			if len(results[4]) == 0 {
				return nil, ErrNotInteger
			}
			after := rowString(results[4][0], "value")
			value, ok := parseInt64(after)
			if !ok {
				return nil, ErrNotInteger
			}
			return value, nil
		},
	}, nil
}

func translateMGet(args []string) (Translation, error) {
	if len(args) == 0 {
		return Translation{}, errWrongArgs("mget")
	}

	groups := chunkStrings(uniqueStrings(args), maxItemsPerStatement)
	stmts := make([]Statement, 0, len(groups))
	for _, group := range groups {
		stmts = append(stmts, Statement{
			SQL:    "SELECT s.key AS key, s.value AS value FROM strings s JOIN keys k ON k.key = s.key WHERE s.key IN (" + placeholders(len(group)) + ") AND (k.expires_at IS NULL OR k.expires_at > unixepoch())",
			Params: toAnySlice(group),
		})
	}

	return Translation{
		Statements: stmts,
		MapResult: func(results [][]map[string]any) (any, error) {
			values := make(map[string]string)
			for _, res := range results {
				for _, row := range res {
					values[rowString(row, "key")] = rowString(row, "value")
				}
			}
			out := make([]any, 0, len(args))
			for _, key := range args {
				if value, ok := values[key]; ok {
					out = append(out, value)
					continue
				}
				out = append(out, nil)
			}
			return out, nil
		},
	}, nil
}

func translateMSet(args []string) (Translation, error) {
	if len(args) == 0 || len(args)%2 != 0 {
		return Translation{}, errWrongArgs("mset")
	}

	// Later assignments win, matching sequential SET semantics.
	order := make([]string, 0, len(args)/2)
	pairs := make(map[string]string, len(args)/2)
	for i := 0; i < len(args); i += 2 {
		key := args[i]
		if _, ok := pairs[key]; !ok {
			order = append(order, key)
		}
		pairs[key] = args[i+1]
	}

	stmts := make([]Statement, 0, 3)
	for _, group := range chunkStrings(order, maxItemsPerStatement) {
		keyParams := toAnySlice(group)
		values := make([]any, 0, len(group)*2)
		keyTuples := make([]string, 0, len(group))
		valueTuples := make([]string, 0, len(group))
		for _, key := range group {
			values = append(values, key, pairs[key])
			keyTuples = append(keyTuples, "(?, 'string')")
			valueTuples = append(valueTuples, "(?, ?)")
		}
		stmts = append(stmts,
			Statement{
				SQL:    "DELETE FROM keys WHERE key IN (" + placeholders(len(group)) + ")",
				Params: keyParams,
			},
			Statement{
				SQL:    "INSERT INTO keys (key, type) VALUES " + strings.Join(keyTuples, ", "),
				Params: keyParams,
			},
			Statement{
				SQL:    "INSERT INTO strings (key, value) VALUES " + strings.Join(valueTuples, ", "),
				Params: values,
			},
		)
	}

	return Translation{
		Statements: stmts,
		MapResult: func(results [][]map[string]any) (any, error) {
			return "OK", nil
		},
	}, nil
}

type setOptions struct {
	nx        bool
	xx        bool
	get       bool
	keepTTL   bool
	expiresAt *int64
}

func parseSetOptions(args []string) (setOptions, error) {
	var opts setOptions
	var hasExpiry bool
	for i := 0; i < len(args); i++ {
		switch strings.ToUpper(args[i]) {
		case "NX":
			opts.nx = true
		case "XX":
			opts.xx = true
		case "GET":
			opts.get = true
		case "KEEPTTL":
			opts.keepTTL = true
		case "EX", "PX", "EXAT", "PXAT":
			if hasExpiry {
				return setOptions{}, errWrongArgs("set")
			}
			if i+1 >= len(args) {
				return setOptions{}, errWrongArgs("set")
			}
			value, ok := parseInt64(args[i+1])
			if !ok {
				return setOptions{}, ErrNotInteger
			}
			var expires int64
			switch strings.ToUpper(args[i]) {
			case "EX":
				expires = time.Now().Unix() + value
			case "PX":
				expires = time.Now().Unix() + value/1000
			case "EXAT":
				expires = value
			case "PXAT":
				expires = value / 1000
			}
			opts.expiresAt = &expires
			hasExpiry = true
			i++
		default:
			return setOptions{}, errWrongArgs("set")
		}
	}

	if opts.nx && opts.xx {
		return setOptions{}, errWrongArgs("set")
	}
	if opts.keepTTL && hasExpiry {
		return setOptions{}, errWrongArgs("set")
	}

	return opts, nil
}

func hasWrongType(results [][]map[string]any, index int) bool {
	return wrongTypeFor(results, index, "string")
}

func rowString(row map[string]any, key string) string {
	value, ok := row[key]
	if !ok || value == nil {
		return ""
	}
	switch v := value.(type) {
	case string:
		return v
	case []byte:
		return string(v)
	default:
		return fmt.Sprint(v)
	}
}

func parseInt64(value string) (int64, bool) {
	parsed, err := strconv.ParseInt(value, 10, 64)
	if err != nil {
		return 0, false
	}
	return parsed, true
}
