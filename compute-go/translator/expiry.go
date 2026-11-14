package translator

import (
	"strings"
	"time"
)

func translateExpire(args []string) (Translation, error) {
	return translateExpireWith(args, "expire", false)
}

func translateExpireAt(args []string) (Translation, error) {
	return translateExpireWith(args, "expireat", true)
}

func translateExpireWith(args []string, cmd string, absolute bool) (Translation, error) {
	if len(args) < 2 || len(args) > 3 {
		return Translation{}, errWrongArgs(cmd)
	}

	key := args[0]
	value, ok := parseInt64(args[1])
	if !ok {
		return Translation{}, ErrNotInteger
	}

	var expiresAt int64
	if absolute {
		expiresAt = value
	} else {
		expiresAt = time.Now().Unix() + value
	}

	option := ""
	if len(args) == 3 {
		option = strings.ToUpper(args[2])
	}

	updateSQL := "UPDATE keys SET expires_at = ? WHERE key = ? RETURNING key"
	params := []any{expiresAt, key}

	switch option {
	case "":
		// default
	case "NX":
		updateSQL = "UPDATE keys SET expires_at = ? WHERE key = ? AND expires_at IS NULL RETURNING key"
	case "XX":
		updateSQL = "UPDATE keys SET expires_at = ? WHERE key = ? AND expires_at IS NOT NULL RETURNING key"
	case "GT":
		updateSQL = "UPDATE keys SET expires_at = ? WHERE key = ? AND (expires_at IS NULL OR expires_at < ?) RETURNING key"
		params = []any{expiresAt, key, expiresAt}
	case "LT":
		updateSQL = "UPDATE keys SET expires_at = ? WHERE key = ? AND expires_at IS NOT NULL AND expires_at > ? RETURNING key"
		params = []any{expiresAt, key, expiresAt}
	default:
		return Translation{}, errWrongArgs(cmd)
	}

	// A missing key and an unmet condition both reply 0, so no separate
	// existence probe is needed: the UPDATE returns no rows in either case.
	stmts := []Statement{
		deleteIfExpired(key),
		{
			SQL:    updateSQL,
			Params: params,
		},
	}

	return Translation{
		Statements: stmts,
		MapResult: func(results [][]map[string]any) (any, error) {
			if len(results[1]) == 0 {
				return int64(0), nil
			}
			return int64(1), nil
		},
	}, nil
}

func translateTTL(args []string) (Translation, error) {
	return translateTTLWith(args, "ttl", false)
}

func translatePTTL(args []string) (Translation, error) {
	return translateTTLWith(args, "pttl", true)
}

func translateTTLWith(args []string, cmd string, millis bool) (Translation, error) {
	if len(args) != 1 {
		return Translation{}, errWrongArgs(cmd)
	}

	key := args[0]
	stmts := []Statement{
		{
			SQL:    "SELECT expires_at, unixepoch() AS now FROM keys WHERE key = ? AND " + liveKey,
			Params: []any{key},
		},
	}

	return Translation{
		Statements: stmts,
		MapResult: func(results [][]map[string]any) (any, error) {
			if len(results[0]) == 0 {
				return int64(-2), nil
			}
			row := results[0][0]
			expiresValue, ok := row["expires_at"]
			if !ok || expiresValue == nil {
				return int64(-1), nil
			}
			expiresAt, ok := parseInt64(rowString(row, "expires_at"))
			if !ok {
				return nil, ErrNotInteger
			}
			now, ok := parseInt64(rowString(row, "now"))
			if !ok {
				return nil, ErrNotInteger
			}
			ttl := expiresAt - now
			if millis {
				return ttl * 1000, nil
			}
			return ttl, nil
		},
	}, nil
}

func translatePersist(args []string) (Translation, error) {
	if len(args) != 1 {
		return Translation{}, errWrongArgs("persist")
	}

	key := args[0]
	stmts := []Statement{
		deleteIfExpired(key),
		{
			SQL:    "UPDATE keys SET expires_at = NULL WHERE key = ? AND expires_at IS NOT NULL RETURNING key",
			Params: []any{key},
		},
	}

	return Translation{
		Statements: stmts,
		MapResult: func(results [][]map[string]any) (any, error) {
			if len(results[1]) == 0 {
				return int64(0), nil
			}
			return int64(1), nil
		},
	}, nil
}
