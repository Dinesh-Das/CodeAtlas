# Changelog

All notable changes follow semantic versioning.

## 0.3.0 - 2026-08-27

### Added

- Phase 3 import, call, inheritance, implementation, and general-reference resolution.
- Explicit unresolved and multi-candidate records without persisted module-specifier values.
- Import-graph-distance confidence scaling for ambiguous candidate edges.
- Official MCP SDK stdio server with all ten required tools and typed Answer Packets.
- Mandatory MCP freshness synchronization and configured traversal/result limits.
- Exact relationship snapshots and end-to-end stdio MCP contract tests.

### Changed

- The database schema is now version 2 and the index contract is `relationships-3`.
- CLI and MCP status treat schema/indexer version drift as out of date.

## 0.2.0 - 2026-08-26

### Added

- Phase 2 Tree-sitter structural indexing for TypeScript, JavaScript, TSX, JSX, and Python.
- Deterministic module, class, interface, function, method, and variable graph nodes.
- Provenance-bearing containment and export relationships.
- Normalized transient import/export references for Phase 3 resolution.
- Literal-redacted signatures and parser diagnostics.
- Per-language fixture repositories and exact normalized graph snapshots.

### Changed

- Initial and incremental indexing now writes AST entities transactionally.
- `status`, `doctor`, and CLI summaries report structural parser information.
- The runtime baseline now follows the specification's current-LTS target: Node.js 24.

## 0.1.0 - 2026-08-26

### Added

- Phase 1 TypeScript CLI foundation.
- Git repository detection and canonical working-tree fingerprints.
- Local workspace, strict configuration, ignore rules, and secret-path protection.
- SQLite schema, WAL mode, migrations, FTS5, and transactional metadata indexing.
- Deterministic structural graph nodes/edges with provenance.
- Status, doctor, safe clean, unit tests, and Git-backed integration tests.
