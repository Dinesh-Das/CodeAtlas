# Contributing

Thank you for helping make CodeAtlas more trustworthy. Please follow the
[Code of Conduct](CODE_OF_CONDUCT.md), check the [roadmap](ROADMAP.md), and use the focused issue
forms for incorrect edges, missing framework coverage, or performance regressions.

Preserve the core contract: deterministic analysis before heuristics, provenance on every graph
fact, current-working-tree evidence, no secret values, and strict
Parser/Graph/Storage/Git/MCP/CLI boundaries.

Before submitting a change:

```bash
npm ci
npm run check
```

The test suite caps Vitest at two file workers because compiler-backed integration fixtures are
CPU- and memory-heavy on shared Windows runners. Do not remove that cap or compensate for resource
contention with CI retries. An explicit `codeatlas index` is authoritative: it hashes current
content and does not rely on the short-lived filesystem-watcher status cache.

For changes that affect the CLI, packaging, dependencies, documentation, or release metadata,
also run:

```bash
npm run package:smoke
```

This validates the exact npm tarball by installing it into a disposable repository. Do not commit
generated `dist/`, coverage, package tarballs, or `.codeatlas/` state.

CI runs type checking, linting, and tests as separately named steps on Ubuntu, macOS, and Windows
with the minimum supported Node.js 22.12 and current Node.js 24. This makes the failing phase visible
without expanding permissions or rerunning flaky jobs. Run `npm run stable:check` when changing the
publish manifest or stable release evidence.

Add unit tests for local algorithms and integration tests for repository-to-graph behavior.
Parser adapters require fixture repositories and expected graph snapshots. Do not introduce an
LLM call to derive a relationship that can be obtained from syntax, Git, configuration, schema,
or framework conventions.

For an incorrect or missing relationship, include the smallest public reproduction you can and
assert its edge type, target, confidence, provenance, evidence location, and conditional state.

Keep `package.json`, `package-lock.json`, `src/version.ts`, and the changelog version aligned.
Release maintainers should follow [RELEASING.md](RELEASING.md); normal contributions must not
publish packages or create release tags.
