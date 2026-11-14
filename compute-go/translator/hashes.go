package translator

import "strings"

func translateHGet(args []string) (Translation, error) {
	if len(args) != 2 {
		return Translation{}, errWrongArgs("hget")
	}

	key := args[0]
	field := args[1]
	stmts := []Statement{
		{
			SQL:    "SELECT k.type AS type, h.value AS value FROM keys k LEFT JOIN hashes h ON h.key = k.key AND h.field = ? WHERE " + liveKeyLookup,
			Params: []any{field, key},
		},
	}

	return Translation{
		Statements: stmts,
		MapResult: func(results [][]map[string]any) (any, error) {
			rows := results[0]
			found, err := checkKeyType(rows, "hash")
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

func translateHSet(args []string) (Translation, error) {
	if len(args) < 3 || (len(args)-1)%2 != 0 {
		return Translation{}, errWrongArgs("hset")
	}

	key := args[0]
	// Later assignments to the same field win, and a repeated field only counts
	// once towards the "fields added" reply.
	fields := make([]string, 0, (len(args)-1)/2)
	pairs := make(map[string]string, (len(args)-1)/2)
	for i := 1; i < len(args); i += 2 {
		field := args[i]
		if _, ok := pairs[field]; !ok {
			fields = append(fields, field)
		}
		pairs[field] = args[i+1]
	}

	stmts := []Statement{deleteIfExpired(key)}
	existingIndexes := make([]int, 0, 1)

	if len(fields) <= maxItemsPerStatement {
		params := make([]any, 0, len(fields)+1)
		params = append(params, toAnySlice(fields)...)
		params = append(params, key)
		existingIndexes = append(existingIndexes, len(stmts))
		stmts = append(stmts, Statement{
			SQL:    "SELECT k.type AS type, (SELECT COUNT(*) FROM hashes h WHERE h.key = k.key AND h.field IN (" + placeholders(len(fields)) + ")) AS existing FROM keys k WHERE k.key = ?",
			Params: params,
		})
	} else {
		stmts = append(stmts, Statement{
			SQL:    "SELECT type FROM keys WHERE key = ?",
			Params: []any{key},
		})
		for _, group := range chunkStrings(fields, maxItemsPerStatement) {
			params := make([]any, 0, len(group)+1)
			params = append(params, key)
			params = append(params, toAnySlice(group)...)
			existingIndexes = append(existingIndexes, len(stmts))
			stmts = append(stmts, Statement{
				SQL:    "SELECT COUNT(*) AS existing FROM hashes WHERE key = ? AND field IN (" + placeholders(len(group)) + ")",
				Params: params,
			})
		}
	}

	stmts = append(stmts, Statement{
		SQL:    "INSERT OR IGNORE INTO keys (key, type) VALUES (?, 'hash')",
		Params: []any{key},
	})

	for _, group := range chunkStrings(fields, maxItemsPerStatement) {
		params := make([]any, 0, len(group)*3)
		tuples := make([]string, 0, len(group))
		for _, field := range group {
			params = append(params, key, field, pairs[field])
			tuples = append(tuples, "(?, ?, ?)")
		}
		stmts = append(stmts, Statement{
			SQL:    "INSERT INTO hashes (key, field, value) VALUES " + strings.Join(tuples, ", ") + " ON CONFLICT(key, field) DO UPDATE SET value = excluded.value",
			Params: params,
		})
	}

	fieldCount := int64(len(fields))

	return Translation{
		Statements: stmts,
		MapResult: func(results [][]map[string]any) (any, error) {
			if wrongTypeFor(results, 1, "hash") {
				return nil, ErrWrongType
			}
			var existing int64
			for _, index := range existingIndexes {
				rows := results[index]
				if len(rows) == 0 {
					continue
				}
				if value, ok := parseInt64(rowString(rows[0], "existing")); ok {
					existing += value
				}
			}
			return fieldCount - existing, nil
		},
	}, nil
}

func translateHDel(args []string) (Translation, error) {
	if len(args) < 2 {
		return Translation{}, errWrongArgs("hdel")
	}

	key := args[0]
	fields := uniqueStrings(args[1:])
	stmts := []Statement{
		deleteIfExpired(key),
		{
			SQL:    "SELECT type FROM keys WHERE key = ?",
			Params: []any{key},
		},
	}

	deleteIndexes := make([]int, 0, 1)
	for _, group := range chunkStrings(fields, maxItemsPerStatement) {
		params := make([]any, 0, len(group)+1)
		params = append(params, key)
		params = append(params, toAnySlice(group)...)
		deleteIndexes = append(deleteIndexes, len(stmts))
		stmts = append(stmts, Statement{
			SQL:    "DELETE FROM hashes WHERE key = ? AND field IN (" + placeholders(len(group)) + ") RETURNING field",
			Params: params,
		})
	}

	return Translation{
		Statements: stmts,
		MapResult: func(results [][]map[string]any) (any, error) {
			if wrongTypeFor(results, 1, "hash") {
				return nil, ErrWrongType
			}
			var count int64
			for _, index := range deleteIndexes {
				count += int64(len(results[index]))
			}
			return count, nil
		},
	}, nil
}

func translateHGetAll(args []string) (Translation, error) {
	if len(args) != 1 {
		return Translation{}, errWrongArgs("hgetall")
	}

	key := args[0]
	stmts := []Statement{
		{
			SQL:    "SELECT k.type AS type, h.field AS field, h.value AS value FROM keys k LEFT JOIN hashes h ON h.key = k.key WHERE " + liveKeyLookup + " ORDER BY h.field",
			Params: []any{key},
		},
	}

	return Translation{
		Statements: stmts,
		MapResult: func(results [][]map[string]any) (any, error) {
			rows := results[0]
			out := make([]any, 0, len(rows)*2)
			found, err := checkKeyType(rows, "hash")
			if err != nil {
				return nil, err
			}
			if !found {
				return out, nil
			}
			for _, row := range rows {
				field, ok := rowStringOrNull(row, "field")
				if !ok {
					continue
				}
				out = append(out, field, rowString(row, "value"))
			}
			return out, nil
		},
	}, nil
}

func translateHExists(args []string) (Translation, error) {
	if len(args) != 2 {
		return Translation{}, errWrongArgs("hexists")
	}

	key := args[0]
	field := args[1]
	stmts := []Statement{
		{
			SQL:    "SELECT k.type AS type, EXISTS (SELECT 1 FROM hashes h WHERE h.key = k.key AND h.field = ?) AS present FROM keys k WHERE " + liveKeyLookup,
			Params: []any{field, key},
		},
	}

	return Translation{
		Statements: stmts,
		MapResult: func(results [][]map[string]any) (any, error) {
			rows := results[0]
			found, err := checkKeyType(rows, "hash")
			if err != nil {
				return nil, err
			}
			if !found {
				return int64(0), nil
			}
			if rowTruthy(rows[0], "present") {
				return int64(1), nil
			}
			return int64(0), nil
		},
	}, nil
}

func translateHKeys(args []string) (Translation, error) {
	return translateHashColumn(args, "hkeys", "field")
}

func translateHVals(args []string) (Translation, error) {
	return translateHashColumn(args, "hvals", "value")
}

func translateHashColumn(args []string, cmd string, column string) (Translation, error) {
	if len(args) != 1 {
		return Translation{}, errWrongArgs(cmd)
	}

	key := args[0]
	stmts := []Statement{
		{
			SQL:    "SELECT k.type AS type, h." + column + " AS " + column + " FROM keys k LEFT JOIN hashes h ON h.key = k.key WHERE " + liveKeyLookup + " ORDER BY h.field",
			Params: []any{key},
		},
	}

	return Translation{
		Statements: stmts,
		MapResult: func(results [][]map[string]any) (any, error) {
			rows := results[0]
			out := make([]any, 0, len(rows))
			found, err := checkKeyType(rows, "hash")
			if err != nil {
				return nil, err
			}
			if !found {
				return out, nil
			}
			for _, row := range rows {
				value, ok := rowStringOrNull(row, column)
				if !ok {
					continue
				}
				out = append(out, value)
			}
			return out, nil
		},
	}, nil
}
