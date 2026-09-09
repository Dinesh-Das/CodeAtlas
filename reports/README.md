# Reproducible reports

CodeAtlas reports are generated locally and are opt-in: the CLI never uploads telemetry, source,
prompts, or report files. Create a shareable JSON report for a public, pinned checkout with:

```bash
codeatlas build . --full
codeatlas report . --output reports/local-proof.json --include-repository-url
```

The report includes the package version, commit, dirty state, fingerprint, operating system, Node
version, index counts and bytes, observed graph-fact distribution, standard local search latency,
observed RSS, privacy schema checks, and a reproducibility hash. Fixed search terms are represented
by a suite ID and hash; user prompt text and result names are omitted.

Ground-truth accuracy comes from the checked-in evaluation suites and adapter fixtures. Run
`npm run eval:report`, `npm run adapter:check`, and `npm run validate:repository` for a pinned public
checkout. `release-evidence.json` is the stable-release manifest for independent repositories and
the large-repository benchmark. A local proof report must not be described as precision/recall;
its `graph_quality` block explicitly identifies itself as an observed fact distribution.

Monthly dogfood notes belong in `reports/monthly/YYYY-MM.md`. Link immutable manifests, identify
the exact CodeAtlas version, include failures, and separate current-release proof from older
prerelease evidence.
