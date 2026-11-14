package translator

import "strings"

func translateSAdd(args []string) (Translation, error) {
	if len(args) < 2 {
		return Translation{}, errWrongArgs("sadd")
	}

	key := args[0]
	members := uniqueStrings(args[1:])
	stmts := []Statement{
		deleteIfExpired(key),
		{
			SQL:    "SELECT type FROM keys WHERE key = ?",
			Params: []any{key},
		},
		{
			SQL:    "INSERT OR IGNORE INTO keys (key, type) VALUES (?, 'set')",
			Params: []any{key},
		},
	}

	insertIndexes := make([]int, 0, 1)
	for _, group := range chunkStrings(members, maxItemsPerStatement) {
		params := make([]any, 0, len(group)*2)
		tuples := make([]string, 0, len(group))
		for _, member := range group {
			params = append(params, key, member)
			tuples = append(tuples, "(?, ?)")
		}
		insertIndexes = append(insertIndexes, len(stmts))
		stmts = append(stmts, Statement{
			SQL:    "INSERT OR IGNORE INTO sets (key, member) VALUES " + strings.Join(tuples, ", ") + " RETURNING member",
			Params: params,
		})
	}

	return Translation{
		Statements: stmts,
		MapResult: func(results [][]map[string]any) (any, error) {
			if wrongTypeFor(results, 1, "set") {
				return nil, ErrWrongType
			}
			var count int64
			for _, index := range insertIndexes {
				count += int64(len(results[index]))
			}
			return count, nil
		},
	}, nil
}

func translateSRem(args []string) (Translation, error) {
	if len(args) < 2 {
		return Translation{}, errWrongArgs("srem")
	}

	key := args[0]
	members := uniqueStrings(args[1:])
	stmts := []Statement{
		deleteIfExpired(key),
		{
			SQL:    "SELECT type FROM keys WHERE key = ?",
			Params: []any{key},
		},
	}

	deleteIndexes := make([]int, 0, 1)
	for _, group := range chunkStrings(members, maxItemsPerStatement) {
		params := make([]any, 0, len(group)+1)
		params = append(params, key)
		params = append(params, toAnySlice(group)...)
		deleteIndexes = append(deleteIndexes, len(stmts))
		stmts = append(stmts, Statement{
			SQL:    "DELETE FROM sets WHERE key = ? AND member IN (" + placeholders(len(group)) + ") RETURNING member",
			Params: params,
		})
	}

	stmts = append(stmts, Statement{
		SQL:    "DELETE FROM keys WHERE key = ? AND NOT EXISTS (SELECT 1 FROM sets WHERE key = ?)",
		Params: []any{key, key},
	})

	return Translation{
		Statements: stmts,
		MapResult: func(results [][]map[string]any) (any, error) {
			if wrongTypeFor(results, 1, "set") {
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

func translateSMembers(args []string) (Translation, error) {
	if len(args) != 1 {
		return Translation{}, errWrongArgs("smembers")
	}

	key := args[0]
	stmts := []Statement{
		{
			SQL:    "SELECT k.type AS type, s.member AS member FROM keys k LEFT JOIN sets s ON s.key = k.key WHERE " + liveKeyLookup + " ORDER BY s.member",
			Params: []any{key},
		},
	}

	return Translation{
		Statements: stmts,
		MapResult: func(results [][]map[string]any) (any, error) {
			rows := results[0]
			out := make([]any, 0, len(rows))
			found, err := checkKeyType(rows, "set")
			if err != nil {
				return nil, err
			}
			if !found {
				return out, nil
			}
			for _, row := range rows {
				member, ok := rowStringOrNull(row, "member")
				if !ok {
					continue
				}
				out = append(out, member)
			}
			return out, nil
		},
	}, nil
}

func translateSIsMember(args []string) (Translation, error) {
	if len(args) != 2 {
		return Translation{}, errWrongArgs("sismember")
	}

	key := args[0]
	member := args[1]
	stmts := []Statement{
		{
			SQL:    "SELECT k.type AS type, EXISTS (SELECT 1 FROM sets s WHERE s.key = k.key AND s.member = ?) AS present FROM keys k WHERE " + liveKeyLookup,
			Params: []any{member, key},
		},
	}

	return Translation{
		Statements: stmts,
		MapResult: func(results [][]map[string]any) (any, error) {
			rows := results[0]
			found, err := checkKeyType(rows, "set")
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

func translateSCard(args []string) (Translation, error) {
	if len(args) != 1 {
		return Translation{}, errWrongArgs("scard")
	}

	key := args[0]
	stmts := []Statement{
		{
			SQL:    "SELECT k.type AS type, (SELECT COUNT(*) FROM sets s WHERE s.key = k.key) AS count FROM keys k WHERE " + liveKeyLookup,
			Params: []any{key},
		},
	}

	return Translation{
		Statements: stmts,
		MapResult: func(results [][]map[string]any) (any, error) {
			rows := results[0]
			found, err := checkKeyType(rows, "set")
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
