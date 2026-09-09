# Adapter contribution kit

Framework adapters implement `FrameworkAdapter` from `src/framework/types.ts` and register through
the public `registerFrameworkAdapter` API. Keep detection cheap, make `supports` path/language
specific, and emit source evidence for every node and edge. Dynamic registrations must remain
dynamic or unresolved; do not upgrade them to verified edges from naming similarity.

Start by copying `examples/adapter-kit`. Add a minimal positive fixture, a near-match negative
fixture, and the expected `source/type/target` edge set. Export the actual edge set after running a
full build, then execute:

```bash
npm run adapter:check
```

The example gate requires precision >= 0.95 and recall >= 0.90. Real adapters should split metrics
by supported edge type and include contract edges separately.

The runtime also enforces the adapter graph contract per file. Node and edge IDs must be unique,
types and provenance values must be canonical, confidence must stay within 0-1, and every fact must
carry a positive evidence line owned by the file being analyzed. A contract violation isolates that
adapter for the file, records a warning, and retains the generic language graph.

A pull request should contain:

- an adapter name and pinned parser/framework versions;
- positive, negative, aliased-import, composed-registration, and dynamic-registration fixtures;
- independently reviewed expected nodes and edges;
- precision and recall output for each promised edge type;
- source-private assertions for route, channel, host, and schema literals;
- incremental-index behavior and failure-isolation coverage;
- documentation and a compatibility-matrix update.

Starter work is tracked through the “Adapter starter” issue form. Choose one narrow syntax pattern
per issue so reviewers can validate the evidence contract before broadening coverage.
