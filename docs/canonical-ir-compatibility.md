# Canonical IR compatibility

CodeAtlas IR `1.1` makes evidence scope and control-flow semantics explicit.

Evidence records retain `content_hash` for compatibility and add `file_content_hash`,
`range_content_hash`, and `excerpt_status`. Source coordinates use 1-based lines and 0-based
columns. A null range hash means the producer could not compute an exact byte-range digest; it
must not be interpreted as a file digest. Control-flow records declare `analysis_kind`,
`supported_constructs`, `unsupported_constructs`, and `truncated`.

Persistent `1.0` snapshots load through `loadCompatibleAtlasSnapshot`. The reader upgrades them
in memory to `1.1`, maps the old evidence `content_hash` to `file_content_hash`, leaves the unknown
range hash null, and labels their CFGs `source_order_legacy` with
`legacy_control_flow_semantics` as an unsupported construct. It does not rewrite the stored
snapshot. Current `.codeatlas/current` artifacts are rebuilt when their active contract or build
metadata no longer matches.

Writers emit only `1.1`. New code should consume the scoped hash and excerpt-status fields and
must inspect `analysis_kind` before treating a control-flow diagram as a path claim.
