package translator

import "path"

// literalPrefix returns the longest literal prefix of a glob pattern, limited
// to printable ASCII so the derived key range is safe under BINARY collation.
func literalPrefix(pattern string) string {
	var prefix []byte
	for i := 0; i < len(pattern); i++ {
		ch := pattern[i]
		if ch == '*' || ch == '?' || ch == '[' {
			break
		}
		if ch == '\\' {
			if i+1 >= len(pattern) {
				return ""
			}
			ch = pattern[i+1]
			i++
		}
		if ch < 0x20 || ch >= 0x7e {
			break
		}
		prefix = append(prefix, ch)
	}
	return string(prefix)
}

func translatePing(args []string) (Translation, error) {
	if len(args) > 1 {
		return Translation{}, errWrongArgs("ping")
	}

	message := "PONG"
	if len(args) == 1 {
		message = args[0]
	}

	return Translation{
		Statements: nil,
		MapResult: func(results [][]map[string]any) (any, error) {
			return message, nil
		},
	}, nil
}

func translateDBSize(args []string) (Translation, error) {
	if len(args) != 0 {
		return Translation{}, errWrongArgs("dbsize")
	}

	stmts := []Statement{
		{
			SQL: "SELECT COUNT(*) as count FROM keys WHERE (expires_at IS NULL OR expires_at > unixepoch())",
		},
	}

	return Translation{
		Statements: stmts,
		MapResult: func(results [][]map[string]any) (any, error) {
			if len(results[0]) == 0 {
				return int64(0), nil
			}
			count, ok := parseInt64(rowString(results[0][0], "count"))
			if !ok {
				return nil, ErrNotInteger
			}
			return count, nil
		},
	}, nil
}

func translateFlushDB(args []string) (Translation, error) {
	if len(args) != 0 {
		return Translation{}, errWrongArgs("flushdb")
	}

	stmts := []Statement{
		{
			SQL: "DELETE FROM keys",
		},
	}

	return Translation{
		Statements: stmts,
		MapResult: func(results [][]map[string]any) (any, error) {
			return "OK", nil
		},
	}, nil
}

func translateKeys(args []string) (Translation, error) {
	if len(args) != 1 {
		return Translation{}, errWrongArgs("keys")
	}
	pattern := args[0]
	if pattern == "" {
		return Translation{}, errWrongArgs("keys")
	}

	// Any key matching the pattern has to start with its literal prefix, so the
	// scan can be narrowed to a primary key range instead of reading every key.
	sqlText := "SELECT key FROM keys WHERE " + liveKey + " ORDER BY key"
	var params []any
	if prefix := literalPrefix(pattern); prefix != "" {
		upper := prefix[:len(prefix)-1] + string(prefix[len(prefix)-1]+1)
		sqlText = "SELECT key FROM keys WHERE key >= ? AND key < ? AND " + liveKey + " ORDER BY key"
		params = []any{prefix, upper}
	}

	stmts := []Statement{
		{
			SQL:    sqlText,
			Params: params,
		},
	}

	return Translation{
		Statements: stmts,
		MapResult: func(results [][]map[string]any) (any, error) {
			out := make([]any, 0, len(results[0]))
			for _, row := range results[0] {
				key := rowString(row, "key")
				match, err := path.Match(pattern, key)
				if err != nil {
					return nil, err
				}
				if match {
					out = append(out, key)
				}
			}
			return out, nil
		},
	}, nil
}
