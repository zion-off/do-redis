package translator

import (
	"fmt"
	"strings"
)

// maxItemsPerStatement caps how many keys/values are folded into one statement
// so bound parameter counts stay far below SQLite's limit.
const maxItemsPerStatement = 64

// liveKey matches rows in `keys` that have not expired yet.
const liveKey = "(expires_at IS NULL OR expires_at > unixepoch())"

// liveKeyLookup matches a single live key through the alias `k`.
const liveKeyLookup = "k.key = ? AND (k.expires_at IS NULL OR k.expires_at > unixepoch())"

// keyHasType returns an SQL predicate (one bound parameter: the key) that holds
// only while the key exists with the given type. Mutating child-table
// statements embed it so a wrong-typed key is left untouched even though the
// whole batch runs before MapResult reports WRONGTYPE.
func keyHasType(keyType string) string {
	return "EXISTS (SELECT 1 FROM keys WHERE key = ? AND type = '" + keyType + "')"
}

func wrongTypeFor(results [][]map[string]any, index int, expected string) bool {
	if index < 0 || index >= len(results) {
		return false
	}
	if len(results[index]) == 0 {
		return false
	}
	value, ok := results[index][0]["type"]
	if !ok || value == nil {
		return false
	}
	return strings.ToLower(fmt.Sprint(value)) != expected
}

// checkKeyType reports whether a combined key lookup found a live key, and
// returns ErrWrongType when the key holds another type.
func checkKeyType(rows []map[string]any, expected string) (bool, error) {
	if len(rows) == 0 {
		return false, nil
	}
	value, ok := rows[0]["type"]
	if !ok || value == nil {
		return false, nil
	}
	if strings.ToLower(fmt.Sprint(value)) != expected {
		return false, ErrWrongType
	}
	return true, nil
}

func placeholders(count int) string {
	if count <= 0 {
		return ""
	}
	return strings.TrimSuffix(strings.Repeat("?, ", count), ", ")
}

func chunkStrings(values []string, size int) [][]string {
	if len(values) <= size {
		return [][]string{values}
	}
	out := make([][]string, 0, (len(values)+size-1)/size)
	for i := 0; i < len(values); i += size {
		end := i + size
		if end > len(values) {
			end = len(values)
		}
		out = append(out, values[i:end])
	}
	return out
}

func uniqueStrings(values []string) []string {
	seen := make(map[string]struct{}, len(values))
	out := make([]string, 0, len(values))
	for _, value := range values {
		if _, ok := seen[value]; ok {
			continue
		}
		seen[value] = struct{}{}
		out = append(out, value)
	}
	return out
}

// rowStringOrNull reads a column that is NULL when a joined row is absent.
func rowStringOrNull(row map[string]any, key string) (string, bool) {
	value, ok := row[key]
	if !ok || value == nil {
		return "", false
	}
	return rowString(row, key), true
}

// rowTruthy reports whether a numeric projection is non-zero.
func rowTruthy(row map[string]any, key string) bool {
	value, ok := row[key]
	if !ok || value == nil {
		return false
	}
	switch v := value.(type) {
	case bool:
		return v
	case int64:
		return v != 0
	case int:
		return v != 0
	case float64:
		return v != 0
	default:
		parsed, ok := parseInt64(rowString(row, key))
		return ok && parsed != 0
	}
}

func toAnySlice(values []string) []any {
	out := make([]any, len(values))
	for i, value := range values {
		out[i] = value
	}
	return out
}
