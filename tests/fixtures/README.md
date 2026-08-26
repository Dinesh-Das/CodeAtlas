# Parser fixtures

Each Phase 2 language mode has a structural source fixture and a deterministic normalized
graph snapshot:

- TypeScript
- JavaScript
- TSX
- JSX
- Python

The snapshots cover modules, symbols, containment, exports, unresolved imports, evidence,
confidence, signatures, and literal-value redaction. Integration fixtures are additionally
created as temporary Git repositories so tests exercise tracked, untracked, modified, and
deleted working-tree state.
