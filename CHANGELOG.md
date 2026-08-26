# Changelog

All notable changes follow semantic versioning.

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

## 0.1.0 - 2026-08-26

### Added

- Phase 1 TypeScript CLI foundation.
- Git repository detection and canonical working-tree fingerprints.
- Local workspace, strict configuration, ignore rules, and secret-path protection.
- SQLite schema, WAL mode, migrations, FTS5, and transactional metadata indexing.
- Deterministic structural graph nodes/edges with provenance.
- Status, doctor, safe clean, unit tests, and Git-backed integration tests.
