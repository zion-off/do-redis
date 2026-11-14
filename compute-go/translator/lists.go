package translator

import (
	"sort"
	"strconv"
	"strings"
)

func translateLPush(args []string) (Translation, error) {
	return translatePush(args, "lpush", true)
}

func translateRPush(args []string) (Translation, error) {
	return translatePush(args, "rpush", false)
}

// pushStatement inserts a batch of values in one statement: the anchor index is
// read once as an aggregate sub-select and each value gets its own offset.
func pushStatement(key string, values []string, left bool) Statement {
	rows := make([]string, 0, len(values))
	params := []any{key, key}
	for i, value := range values {
		if i == 0 {
			rows = append(rows, "SELECT ? AS ord, ? AS val")
		} else {
			rows = append(rows, "SELECT ?, ?")
		}
		params = append(params, i+1, value)
	}
	params = append(params, key)

	anchor := `COALESCE(MAX("index"), 0.0) AS base`
	offset := "b.base + v.ord"
	if left {
		anchor = `COALESCE(MIN("index"), 1.0) AS base`
		offset = "b.base - v.ord"
	}

	return Statement{
		SQL:    `INSERT INTO lists (key, "index", value) SELECT ?, ` + offset + ", v.val FROM (SELECT " + anchor + " FROM lists WHERE key = ?) AS b, (" + strings.Join(rows, " UNION ALL ") + ") AS v WHERE " + keyHasType("list"),
		Params: params,
	}
}

func translatePush(args []string, cmd string, left bool) (Translation, error) {
	if len(args) < 2 {
		return Translation{}, errWrongArgs(cmd)
	}

	key := args[0]
	values := args[1:]
	stmts := []Statement{
		deleteIfExpired(key),
		{
			SQL:    "SELECT type FROM keys WHERE key = ?",
			Params: []any{key},
		},
		{
			SQL:    "INSERT OR IGNORE INTO keys (key, type) VALUES (?, 'list')",
			Params: []any{key},
		},
	}

	for _, group := range chunkStrings(values, maxItemsPerStatement) {
		stmts = append(stmts, pushStatement(key, group, left))
	}

	countIndex := len(stmts)
	stmts = append(stmts, Statement{
		SQL:    "SELECT COUNT(*) AS count FROM lists WHERE key = ?",
		Params: []any{key},
	})

	return Translation{
		Statements: stmts,
		MapResult: func(results [][]map[string]any) (any, error) {
			if wrongTypeFor(results, 1, "list") {
				return nil, ErrWrongType
			}
			if len(results[countIndex]) == 0 {
				return int64(0), nil
			}
			count, ok := parseInt64(rowString(results[countIndex][0], "count"))
			if !ok {
				return nil, ErrNotInteger
			}
			return count, nil
		},
	}, nil
}

func translateLPop(args []string) (Translation, error) {
	return translatePop(args, "lpop", true)
}

func translateRPop(args []string) (Translation, error) {
	return translatePop(args, "rpop", false)
}

func translatePop(args []string, cmd string, left bool) (Translation, error) {
	if len(args) < 1 || len(args) > 2 {
		return Translation{}, errWrongArgs(cmd)
	}

	key := args[0]
	var count int64
	var hasCount bool
	if len(args) == 2 {
		parsed, ok := parseInt64(args[1])
		if !ok {
			return Translation{}, ErrNotInteger
		}
		if parsed < 0 {
			return Translation{}, ErrNotInteger
		}
		hasCount = true
		count = parsed
	}

	stmts := []Statement{
		deleteIfExpired(key),
		{
			SQL:    "SELECT type FROM keys WHERE key = ?",
			Params: []any{key},
		},
	}

	var popSQL string
	var popParams []any
	if hasCount {
		order := "ASC"
		if !left {
			order = "DESC"
		}
		popSQL = `DELETE FROM lists WHERE key = ? AND ` + keyHasType("list") + ` AND "index" IN (SELECT "index" FROM lists WHERE key = ? ORDER BY "index" ` + order + ` LIMIT ?) RETURNING "index", value`
		popParams = []any{key, key, key, count}
	} else {
		if left {
			popSQL = `DELETE FROM lists WHERE key = ? AND ` + keyHasType("list") + ` AND "index" = (SELECT MIN("index") FROM lists WHERE key = ?) RETURNING "index", value`
			popParams = []any{key, key, key}
		} else {
			popSQL = `DELETE FROM lists WHERE key = ? AND ` + keyHasType("list") + ` AND "index" = (SELECT MAX("index") FROM lists WHERE key = ?) RETURNING "index", value`
			popParams = []any{key, key, key}
		}
	}

	popIndex := len(stmts)
	stmts = append(stmts, Statement{
		SQL:    popSQL,
		Params: popParams,
	})
	stmts = append(stmts, Statement{
		SQL:    "DELETE FROM keys WHERE key = ? AND type = 'list' AND NOT EXISTS (SELECT 1 FROM lists WHERE key = ?)",
		Params: []any{key, key},
	})

	return Translation{
		Statements: stmts,
		MapResult: func(results [][]map[string]any) (any, error) {
			if wrongTypeFor(results, 1, "list") {
				return nil, ErrWrongType
			}
			rows := results[popIndex]
			if !hasCount {
				if len(rows) == 0 {
					return nil, nil
				}
				return rowString(rows[0], "value"), nil
			}
			if count == 0 {
				return []any{}, nil
			}
			values := make([]struct {
				index float64
				value string
			}, 0, len(rows))
			for _, row := range rows {
				indexValue, err := strconv.ParseFloat(rowString(row, "index"), 64)
				if err != nil {
					return nil, ErrNotInteger
				}
				values = append(values, struct {
					index float64
					value string
				}{
					index: indexValue,
					value: rowString(row, "value"),
				})
			}

			sort.Slice(values, func(i, j int) bool {
				if left {
					return values[i].index < values[j].index
				}
				return values[i].index > values[j].index
			})

			out := make([]any, 0, len(values))
			for _, item := range values {
				out = append(out, item.value)
			}
			return out, nil
		},
	}, nil
}

func translateLRange(args []string) (Translation, error) {
	if len(args) != 3 {
		return Translation{}, errWrongArgs("lrange")
	}

	key := args[0]
	start, ok := parseInt64(args[1])
	if !ok {
		return Translation{}, ErrNotInteger
	}
	stop, ok := parseInt64(args[2])
	if !ok {
		return Translation{}, ErrNotInteger
	}

	stmts := []Statement{
		{
			SQL:    "SELECT k.type AS type, l.value AS value FROM keys k LEFT JOIN lists l ON l.key = k.key WHERE " + liveKeyLookup + ` ORDER BY l."index" ASC`,
			Params: []any{key},
		},
	}

	return Translation{
		Statements: stmts,
		MapResult: func(results [][]map[string]any) (any, error) {
			rows := results[0]
			found, err := checkKeyType(rows, "list")
			if err != nil {
				return nil, err
			}
			if !found {
				return []any{}, nil
			}
			values := make([]string, 0, len(rows))
			for _, row := range rows {
				value, ok := rowStringOrNull(row, "value")
				if !ok {
					continue
				}
				values = append(values, value)
			}
			if len(values) == 0 {
				return []any{}, nil
			}

			length := len(values)
			startIndex := int(start)
			stopIndex := int(stop)
			if startIndex < 0 {
				startIndex = length + startIndex
			}
			if stopIndex < 0 {
				stopIndex = length + stopIndex
			}
			if startIndex < 0 {
				startIndex = 0
			}
			if stopIndex > length-1 {
				stopIndex = length - 1
			}
			if startIndex > stopIndex || startIndex >= length || stopIndex < 0 {
				return []any{}, nil
			}

			out := make([]any, 0, stopIndex-startIndex+1)
			for _, value := range values[startIndex : stopIndex+1] {
				out = append(out, value)
			}
			return out, nil
		},
	}, nil
}

func translateLLen(args []string) (Translation, error) {
	if len(args) != 1 {
		return Translation{}, errWrongArgs("llen")
	}

	key := args[0]
	stmts := []Statement{
		{
			SQL:    "SELECT k.type AS type, (SELECT COUNT(*) FROM lists l WHERE l.key = k.key) AS count FROM keys k WHERE " + liveKeyLookup,
			Params: []any{key},
		},
	}

	return Translation{
		Statements: stmts,
		MapResult: func(results [][]map[string]any) (any, error) {
			rows := results[0]
			found, err := checkKeyType(rows, "list")
			if err != nil {
				return nil, err
			}
			if !found {
				return int64(0), nil
			}
			count, ok := parseInt64(rowString(rows[0], "count"))
			if !ok {
				return nil, ErrNotInteger
			}
			return count, nil
		},
	}, nil
}
