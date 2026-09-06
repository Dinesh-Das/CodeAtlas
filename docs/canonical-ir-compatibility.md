# Canonical IR compatibility

CodeAtlas IR `1.2` makes evidence scope, relationship uncertainty, and control-flow semantics explicit.

Evidence records retain `content_hash` for compatibility and add `file_content_hash`,
`range_content_hash`, and `excerpt_status`. Source coordinates use 1-based lines and 0-based
columns. A null range hash means the producer could not compute an exact byte-range digest; it
must not be interpreted as a file digest. Control-flow records declare `analysis_kind`,
`supported_constructs`, `unsupported_constructs`, and `truncated`.

Symbols and relationships retain the graph store's `provenance_category`. Relationships expose
`target_resolution` independently from `execution_semantics`, so an exactly resolved callback can
still be dynamic or conditional at runtime. `resolution_issues` preserves unresolved, ambiguous,
dynamic, generated-code, and unsupported-framework diagnostics with candidates and evidence.

Persistent `1.0` and `1.1` snapshots load through `loadCompatibleAtlasSnapshot`. The reader upgrades
them in memory to `1.2`, maps the old evidence `content_hash` to `file_content_hash`, leaves the unknown
range hash null, and labels pre-metadata CFGs `source_order_legacy` with
`legacy_control_flow_semantics` as an unsupported construct. It does not rewrite the stored
snapshot. Those older snapshots did not retain resolution issues or the graph store's provenance
category, so the compatibility reader cannot recreate missing diagnostics and uses conservative
derived defaults. Current `.codeatlas/current` artifacts are rebuilt when their active contract or
build metadata no longer matches.

Writers emit only `1.2`. New code should consume the scoped hash and excerpt-status fields and
must inspect `analysis_kind` before treating a control-flow diagram as a path claim.
