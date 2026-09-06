# Indexed canonical queries

Canonical `find_symbol` requests retrieve candidates from the SQLite name, path, and FTS indexes, then apply the existing CodeAtlas ranker to generation-cached searchable text. The response reports the strategy and whether the candidate set was bounded:

```json
{
  "retrieval": {
    "strategy": "sqlite_fts_name_path+generation_projection",
    "indexed_candidates": 4,
    "projection_candidates": 6,
    "ranked_candidates": 6,
    "truncated": false
  }
}
```

Every canonical MCP response also separates the measured query phases:

```json
{
  "codeatlas": {
    "performance": {
      "timings_ms": {
        "freshness": 42.1,
        "retrieval": 1.8,
        "projection": 0.3,
        "serialization": 0.1,
        "transport": 0.01
      },
      "transport_scope": "response_construction"
    }
  }
}
```

`transport` measures response construction inside the MCP handler. Measure client and wire latency at the host when that distinction matters.

Fresh query rebuilds write their reusable IR to `.codeatlas/cache/query`. They do not rewrite the published HTML, Markdown, Mermaid, current snapshot, or snapshot history. Control-flow graphs outside the eager build budget are generated when a symbol is queried and then retained in the in-memory generation projection.

Full builds also report `artifact_estimate` in `.codeatlas/current/build.json` and the CLI summary. `estimated_single_file_bytes` is a conservative pre-export estimate based on the canonical IR, viewer projection, hub data, and static viewer assets; `embedded_source_bytes` shows how much of the canonical payload is source evidence. Use those values to decide when bundle output is more appropriate.

Run `npm run benchmark` to measure startup separately from warm canonical search and change-context compilation. The benchmark fails if indexed search changes the ordered top results for its exact-name, path, or task-vocabulary parity queries.
