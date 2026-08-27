# Parser fixtures

Each Phase 2 language mode has a structural source fixture and a deterministic normalized
graph snapshot:

- TypeScript
- JavaScript
- TSX
- JSX
- Python

The structural snapshots cover modules, symbols, containment, exports, transient references,
evidence, confidence, signatures, and literal-value redaction. Phase 3 relationship fixtures add
exact call-graph snapshots for imports, calls, inheritance, implementations, general references,
and distance-scaled ambiguous candidates. Integration fixtures are additionally created as
temporary Git repositories so tests exercise tracked, untracked, modified, and deleted
working-tree state.
