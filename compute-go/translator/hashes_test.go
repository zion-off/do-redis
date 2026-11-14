package translator

import "testing"

func TestTranslateHashes(t *testing.T) {
	hset, err := Translate([]string{"HSET", "k", "f", "v"})
	if err != nil {
		t.Fatalf("Translate error: %v", err)
	}
	if len(hset.Statements) != 4 {
		t.Fatalf("expected 4 statements, got %d", len(hset.Statements))
	}
	results := make([][]map[string]any, 4)
	value, err := hset.MapResult(results)
	if err != nil {
		t.Fatalf("MapResult error: %v", err)
	}
	if value != int64(1) {
		t.Fatalf("expected 1, got %v", value)
	}

	hget, err := Translate([]string{"HGET", "k", "f"})
	if err != nil {
		t.Fatalf("Translate error: %v", err)
	}
	if len(hget.Statements) != 1 {
		t.Fatalf("expected 1 statement, got %d", len(hget.Statements))
	}
	results = make([][]map[string]any, 1)
	value, err = hget.MapResult(results)
	if err != nil {
		t.Fatalf("MapResult error: %v", err)
	}
	if value != nil {
		t.Fatalf("expected nil, got %v", value)
	}

	hgetAll, err := Translate([]string{"HGETALL", "k"})
	if err != nil {
		t.Fatalf("Translate error: %v", err)
	}
	results = make([][]map[string]any, 1)
	results[0] = []map[string]any{
		{"type": "hash", "field": "a", "value": "1"},
		{"type": "hash", "field": "b", "value": "2"},
	}
	value, err = hgetAll.MapResult(results)
	if err != nil {
		t.Fatalf("MapResult error: %v", err)
	}
	list := value.([]any)
	if len(list) != 4 || list[0] != "a" || list[1] != "1" || list[2] != "b" || list[3] != "2" {
		t.Fatalf("unexpected HGETALL result: %v", list)
	}
}

func TestTranslateHSetCountsNewFields(t *testing.T) {
	hset, err := Translate([]string{"HSET", "k", "f", "1", "f", "2"})
	if err != nil {
		t.Fatalf("Translate error: %v", err)
	}
	last := hset.Statements[len(hset.Statements)-1]
	if len(last.Params) != 3 || last.Params[2] != "2" {
		t.Fatalf("expected the last value to win, got %v", last.Params)
	}
	results := make([][]map[string]any, len(hset.Statements))
	value, err := hset.MapResult(results)
	if err != nil {
		t.Fatalf("MapResult error: %v", err)
	}
	if value != int64(1) {
		t.Fatalf("expected 1, got %v", value)
	}

	results[1] = []map[string]any{{"type": "hash", "existing": int64(1)}}
	value, err = hset.MapResult(results)
	if err != nil {
		t.Fatalf("MapResult error: %v", err)
	}
	if value != int64(0) {
		t.Fatalf("expected 0, got %v", value)
	}
}
