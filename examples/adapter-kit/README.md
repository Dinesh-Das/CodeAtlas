# Framework adapter fixture kit

Copy this directory for one unsupported framework pattern. Keep the source fixture minimal and
free of credentials. Record every relationship that the adapter should emit in `expected.json`,
then export the adapter's observed relationships into `actual.json`.

Run the independent set comparison:

```bash
node scripts/validate-adapter-fixture.mjs expected.json actual.json
```

The gate keys relationships by `source`, `type`, and `target`, reports precision and recall
separately, and exits nonzero below the declared thresholds. A contribution should also include a
negative fixture so a broad regex cannot pass by emitting extra edges. See
`docs/adapter-kit.md` for the adapter contract and pull-request checklist.
