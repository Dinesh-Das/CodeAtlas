# Contributing

CodeAtlas follows the implementation phases in the requirements documents. Preserve the core
contract: deterministic analysis before heuristics, provenance on every graph fact, current
working-tree evidence, no secret values, and strict Parser/Graph/Storage/Git/MCP/CLI boundaries.

Before submitting a change:

```bash
npm ci
npm run check
```

For changes that affect the CLI, packaging, dependencies, documentation, or release metadata,
also run:

```bash
npm run package:smoke
```

This validates the exact npm tarball by installing it into a disposable repository. Do not commit
generated `dist/`, coverage, package tarballs, or `.codeatlas/` state.

Add unit tests for local algorithms and integration tests for repository-to-graph behavior.
Parser adapters require fixture repositories and expected graph snapshots. Do not introduce an
LLM call to derive a relationship that can be obtained from syntax, Git, configuration, schema,
or framework conventions.

Keep `package.json`, `package-lock.json`, `src/version.ts`, and the changelog version aligned.
Release maintainers should follow [RELEASING.md](RELEASING.md); normal contributions must not
publish packages or create release tags.
