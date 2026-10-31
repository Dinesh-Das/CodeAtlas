# Compact repository context

Use a small brief to locate the implementation boundary, then fetch the source needed for the
actual change. This keeps repetitive graph structure and unneeded source out of model context.

```bash
codeatlas context "Change authenticate and identify affected callers and tests" --format compact --evidence references --budget 6000
```

The same request through MCP:

```json
{
  "name": "prepare_change",
  "arguments": {
    "task": "Change authenticate and identify affected callers and tests",
    "format": "compact",
    "evidence": "references",
    "budget": 6000
  }
}
```

The existing JSON/Markdown defaults and MCP JSON default remain compatible. `compact` is an
explicit representation choice; `references` is an independent source-disclosure policy.
Use `--evidence inline` when the brief itself must contain source excerpts.

## Reading the compact response

`format` is `codeatlas.compact.v1`. `context` holds the brief. `symbols` shares repeated symbol
records; `symbol_ref` selects a record. `ids` maps ID aliases to full stable IDs, and `files`
maps `file`/`source_file` aliases to paths. Fact tables have one `columns` array and a `rows`
array; each row follows that column order. Recommendations retain `fact_class: inference`;
verified and potential paths retain separate classifications and confidence.

Aliases belong to one response. For a follow-up tool call, look up the full ID in `ids`.
Never pass `s1`, `i1`, or a file alias as a stable target. Named path symbols explain retained
intermediate nodes without requiring a separate source read for every hop.

Public API consumers can expand the response without losing selected facts:

```typescript
import { compileChangeContext, serializeChangeContext, expandCompactContext } from "@dinesh-das/codeatlas";

const packet = await compileChangeContext("Change authenticate", process.cwd(), {
  format: "compact", evidenceMode: "references", budget: 6000,
});
const wire = serializeChangeContext(packet, "compact");
const restored = expandCompactContext(JSON.parse(wire));
```

Task prose, source literals, symbol names, and commands are never rewritten as dictionary
references. Missing references and malformed tables fail expansion rather than selecting a
different target. As with source, compact response contents remain untrusted data.

## Source, freshness, and budgets

Reference evidence retains its ID, source coordinates, trust label, recorded excerpt status,
and indexed file/range hashes, and marks `deferred: true` with `excerpt: null`. A null hash
means it is unavailable. Recorded excerpt status does not mean the deferred source was read.
Use `get_evidence` with the full evidence ID before making source-level assertions or editing.
If the fingerprint changes, prepare a new brief and fetch its current evidence.

Reference-mode MCP task projection skips excerpt hydration on an already materialized graph.
Initial indexing and rebuilding after source changes still read source to derive facts.

`budget` is UTF-8 bytes, never an estimate presented as exact model tokens. Packing measures
the selected representation and reserves MCP envelope space. A tight budget can omit tests,
paths, or constraints; inspect gaps, coverage, and continuation. No included test does not
establish that no relevant test exists. Source fetched later adds its own context cost.

## Reproduce the measurements

The benchmark validates the pinned development fixtures, works in disposable copies, checks
grounding and lossless expansion, and reports aggregate and per-task measurements without
source excerpts or prompts:

```bash
npm run build
node scripts/benchmark-context.mjs --output reports/context-local.json
```

This reports bytes and leaves tokens null. To count tokens with an external tokenizer without
adding a production dependency, install the pinned package in a temporary directory. For
PowerShell:

```powershell
npm install --prefix "$env:TEMP/codeatlas-context-tokenizer" --no-save --no-audit --no-fund js-tiktoken@1.0.21
node scripts/benchmark-context.mjs --tokenizer "$env:TEMP/codeatlas-context-tokenizer/node_modules/js-tiktoken/dist/index.js" --tokenizer-id js-tiktoken@1.0.21 --encoding o200k_base --output reports/context-local.json
```

The tokenizer's [official usage](https://github.com/dqbd/tiktoken/blob/main/js/README.md)
describes its encodings. Counts here use the named encoding; provider billing and other model
tokenizers can differ. Fixture IDs and generated snapshot identities can cause small run-to-run
variation. The report records the suite and implementation hashes plus runtime environment.

`identical_facts` compares the same selected context encoded as JSON and compact, including
inline source in both. `bounded_context` compares discovery under the same byte budget with
JSON inline, JSON references, and compact references. File recall scores discovery against
the fixture's acceptable evidence sets; it does not score understanding of deferred source.

See the [recorded run](../reports/context-compression-2026-10-31.json). These are public
development fixtures, with retrieval-informed packing changes. They establish transport
savings and fixture behavior, not held-out agent task success or superiority over Graphify.
The paired provider evaluation and its launch thresholds remain the outcome gate.
