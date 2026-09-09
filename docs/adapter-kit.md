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
by supported edge type and include contract edges separately. A pull request should contain:

- an adapter name and pinned parser/framework versions;
- positive, negative, aliased-import, composed-registration, and dynamic-registration fixtures;
- independently reviewed expected nodes and edges;
- precision and recall output for each promised edge type;
- source-private assertions for route, channel, host, and schema literals;
- incremental-index behavior and failure-isolation coverage;
- documentation and a compatibility-matrix update.

Starter work is tracked through the “Adapter starter” issue form. Choose one narrow syntax pattern
per issue so reviewers can validate the evidence contract before broadening coverage.
