# CodeAtlas agent knowledge audit

Date: 2026-09-10 · Version: 0.11.0-beta.1 · Audited commit: `09fb4c5`

CodeAtlas has a substantial foundation for agent codebase knowledge: local indexing, a canonical graph, stable IDs, explicit uncertainty, working-tree freshness, bounded MCP responses, and a shared CLI/API. Its main constraint at the audited commit was the reliability of the context it selected. The audited implementation could return irrelevant starting points, omit useful tests, and lose the connection between a claim and its evidence despite passing the software checks.

Make task-specific context the primary product: an agent describes a change and receives the right entrypoints, edit locations, dependencies, contracts, project decisions, tests, and expandable evidence. Aim for agents to read only the source they need to verify and edit. A graph cannot replace inspecting the actual implementation before a consequential change.

The original audit changed no application source. The working tree now includes the remediation described below. Findings retain the original observations, code inspection, and proposed acceptance targets.

## Remediation status — 2026-09-11

- **F1 fixed:** exact stable IDs, names, qualified names, and paths now outrank enriched lexical
  candidates. The SDK-level regression requires `runCheckout` to rank first.
- **F2 fixed:** overlapping evidence ranges retain separate IDs, and grounding validation requires
  evidence to cover an edit location's complete file and line range.
- **F3 fixed for the default agent path:** preparation, evidence lookup, trace, symbol context,
  repository overview, execution tours, and current changes use bounded SQLite projections and
  hydrate only selected evidence. In-flight file reads are shared. Canonical responses expose
  query counts, rows, bytes, timings, and RSS. A synchronized SDK preparation measured about 0.59
  seconds and 174 MiB RSS on the audit machine; cold index reconciliation remains a separate cost.
- **F4 fixed:** task classification resolves documentation and bare root files, prioritizes explicit
  anchors and architectural entrypoints, and reserves the default packet for an edit location plus
  a validation command or explicit `validation_unavailable` gap. The reproduced MCP task now starts
  at `createCodeAtlasServer` in `src/mcp/server.ts` and includes the repository test, typecheck, and
  lint commands within 6,000 bytes.
- **F5 fixed:** test selection uses canonical scope, excludes fixtures, prefers graph-backed test
  paths, and labels direct, impacted, and task-text matches separately.
- **F6 fixed:** configured canonical names influence retrieval, while matching owners, human
  invariants, applicable architecture rules, and owner validation commands appear in change briefs
  with provenance.
- **F7 fixed:** continuations use the four default tools, candidates link to symbol resources, the
  review prompt reads `codeatlas://change/current`, and fingerprinted change resources enforce
  freshness with a typed `stale_resource` result. SDK tests execute these navigation paths.
- **F8 partially addressed:** the reproduced failures are now retrieval and default-MCP regressions.
  A live held-out paired provider experiment with executable patch validation is still required
  before claiming that CodeAtlas improves agent task outcomes.

## What was verified

- Read the indexer, retrieval, context compiler, knowledge catalog, MCP, evidence, evaluation, and relevant test implementations.
- Ran `npm run check`: type checking, lint, **194 tests in 46 files**, fixture hashes/schema checks for 30 tasks across six repositories, and provider-harness dry-run validation all passed.
- Ran `npm run package:smoke`: packed and installed the tarball in a disposable repository; CLI initialization, status, overview, ask, setup, and report checks passed. First architecture answer: 27.5 seconds in that smoke fixture.
- Queried CodeAtlas against its own repository through internal handlers and through an MCP SDK client connected to the default server with an in-memory transport.
- Reproduced an evidence-compaction failure directly against the compiled budgeter.
- Compared the current code with the September 6 audit. Compact tools/resources/prompts, SQLite search, and knowledge artifacts now exist; recommending their creation again would miss the remaining integration problems.

The self-index reported 307 files, 8,926 symbols, 37,060 relationships, and 70,438 evidence records. This is one Windows/Node 24.12 machine and one repository. It is a useful functional reproduction, not a cross-platform performance or comparative agent benchmark. Viewer interaction, every language adapter, security penetration testing, and live editor-host compatibility were outside this pass.

## Observed agent experience

| Request | Observed result |
|---|---|
| MCP `search`, query `findSymbolIr` | The exact function ranked **14th**. The first five results were unrelated variables: `matches`, `response`, `canonicalStartup`, `canonical`, and `actual`. |
| MCP `prepare_change`, default 6,000-byte budget, task “Add a new MCP query that explains how indexed retrieval becomes evidence-backed output” | One candidate: `formatIndexResult` in `src/cli/index-command.ts`. Two edit locations, but no relevant tests, verified paths, contracts, or validation commands. |
| Same task at 12,000 bytes | Four candidates, including query storage and response serialization, one test, and two paths. The first candidate remained the CLI formatter; the brief did not identify `createCodeAtlasServer` as a candidate. |
| Same task at 3,000 bytes | Recoverable `budget_too_small` error before a useful packet could fit. |
| “Change findSymbolIr retrieval behavior”, 12,000 bytes | Correct first candidate, but the sole selected test was fixture function `findUserRepository` in `tests/fixtures/v2-architecture/src/auth/repository.ts`. |
| “Document the prepare_change workflow in README.md”, 12,000 bytes | Candidates named `document` in the AsyncAPI and OpenAPI adapters; selected “test” was `tests/fixtures/README.md`. |
| Local `ask`: “How does an MCP find_symbol request become an evidence-backed response?” | Abstained with “CodeAtlas does not have enough source evidence to answer this question.” |
| Follow the context continuation by calling `get_symbol` | Default MCP server returned `Tool get_symbol not found`. |
| Follow the `review_diff` prompt's `codeatlas://change` URI | Resource not found. |

In a fresh process against the synchronized index, the SDK search took **269 ms**, with process RSS about **117 MiB**. The following default preparation took **15.5 s**, with RSS about **1,027 MiB**. Subsequent direct context calls in a previously loaded process took approximately 0.6–1.2 s for the tested supported requests. These are individual timings, not percentiles. An earlier search required reconciliation and ran concurrently with tests, so its 53-second result is excluded from the clean latency comparison.

## Findings, ordered by impact

### F1 · P1 · Search scoring puts weak matches ahead of exact definitions

[src/mcp/ir-tools.ts:385](D:/MyProjects/CodeAtlas/src/mcp/ir-tools.ts:385) uses:

```ts
rankSymbolSearch(symbol, query) || Math.max(1, 10_000 - indexedPosition)
```

A candidate with zero symbol-text relevance receives a fallback score near 10,000. An exact-name match receives approximately 1,000 plus small bonuses in [src/analysis/simplification.ts:297](D:/MyProjects/CodeAtlas/src/analysis/simplification.ts:297). Enriched FTS finds references in source, but the later ranker scores a different representation and promotes some zero-score results above definitions. The exact-query reproduction demonstrates the effect.

**Change:** use ordered match classes: exact stable ID, exact qualified/name match, path, then lexical/semantic candidates. Preserve retrieval provenance and use compatible score scales or rank fusion within each class. Suppress fixture/local-variable distractors by default while retaining explicit access.

**Acceptance:** unique exact identifiers rank first even with thousands of references, comments, fixtures, and same-token variables. Test the default SDK `search`, not only storage search helpers.

### F2 · P1 · Evidence deduplication can discard the proof a claim needs

[src/context/budgeter.ts:47](D:/MyProjects/CodeAtlas/src/context/budgeter.ts:47) treats any overlapping line ranges in the same file as interchangeable. `canonicalizeEvidence` rewrites evidence IDs to the first overlapping record. It does not require equal ranges, full containment, matching columns, or matching claim ownership.

Reproduction: two edit locations cover lines **1–10** and **9–20**, backed by separate evidence IDs. The budgeter emits only the 1–10 record and rewrites both edits to reference it. [validateChangeContextGrounding](D:/MyProjects/CodeAtlas/src/context/packet.ts:279) returns no errors because it checks evidence presence rather than whether the retained evidence supports the claim.

**Change:** retain logical evidence IDs and deduplicate excerpt payloads separately. If ranges are coalesced, preserve the union, individual claim mappings, file/range hashes, and excerpt truncation boundaries. Validate claim-to-evidence compatibility after budgeting.

**Acceptance:** overlapping functions, nested symbols, two calls on one line, and partially available excerpts retain distinct proof. A record covering only 1–10 cannot satisfy a claim requiring 9–20.

### F3 · P1 · Small responses still require repository-wide loading

Search uses `ArchitectureService.loadQuery`, which is a real improvement. However, preparation, evidence, trace, and overview use [loadIrRuntime](D:/MyProjects/CodeAtlas/src/mcp/ir-tools.ts:96), which calls the full architecture service.

[readAtlasRuntime](D:/MyProjects/CodeAtlas/src/storage/atlas-cache.ts:130) loads every section. [readBuiltAtlas](D:/MyProjects/CodeAtlas/src/service/architecture-service.ts:182) then runs `Promise.all` over every evidence record to hydrate source excerpts. The first preparation after the fast SDK search took 15.5 seconds and raised RSS to roughly 1 GiB on this repository.

[EvidenceExcerptReader](D:/MyProjects/CodeAtlas/src/ir/evidence.ts:47) also caches completed file reads rather than pending promises. Concurrent evidence requests for one file can all observe a cache miss and duplicate the same file read. This mechanism is visible in code; the number of duplicate reads was not instrumented in this audit.

**Change:** resolve anchors, retrieve bounded graph neighborhoods, rank, allocate the response budget, then hydrate only selected evidence. Add indexed adjacency/evidence/knowledge queries and lazy flow/impact expansion. Cache in-flight file reads and cap I/O concurrency. Keep full exports as an explicit build capability.

**Acceptance:** instrument rows, bytes, files opened, source bytes, RSS, and cold/warm latency per operation. Unrelated graph growth should not force evidence reads across the repository for one-symbol evidence requests. As initial targets to validate on declared hardware: warm search p95 below 300 ms and indexed preparation p95 below 2 s.

### F4 · P1 · Context selection does not reliably cover the requested task

The planner combines broad vocabulary, role bonuses, FTS position, and file diversification, then greedily budgets collections. The reproduced default brief is source-backed but starts at a CLI formatting helper. [src/context/budgeter.ts:181](D:/MyProjects/CodeAtlas/src/context/budgeter.ts:181) prioritizes one candidate and two edit locations without ensuring that the retained packet contains a useful implementation path or a relevant validation step. A 1,400-byte MCP envelope reserve consumes part of the 6,000-byte default budget.

File/intent handling introduces additional errors. [src/context/intent.ts:53](D:/MyProjects/CodeAtlas/src/context/intent.ts:53) recognizes unquoted paths with separators but misses a bare root filename such as `README.md`. Capitalized prose such as “Document” can become an explicit symbol if a case-insensitive matching symbol exists. The candidate-kind allowlist in [src/context/ranker.ts:15](D:/MyProjects/CodeAtlas/src/context/ranker.ts:15) has no documentation kind.

**Change:** derive task obligations and resolve explicit files/symbols before vocabulary expansion. Support documentation/configuration tasks using their own candidate types. Assemble the smallest useful packet around resolved anchors: edit, relevant behavior/path, constraints, validation, then background. Use compact references and omit duplicated record bodies. Expose which obligations were satisfied or omitted.

**Acceptance:** the default MCP budget must cover a source-backed starting location and either relevant validation or an explicit reason it is unavailable. The MCP query task should include the server registration and handler/query boundary. The README task should identify the actual README. Test mixed feature-and-test requests and root filenames.

### F5 · P1 · Test recommendations confuse fixtures with executable tests

[src/context/planner.ts:517](D:/MyProjects/CodeAtlas/src/context/planner.ts:517) accepts functions/classes under a broad test path as tests. It then sorts task-term overlap before graph relationship strength at line 537. The exact-function brief selected an unrelated authentication fixture because its name matched generic retrieval vocabulary.

The repository already distinguishes `fixture` and `test` in [src/analysis/scope.ts:20](D:/MyProjects/CodeAtlas/src/analysis/scope.ts:20), but the planner does not use that distinction here. Its `direct` label is also derived from membership in a set expanded through multi-hop and potential paths, so it is not a reliable direct-test relationship.

**Change:** reuse canonical scope, distinguish test cases, test files, helpers, and fixtures, and prefer verified test-to-target paths. Include the supporting path and relationship class. Use observed coverage as an optional additional signal. Choose commands for the owning package and runner; root npm scripts alone do not cover Python or monorepo validation.

**Acceptance:** changing `findSymbolIr` recommends relevant MCP/retrieval tests; fixture source and Markdown cannot appear as runnable tests. Distinguish direct, transitive, heuristic, and observed coverage explicitly.

### F6 · P1 · Maintained repository knowledge does not reach change preparation

[src/knowledge/system.ts:240](D:/MyProjects/CodeAtlas/src/knowledge/system.ts:240) builds owners, purposes, journeys, invariants, canonical names, and documentation freshness findings. [src/compiler/build.ts:530](D:/MyProjects/CodeAtlas/src/compiler/build.ts:530) writes the knowledge artifacts.

The task planner does not consume this report or the configured knowledge entries. Its [invariants](D:/MyProjects/CodeAtlas/src/context/planner.ts:594) come from current violations, generic contract-preservation statements, and ADR titles. ADR collection at line 299 is global rather than scoped to the task. A valid architecture rule that has not yet been violated is also absent from `relevantConstraints`.

**Change:** make knowledge queryable alongside code facts. Resolve a task to applicable owners, accepted ADRs, scoped invariants, allowed dependency rules, change recipes, and validation commands. Preserve human-authored versus inferred provenance and surface stale/superseded guidance. Expose this through preparation and a progressively readable knowledge resource.

**Acceptance:** a configured invariant for the edited package appears in its brief; unrelated ADRs do not. Canonical names influence retrieval. Applicable rules are present before an agent violates them.

### F7 · P2 · Progressive navigation contains dead ends

The default server correctly exposes four tools, but [the continuation](D:/MyProjects/CodeAtlas/src/context/budgeter.ts:160) recommends `get_symbol` and `analyze_impact`, both behind `CODEATLAS_MCP_LEGACY_TOOLS=1`. Following the instruction fails on the default server.

[The review prompt](D:/MyProjects/CodeAtlas/src/mcp/server.ts:338) requests `codeatlas://change`; the registered resource is `codeatlas://change/{fingerprint}`. The latter echoes the requested fingerprint while returning current changes without enforcing that identity.

**Change:** generate typed next actions from the actual advertised capabilities, with exact tool arguments or complete resource URIs. Add a valid current-changes resource or interpolate a real fingerprint and enforce its meaning. Return continuation handles for omitted context rather than generic legacy-tool instructions.

**Acceptance:** run every generated next action and prompt resource against the default server in an SDK-level test. Each URI/handle should either return the specified snapshot or a typed stale-reference result.

### F8 · P1 product gate · Passing checks do not establish agent improvement

[evals/development-baseline.md](D:/MyProjects/CodeAtlas/evals/development-baseline.md) explicitly states that no comparative agent run is checked in. `npm run check` validates fixtures and runs a provider dry run; it does not execute the paired agent experiment.

The provider prompt in [src/evaluation/provider.ts:62](D:/MyProjects/CodeAtlas/src/evaluation/provider.ts:62) is read-only. Success scoring checks supplied evidence-file recall and expected concepts/relationships, not whether a patch actually works. Existing P0 context tests use a tiny synthetic repository and, for the main path test, a 12,000-byte budget. They do not catch the default-budget self-repository failures above.

**Change:** retain extraction/contract tests, add the reproduced tasks as retrieval and default-MCP regressions, then run a held-out paired experiment. Include executable change tasks in disposable repositories and verify patches with task-specific tests. Count all model-visible context, tool schemas, tool calls, native fallback reads, indexing time, and validation costs.

**Acceptance:** publish paired results with immutable model/harness/checkout identities. The existing target—20% lower median context tokens with at most a two-percentage-point success regression—is a reasonable declared experiment, not an achieved result. Also report required-file recall, wrong edit locations, irrelevant-test rate, unsupported claims, and latency.

## Recommended implementation sequence

| Stage | Deliverable | Exit condition |
|---|---|---|
| 1. Trust and retrieval | Fix exact ranking, evidence identity, explicit-file resolution, fixture filtering, and dead navigation. Add reproductions at the public MCP boundary. | Every reproduced defect above has a failing-before/passing-after regression. |
| 2. Useful context at the default budget | Task obligations, anchor-based paths, compact evidence references, usable continuations, and scoped validation. | Real repository tasks return the intended edit boundary and validation without hand-tuned vocabulary or inflated budgets. |
| 3. Cheap incremental access | Bounded SQLite graph/evidence queries, hydrate-after-selection, in-flight read caching, and query telemetry. | Meet declared latency/memory budgets as unrelated repository size grows; reads remain current after edits. |
| 4. Connected project knowledge | Retrieve scoped ownership, decisions, invariants, contracts, rules, and change recipes through the same planner. | An agent receives the relevant project constraints before editing and sees stale guidance explicitly. |
| 5. Demonstrated advantage | Paired native-versus-CodeAtlas runs on unfamiliar repositories, including patch validation and unsupported cases. | Measurable context savings with preserved or improved task success. Publish losses and limitations too. |

Keep the compact four-tool entry point. Add query modes or progressively loaded resources when needed; avoid making the agent learn a large catalog to complete common work. Keep the viewer tied to the same selected paths and evidence so a developer can inspect an agent's plan.

Optional local semantic retrieval can help with vocabulary mismatch after exact retrieval and task grounding work. It should contribute candidates; compiler, graph, configuration, and source evidence should continue to validate claims. Broader language/framework coverage should follow observed task failures and precision tests.

The roadmap also needs reconciliation: it still lists the task-context compiler, evaluation harness, and indexed query work as future work even though partial implementations exist. Track the specific acceptance gaps above rather than counting these capabilities as either wholly missing or complete.

## Reproduction notes

The audit used the compiled code produced by `npm run check`. Re-run these CLI requests after a build:

```text
node dist/cli/index.js search findSymbolIr . --limit 20
node dist/cli/index.js context "Add a new MCP query that explains how indexed retrieval becomes evidence-backed output" . --budget 6000 --format json
node dist/cli/index.js context "Change findSymbolIr retrieval behavior" . --budget 12000 --format json
node dist/cli/index.js context "Document the prepare_change workflow in README.md" . --budget 12000 --format json
node dist/cli/index.js ask "How does an MCP find_symbol request become an evidence-backed response?" . --json
```

CLI context has a different envelope reserve from MCP. The default-budget findings and latency above come from the actual `prepare_change` tool. Reproduce them by connecting an MCP SDK client to `createCodeAtlasServer`, listing its four tools, then calling `search` and `prepare_change` with the same task.

Local diagnostic scripts and results are retained under the ignored `.codeatlas/audit-*` paths, including `audit-summary.json`, `audit-mcp-summary.json`, `audit-mcp-wire.json`, and `audit-unit.mjs`. These outputs can include repository excerpts. They are diagnostic artifacts, not published benchmark evidence. Adding this report changes the working-tree fingerprint on the next index refresh.
