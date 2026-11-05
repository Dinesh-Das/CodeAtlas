# Indexed search parity and timing

The first 10,000-line generated-repository benchmark failed its existing canonical ordering assertion. A smaller integration fixture reproduced it. The indexed path discarded evidence text during ranking and let FTS position change ties; token-only retrieval also omitted substring/camel-case matches accepted by the canonical ranker.

The repair retains the precomputed enriched search text, adds bounded substring candidates with parameterized SQLite `instr`, and applies the shared lexical ranker and symbol-ID tie ordering. The regression fixture covers exact names, paths, multi-term queries and an interior substring. No benchmark assertion was removed or relaxed.

All 233 tests pass. The repeated smoke benchmark reports identical result ordering for its three comparison queries. Cold indexing: 1,078.1 ms. Warm canonical search: p50 144.75 ms, p95 151.80 ms. Phase p95 is dominated by freshness (143.63 ms), with retrieval 7 ms and projection 0.4 ms. This locates a future performance investigation; it does not establish a speedup from this repair.

The generated fixture includes comment filler and is not a representative 10,000-line application. Candidate hydration is capped at 10,000 and truncation is reported. Substring compatibility scans stored text; large-repository cost needs separate measurement. This report contains no provider calls or agent task-success measurements.

SQLite semantics: [instr](https://www.sqlite.org/lang_corefunc.html#instr) and [FTS5 token queries](https://www.sqlite.org/fts5.html#full_text_query_syntax).
