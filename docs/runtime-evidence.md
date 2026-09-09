# Runtime evidence

Static analysis cannot prove every reflective call, dependency-injection binding, generated
dispatch table, or plugin registration. CodeAtlas can merge observations from a trace, profile,
instrumented test, or runtime probe through a repository-local `codeatlas.runtime.json` file.

```json
{
  "version": 1,
  "relationships": [
    {
      "source": "CheckoutService.submit",
      "target": "PaymentHandler.handle",
      "type": "CALLS",
      "observation": "trace",
      "count": 42,
      "confidence": 1
    }
  ]
}
```

Selectors prefer an exact qualified name and fall back to a unique symbol name. CodeAtlas only
materializes a relationship when both selectors have one match. Ambiguous or missing selectors
remain visible as runtime-evidence configuration nodes and never become guessed edges.

Each materialized relationship cites the manifest line, uses `config` as its source type, and adds
`evidence_class: runtime_observation`, the observation method, count, and resolved qualified names.
Regenerate the file from the same deterministic instrumentation step used by the application or
test suite, and commit it only when repository policy permits runtime topology metadata.

Accepted observation methods are `instrumentation`, `trace`, `profile`, and `test`. Relationship
types use the canonical CodeAtlas edge vocabulary; structural ownership, exports, domains,
features, and rename history remain owned by their respective analyzers.
