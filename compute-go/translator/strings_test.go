package translator

import (
	"strconv"
	"strings"
	"testing"
)

func TestTranslateGetMissingKey(t *testing.T) {
	translation, err := Translate([]string{"GET", "missing"})
	if err != nil {
		t.Fatalf("Translate error: %v", err)
	}
	if len(translation.Statements) != 1 {
		t.Fatalf("expected 1 statement, got %d", len(translation.Statements))
	}
	results := make([][]map[string]any, 1)
	value, err := translation.MapResult(results)
	if err != nil {
		t.Fatalf("MapResult error: %v", err)
	}
	if value != nil {
		t.Fatalf("expected nil, got %v", value)
	}
}

func TestTranslateSetVariants(t *testing.T) {
	basic, err := Translate([]string{"SET", "k", "v"})
	if err != nil {
		t.Fatalf("Translate error: %v", err)
	}
	if len(basic.Statements) != 3 {
		t.Fatalf("expected 3 statements, got %d", len(basic.Statements))
	}
	results := make([][]map[string]any, 3)
	value, err := basic.MapResult(results)
	if err != nil {
		t.Fatalf("MapResult error: %v", err)
	}
	if value != "OK" {
		t.Fatalf("expected OK, got %v", value)
	}

	nx, err := Translate([]string{"SET", "k", "v", "NX"})
	if err != nil {
		t.Fatalf("Translate error: %v", err)
	}
	if len(nx.Statements) != 3 {
		t.Fatalf("expected 3 statements, got %d", len(nx.Statements))
	}
	results = make([][]map[string]any, 3)
	value, err = nx.MapResult(results)
	if err != nil {
		t.Fatalf("MapResult error: %v", err)
	}
	if value != nil {
		t.Fatalf("expected nil, got %v", value)
	}

	xx, err := Translate([]string{"SET", "k", "v", "XX"})
	if err != nil {
		t.Fatalf("Translate error: %v", err)
	}
	if len(xx.Statements) != 3 {
		t.Fatalf("expected 3 statements, got %d", len(xx.Statements))
	}
	results = make([][]map[string]any, 3)
	value, err = xx.MapResult(results)
	if err != nil {
		t.Fatalf("MapResult error: %v", err)
	}
	if value != nil {
		t.Fatalf("expected nil, got %v", value)
	}

	exp, err := Translate([]string{"SET", "k", "v", "EX", "10"})
	if err != nil {
		t.Fatalf("Translate error: %v", err)
	}
	var hasExpiry bool
	for _, stmt := range exp.Statements {
		if strings.Contains(stmt.SQL, "expires_at") {
			for _, param := range stmt.Params {
				if param != nil {
					hasExpiry = true
					break
				}
			}
		}
	}
	if !hasExpiry {
		t.Fatalf("expected expires_at param to be set")
	}
}

func TestTranslateIncrVariants(t *testing.T) {
	translation, err := Translate([]string{"INCR", "k"})
	if err != nil {
		t.Fatalf("Translate error: %v", err)
	}
	if len(translation.Statements) != 5 {
		t.Fatalf("expected 5 statements, got %d", len(translation.Statements))
	}
	results := make([][]map[string]any, 5)
	results[1] = []map[string]any{{"type": "string", "value": "0"}}
	results[4] = []map[string]any{{"value": "1"}}
	value, err := translation.MapResult(results)
	if err != nil {
		t.Fatalf("MapResult error: %v", err)
	}
	if value != int64(1) {
		t.Fatalf("expected 1, got %v", value)
	}

	incrBy, err := Translate([]string{"INCRBY", "k", "5"})
	if err != nil {
		t.Fatalf("Translate error: %v", err)
	}
	results = make([][]map[string]any, 5)
	results[1] = []map[string]any{{"type": "string", "value": "0"}}
	results[4] = []map[string]any{{"value": "5"}}
	value, err = incrBy.MapResult(results)
	if err != nil {
		t.Fatalf("MapResult error: %v", err)
	}
	if value != int64(5) {
		t.Fatalf("expected 5, got %v", value)
	}

	badResults := make([][]map[string]any, 5)
	_, err = translation.MapResult(badResults)
	if err != ErrNotInteger {
		t.Fatalf("expected ErrNotInteger, got %v", err)
	}
}

func TestTranslateStringErrors(t *testing.T) {
	if _, err := Translate([]string{"GET"}); err == nil {
		t.Fatalf("expected error for wrong args")
	}
	if _, err := Translate([]string{"SET", "k", "v", "NX", "XX"}); err == nil {
		t.Fatalf("expected error for NX+XX")
	}
	if _, err := Translate([]string{"NOPE"}); err == nil {
		t.Fatalf("expected error for unknown command")
	}
}

func TestTranslateVariadicBatching(t *testing.T) {
	del, err := Translate([]string{"DEL", "a", "a", "b"})
	if err != nil {
		t.Fatalf("Translate error: %v", err)
	}
	if len(del.Statements) != 1 {
		t.Fatalf("expected 1 statement, got %d", len(del.Statements))
	}
	value, err := del.MapResult([][]map[string]any{{{"live": int64(1)}, {"live": int64(0)}}})
	if err != nil {
		t.Fatalf("MapResult error: %v", err)
	}
	if value != int64(1) {
		t.Fatalf("expected 1, got %v", value)
	}

	exists, err := Translate([]string{"EXISTS", "a", "a", "b"})
	if err != nil {
		t.Fatalf("Translate error: %v", err)
	}
	value, err = exists.MapResult([][]map[string]any{{{"key": "a"}}})
	if err != nil {
		t.Fatalf("MapResult error: %v", err)
	}
	if value != int64(2) {
		t.Fatalf("expected 2, got %v", value)
	}

	mget, err := Translate([]string{"MGET", "a", "b", "a"})
	if err != nil {
		t.Fatalf("Translate error: %v", err)
	}
	value, err = mget.MapResult([][]map[string]any{{{"key": "a", "value": "1"}}})
	if err != nil {
		t.Fatalf("MapResult error: %v", err)
	}
	values, ok := value.([]any)
	if !ok || len(values) != 3 || values[0] != "1" || values[1] != nil || values[2] != "1" {
		t.Fatalf("unexpected MGET result: %v", value)
	}

	keys := make([]string, 0, 200)
	for i := 0; i < 200; i++ {
		keys = append(keys, "k"+strconv.Itoa(i))
	}
	large, err := Translate(append([]string{"MGET"}, keys...))
	if err != nil {
		t.Fatalf("Translate error: %v", err)
	}
	if len(large.Statements) != 4 {
		t.Fatalf("expected 4 chunked statements, got %d", len(large.Statements))
	}
}
