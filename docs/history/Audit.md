# CodeAtlas audit — product reality, not portfolio scoring

I went through the architecture, indexing pipeline, parsers, graph resolution, SQLite layer, framework adapters, architecture analysis, MCP tools, freshness model, tests, CLI, CI/release setup, and the product requirements.

My verdict:

> **CodeAtlas is a serious foundation for a developer tool. It is not a toy and it is not just another “chat with your repo” wrapper. But in its current form, I would not yet call it a tool for understanding genuinely large codebases.**

The fundamental idea is good enough that **I would keep building it**.

But I would stop adding surface features for a while. There are a few architectural issues that will become painful precisely when CodeAtlas encounters the kind of repositories you want it to handle.

### Where I rate it today

| Area                                 |        Score | Assessment                                                 |
| ------------------------------------ | -----------: | ---------------------------------------------------------- |
| Product thesis                       |     **9/10** | Strong differentiation                                     |
| Internal architecture                |     **8/10** | Well separated and understandable                          |
| Local-first / security               |     **9/10** | One of the project's strongest properties                  |
| Graph/data model                     |     **8/10** | Good foundation                                            |
| Incremental indexing design          |   **7.5/10** | Good concept, expensive downstream work                    |
| Parsing                              |     **7/10** | Solid syntax intelligence                                  |
| Reference resolution                 |     **5/10** | Biggest correctness limitation                             |
| Architecture understanding           |   **5.5/10** | Useful heuristics, not deep enough yet                     |
| Search/retrieval                     |   **4.5/10** | Weak for natural developer questions                       |
| Large-repo scalability               |     **3/10** | Several algorithms will hurt badly                         |
| Tests/invariants                     |   **7.5/10** | Good functional tests                                      |
| Realistic load testing               |     **2/10** | Essentially missing                                        |
| Developer UX                         |     **4/10** | Currently more agent infrastructure than developer product |
| Production readiness for large repos | **5–5.5/10** | Strong alpha                                               |
| Quality of the underlying foundation |    **~8/10** | Definitely worth continuing                                |

So I would describe CodeAtlas today as:

**A strong technical MVP / alpha with a genuinely good architecture, but not yet a production-grade large-codebase intelligence system.**

---

## What I genuinely like

The most important thing you got right is the **product philosophy**.

You aren't doing:

`repository → chunks → embeddings → LLM → hope`

You're building something closer to:

`repository → AST → symbols → relationships → architectural graph → evidence → agent`

That is much more interesting.

The combination of:

**deterministic graph + provenance + confidence + unresolved references + current-working-tree awareness + MCP**

could become CodeAtlas's identity.

That matters because developers don't merely need an AI saying:

> "It looks like authentication probably happens here."

They want:

> `POST /login` → `authController.login()` → `authService.authenticate()` → `userRepository.findByEmail()` → `users` model

with links back to actual code and an explicit indication of which relationships are known versus inferred.

Your architecture is moving in that direction.

The SQLite model is also sensible. WAL, migrations, FTS, persistent graph state and deterministic identifiers are much more suitable for this product than trying to make a vector database the central source of truth.

Your handling of uncertainty is particularly good. CodeAtlas doesn't seem designed to quietly convert every ambiguous relationship into a "fact." That's exactly the behavior I would want from developer tooling.

The incremental indexing architecture, Git rename identity handling, framework adapters, secrets/path exclusion, current-working-tree source retrieval and MCP answer packets show much more engineering thought than a typical AI portfolio project.

So this project absolutely has substance.

---

# But these are the things that would stop me from recommending it to a team today

## 1. Your resolver contains a genuine large-codebase scalability bomb

This is the biggest technical issue I found.

In:

`src/graph/resolver.ts:399-437`

you calculate import distances by effectively doing:

```text
for every module:
    BFS through the import graph
    store distance to reachable modules
```

You're precomputing an all-pairs reachability/distance structure.

Conceptually that trends toward:

**O(V × (V + E)) time**

with potentially enormous distance storage.

For 100 modules, who cares.

For 1,000 modules, perhaps manageable.

For 10,000–50,000 modules in a serious monorepo, this becomes the wrong architecture.

And this runs as part of reference resolution:

`src/graph/resolver.ts ~651`

This is exactly the sort of implementation that performs beautifully in unit tests and then falls apart when somebody points it at a Microsoft/Google/enterprise-scale monorepo.

You don't need all-pairs distances.

You need **on-demand bounded graph traversal**, indexed lookup and caching.

For a reference originating in module A, calculate only what is necessary for A's unresolved candidates.

Even better, eliminate much of the need for heuristic distance using proper language-level resolution.

---

## 2. TypeScript/JavaScript module resolution isn't sufficient for modern large repositories

This is probably the biggest **accuracy** problem.

Look at:

`src/graph/resolver.ts:98-159`

JS/TS internal module candidate resolution primarily handles paths beginning with:

```ts
if (reference.name.startsWith("."))
```

That means the happy path is things like:

```ts
import { foo } from "../../services/foo";
```

But real TypeScript monorepos increasingly look like:

```ts
import { foo } from "@/services/foo";
import { User } from "@app/domain";
import { logger } from "@company/platform";
import { config } from "src/config";
```

with:

* `tsconfig.paths`
* `baseUrl`
* npm workspaces
* pnpm workspaces
* Yarn workspaces
* package `exports`
* package aliases
* project references
* barrel exports

Those aren't niche cases.

They are **normal large-codebase cases**.

So CodeAtlas can index a huge TypeScript repository while silently missing some of the relationships that matter most.

For your intended product, this is P0.

I would seriously consider using the **TypeScript Compiler API/module resolver** rather than continuing to reimplement modern TS resolution manually.

And eventually, using the compiler's type information gives you another massive improvement.

Consider:

```ts
paymentService.process(order)
```

Tree-sitter can tell you syntactically:

> something called `process` is being called.

It cannot reliably tell you:

> this is `PaymentService.process(Order)`.

If the repository contains 37 methods named `process`, graph-distance heuristics will only get you so far.

This is where syntax intelligence has to become **semantic intelligence**.

---

## 3. Every MCP request can pay an O(repository) freshness tax

I like your invariant:

> never answer from a stale graph.

Keep that.

But the current implementation is too expensive.

`src/mcp/freshness.ts:12-17`

calls `getStatus()` before serving a request.

And `getStatus()` in:

`src/cli/status.ts:41+`

does file discovery and repository fingerprint calculation.

It loads ignore rules, discovers the repository files, compares file metadata and hashes changed candidates.

Then CodeAtlas may index.

Then it calls `getStatus()` **again**.

So a request such as:

```text
codeatlas_get_node
```

can require filesystem traversal before CodeAtlas even answers the graph query.

On a small repository, invisible.

On a repository with:

**100,000+ files, network-mounted directories, antivirus scanning, Windows filesystem overhead, massive monorepos**

that becomes noticeable very quickly.

And an AI coding agent won't make one query.

It may make:

```text
overview
search
get_node
dependencies
trace
source
impact
search
get_node
...
```

Twenty tool calls shouldn't mean twenty repository scans.

You need a very cheap **freshness fast path**.

Something closer to:

```text
MCP daemon
    ↓
filesystem watcher / dirty-file journal
    ↓
Git HEAD/index state
    ↓
incrementally update changed files
    ↓
graph remains warm
    ↓
MCP query ≈ DB query
```

with full reconciliation available as a correctness fallback.

Your requirement says graph queries should be below roughly **500 ms** after freshness.

I don't trust the current architecture to maintain that on genuinely large repos.

---

## 4. Your "communities" currently aren't communities

This one matters because it's directly related to your product promise of **understanding architecture**.

`src/analysis/communities.ts:4-46`

turns your graph undirected and calculates **connected components**.

Imagine:

```text
checkout
auth
catalog
payments
notifications
analytics
users
```

If all these systems share even a few dependencies, they're probably part of one connected graph.

CodeAtlas may consequently say, effectively:

```text
COMMUNITY 1
- 8,742 files
```

That's mathematically valid.

Architecturally, it's almost useless.

What developers really want is something like:

```text
Authentication
Payments
Checkout
Catalog
Notifications
Shared Platform
Observability
Data Access
```

even though those clusters are connected.

You need actual graph clustering/community detection.

Leiden/Louvain/modularity-based clustering would already be much more interesting.

Combine that with package/workspace structure and naming evidence.

This could become one of CodeAtlas's strongest features.

---

## 5. Search is much weaker than the product around it

Here's an example from:

`src/mcp/graph-tools.ts:136-141`

Natural language terms become FTS conditions joined using:

```text
AND
```

Therefore:

```text
How does checkout work
```

becomes roughly:

```text
"How"* AND "does"* AND "checkout"* AND "work"*
```

That's not how developers search repositories.

Ironically, **"How does checkout work?" is exactly the kind of question CodeAtlas should be phenomenal at.**

A good repository intelligence engine should interpret that query closer to:

```text
concept = checkout
intent = explain feature
possible entities =
  CheckoutController
  checkout/
  OrderService
  PaymentService
  POST /checkout
```

and then expand through the graph.

I'd build a retrieval stack like:

```text
Query
  ↓
lexical/BM25
  +
symbol matching
  +
path/package matching
  +
semantic retrieval
  +
graph neighborhood
  ↓
reranking
  ↓
evidence packet
```

And **yes, embeddings can belong here**.

I wouldn't turn CodeAtlas into a RAG application.

I'd use embeddings as one retrieval signal over the deterministic graph.

That combination is much stronger.

---

## 6. Search results become artificially inaccessible after the configured candidate ceiling

There is another subtle problem in:

`src/mcp/graph-tools.ts:191-231`

You first retrieve at most:

```ts
maxMcpResultNodes
```

then rank that set.

Pagination happens **inside that already truncated candidate set**.

So if max candidate nodes is 200 and a repository has 3,000 potentially relevant symbols, results #201 onward aren't merely on another page.

They're effectively unavailable to that query.

You do correctly expose uncertainty saying the candidate set was truncated.

That's good engineering.

But the underlying product behavior still needs fixing.

For large codebases, pagination should eventually let me retrieve deeper candidates through SQL-backed cursors/query plans rather than paginate an already-capped snapshot.

---

## 7. Incremental indexing isn't entirely incremental yet

Your file indexing itself has a good incremental model.

But then:

`src/indexer/indexer.ts:657-664`

can invoke global architecture analysis after graph changes.

That analysis loads/recomputes large portions of the graph.

So the workflow can become:

```text
1 file changed
      ↓
parse 1 file                  ← cheap
      ↓
resolve graph relationships   ← potentially expensive
      ↓
recalculate architecture      ← global
```

That's dangerous.

Your requirement of approximately:

> <10 files changed → refresh under 2 seconds

needs to be **measured**, not assumed.

Right now I found functional tests for incremental behavior.

I did **not** find serious benchmark tests proving your published large-repository performance targets.

That's an important difference.

---

# There is another product-level problem: CodeAtlas is currently more useful to an AI agent than to a developer

This is important given what you told me:

> you want developers to use it to understand large codebases.

Right now the primary product interaction appears to be:

```text
CLI → initialize/index/status
MCP → AI agent queries graph
```

That's a good **infrastructure product**.

It isn't yet a great **developer product**.

When I join a company and encounter a 2-million-line repository, my questions aren't initially:

> Give me graph node 73fc...

They're:

> **What are the major systems here?**

> **Where should I begin reading?**

> **What happens after this API request arrives?**

> **Where is authentication actually enforced?**

> **If I modify this class, what could break?**

> **Why does this service depend on that package?**

> **Which parts of this repository are tightly coupled?**

> **What's legacy versus actively developed?**

> **What are the entrypoints?**

> **Show me the path from UI → API → service → DB.**

> **Which five files should I read to understand checkout?**

CodeAtlas has many of the ingredients necessary to answer those questions.

But the experience isn't there yet.

---

# The version of CodeAtlas I think could actually become compelling

I would position it very specifically:

> **CodeAtlas builds a living, local map of your codebase so developers and coding agents can understand how a system actually fits together.**

Not:

> AI chat for your codebase.

There are hundreds of those.

And not merely:

> MCP knowledge graph server.

Developers don't buy MCP servers.

The architecture I would aim toward is:

```text
                     ┌───────────────────────────┐
                     │      Developer Query      │
                     │ "How does checkout work?" │
                     └─────────────┬─────────────┘
                                   ↓
                     ┌───────────────────────────┐
                     │      Query Planner        │
                     └─────────────┬─────────────┘
                                   ↓
            ┌──────────────────────┼──────────────────────┐
            ↓                      ↓                      ↓
      Symbol Search          Semantic Search        Graph Search
            │                      │                      │
            └──────────────────────┼──────────────────────┘
                                   ↓
                     ┌───────────────────────────┐
                     │   Evidence / Reranking    │
                     └─────────────┬─────────────┘
                                   ↓
            ┌──────────────────────┼─────────────────────┐
            ↓                      ↓                     ↓
       Architecture             Trace                Source
          Graph              Relationships          Evidence
            └──────────────────────┼─────────────────────┘
                                   ↓
                     ┌───────────────────────────┐
                     │ Grounded Explanation      │
                     │ + confidence/uncertainty  │
                     └───────────────────────────┘
```

The deterministic graph remains the source of truth.

Semantic search simply helps find the right part of the graph.

The LLM explains the evidence.

That's a much stronger architecture than ordinary repository RAG.

---

# What I would build next

I would **not add another 10 frameworks right now**.

My next releases would look approximately like this:

| Priority | Work                                                 | Why                                                   |
| -------- | ---------------------------------------------------- | ----------------------------------------------------- |
| **P0**   | Large-repository benchmark harness                   | You currently don't know your actual scaling envelope |
| **P0**   | Remove all-pairs import distance calculation         | Hard scalability blocker                              |
| **P0**   | Cheap persistent freshness mechanism                 | MCP needs consistently low latency                    |
| **P0**   | Real TS module resolution                            | Large TypeScript repositories require it              |
| **P0**   | Symbol indexes rather than repeated whole-node scans | Resolver needs to scale                               |
| **P1**   | TypeScript semantic/type information                 | Dramatically improves call resolution                 |
| **P1**   | Hybrid lexical + semantic + graph retrieval          | Makes conceptual queries actually work                |
| **P1**   | True graph community detection                       | Makes architecture discovery meaningful               |
| **P1**   | Workspace/package awareness                          | Essential for monorepos                               |
| **P1**   | Better Python module resolution                      | Required before claiming strong Python support        |
| **P1**   | Progressive indexing status + timing telemetry       | Necessary for developer trust                         |
| **P2**   | VS Code extension/TUI                                | Turns infrastructure into a developer experience      |
| **P2**   | Interactive architecture map                         | Huge value for unfamiliar repositories                |
| **P2**   | Architecture diff over Git history                   | Potential killer feature                              |
| **P2**   | More framework adapters                              | Only once fundamentals are strong                     |

And your benchmark should be brutal.

Don't only generate a synthetic repository with 500 files.

Test something like:

| Scenario               |                         Target |
| ---------------------- | -----------------------------: |
| 10k LOC                |              basically instant |
| 100k LOC               |                    comfortable |
| 500k LOC               |              <2 min cold index |
| 1M+ LOC                |                         usable |
| 25k modules            |  no pathological memory growth |
| Modify one file        | ~sub-second/low-second refresh |
| Modify 10 files        |                  <2 sec target |
| Warm `get_node`        |                        <100 ms |
| Warm search            |                    <200–300 ms |
| Fresh MCP request      |                    <500 ms p95 |
| Long dependency chain  |               no stack failure |
| 50k+ candidate symbols |       retrieval remains usable |

Measure **p50, p95, memory peak and database size**, not merely total runtime.

That test suite will probably teach you more about CodeAtlas than the next three months of adding features.

---

# I would also narrow the promise temporarily

Today CodeAtlas supports TypeScript/JavaScript/Python and several framework concepts.

For building credibility, I'd rather see:

> **CodeAtlas is unbelievably good at understanding TypeScript monorepos.**

than:

> CodeAtlas understands everything.

TypeScript gives you an enormous opportunity because the compiler already knows:

* module resolution
* aliases
* project references
* inferred types
* interfaces
* class inheritance
* overloads
* receiver types
* re-exports
* package relationships

Use that information.

Then something like:

```ts
orderService.process(order)
```

stops being:

> method called `process`, possible candidates: 13

and becomes:

> call to `OrderService.process(Order)` at `src/orders/order-service.ts:84`

That change alone moves CodeAtlas into another quality category.

You can later build similarly serious Python intelligence around Pyright/Python project metadata.

---

# Your architecture analysis also needs to become more sophisticated

Your current domain/feature inference uses directory layout as a meaningful signal.

That's reasonable as a starting heuristic.

It works great for:

```text
src/
  checkout/
  authentication/
  catalog/
  payments/
```

But imagine:

```text
controllers/
services/
repositories/
models/
utils/
```

The business feature **checkout** might span all five directories.

Directory heuristics then detect technical layers rather than business domains.

A better feature detector should combine:

```text
folder locality
+ symbol names
+ imports
+ calls
+ routes
+ database models
+ Git co-change history
+ semantic similarity
+ graph clustering
```

Git history could be especially powerful here.

Files that repeatedly change together often reveal real subsystem boundaries that directory structure doesn't.

You already have Git awareness.

That could become a real differentiator.

---

# One thing I would change in the product philosophy

You currently lean heavily toward:

> if CodeAtlas cannot prove it deterministically, say insufficient evidence.

I like that.

**Do not remove it.**

But don't let that philosophy make the product useless.

You need two information classes:

```text
VERIFIED
Directly derived from compiler/AST/config/framework structure.

INFERRED
Probabilistic conclusion from graph, semantics or architectural signals.
Confidence: 0.82
Evidence: [...]
```

Then developers can choose what to trust.

For example:

> **Likely checkout flow — 91% confidence**
> Route `/checkout` → CheckoutController → OrderService → PaymentService → OrderRepository
>
> Verified relationships: 8
> Inferred relationships: 2
> Unresolved relationship: payment event consumer

That is far better than either hallucinating the whole thing or refusing to tell me anything.

---

# A very important potential feature: "Read this codebase for me"

If CodeAtlas eventually had a VS Code interface, I'd want to open a repository and initially see something like:

```text
CODEATLAS

Repository
1,482,302 LOC
9,816 source files
37 packages
14 architectural domains

Architecture
├── Authentication
├── Checkout
├── Catalog
├── Payments
├── Fulfillment
├── Notifications
├── Analytics
└── Platform

Recommended starting points
1. apps/api/src/main.ts
2. packages/core/src/application.ts
3. packages/auth/src/auth.module.ts
4. packages/orders/src/order.service.ts

Important flows
→ User authentication
→ Checkout
→ Payment processing
→ Order fulfillment

Hotspots
⚠ OrderService — high fan-in
⚠ LegacyPaymentAdapter — cycle participant
⚠ common/utils — 182 dependents

Recent architectural changes
+ payment-v2 introduced
+ checkout now depends on fraud-service
- legacy-auth dependency removed
```

**That is a developer tool.**

Then clicking **Checkout** should produce:

```text
                    POST /checkout
                          │
                          ▼
                  CheckoutController
                          │
                          ▼
                     OrderService
                     /         \
                    ▼           ▼
             InventorySvc    PaymentSvc
                    │           │
                    ▼           ▼
               Inventory      Gateway
                    │
                    ▼
              OrderRepository
                    │
                    ▼
                  orders
```

and every box should be clickable into source.

CodeAtlas already has pieces of this information.

That's why I think the project is worth continuing.

---

# Your strongest potential moat

It is **not** Tree-sitter.

It is not MCP.

It is not SQLite.

It is not embeddings.

Those are implementation technologies.

Your moat could eventually be:

> **A fast, incrementally maintained semantic map of a changing repository that accurately knows relationships, understands uncertainty, and can explain every conclusion using source evidence.**

If CodeAtlas gets that right at 1M+ LOC, developers and coding agents both have a reason to use it.

That's difficult engineering.

And therefore valuable.

---

# Would I personally use the current version?

For a **small/medium unfamiliar repo**:

**Yes, I would experiment with it.**

For a **large enterprise monorepo that I don't understand**:

**Not yet.**

I would currently worry that:

```text
modern import aliases → missing edges
common method names → ambiguous calls
large import graph → expensive resolver
every MCP request → freshness filesystem work
one connected graph → meaningless "community"
natural-language search → sparse/zero results
global architecture recomputation → slow incremental update
```

And unfortunately those problems become **more prominent as repository size increases**.

Which is exactly the opposite curve that CodeAtlas needs.

---

# The encouraging part

This does **not** need a rewrite.

That's important.

I don't look at this repository and think:

> throw it away and rebuild.

I think:

> stop increasing breadth and harden the core.

Your boundaries are reasonably clean enough that you can replace:

**resolver → freshness strategy → clustering → retrieval**

without destroying everything else.

That's a much better situation than having to unwind a giant LLM-centric architecture.

---

## One caveat about this audit

I inspected the source and tests extensively, but I did **not** count the automated suite as successfully executed in this environment. CodeAtlas declares **Node >=24**, while this runner has Node 22, and dependency installation here did not complete correctly. CI itself is configured for Node 24, so I am **not treating that environment failure as a CodeAtlas defect**.

More importantly, even a green current test suite wouldn't change my main findings: the large-repository concerns above come directly from the algorithms and query architecture.

---

# Bottom line

If you had shown me this and said:

> "I made an AI portfolio project."

I'd say you've already gone significantly beyond a normal portfolio project.

If you said:

> "This is ready to compete with mature developer code-intelligence tools."

I'd say **no, not yet**.

If you said:

> "Can this become a real open-source developer tool developers install specifically to understand massive unfamiliar systems?"

### **Yes. I think it can.**

But I would make the next phase almost entirely about **scale + resolution accuracy + retrieval quality + developer experience**, rather than piling on additional features.

The single biggest change in mindset I'd make is:

**CodeAtlas 0.9 was about proving that the architecture works.
CodeAtlas 1.0 should be about proving that it survives reality.**

And if this were my project, the very next milestone would be **“CodeAtlas Large Repository Hardening”**—with a benchmark suite first, then removal of the all-pairs resolver, proper TypeScript/package resolution, cheap freshness, and hybrid graph search. Those changes would move my assessment from roughly **5.5/10 as a production large-codebase tool today toward 7.5–8/10 very quickly**, because the underlying foundation is already there.



Now I have a complete picture. Let me write the honest audit.Got everything I need. Here's the honest audit.

---

## CodeAtlas – Honest Technical Audit

### What it actually is

A local-first MCP server that builds a SQLite-backed knowledge graph of a Git repo via tree-sitter AST parsing, then exposes 10 structured tools for AI agents to query. The scope is real: incremental indexing, cross-file reference resolution, architecture analysis, framework adapters, git history integration. This is not a toy.

---

### What's genuinely strong

**Architecture is clean.** The layer separation — `parser → graph → indexer → storage → mcp` — is coherent. Each layer has a single responsibility and the interfaces between them are well-typed.

**The Answer Packet schema is the best design decision in the codebase.** Structured `facts`, `relationships`, `source_snippets`, `uncertainties`, `freshness`, `security`, and `pagination` in every response means agents never get silent hallucination. When something can't be proven, it goes in `uncertainties` with a `reason` enum. That is exactly the right contract for an AI-facing tool.

**Incremental indexing is sophisticated.** Content hashing + stat fast-path + git state diff + reverse dependency neighborhood invalidation is non-trivial and correct. Files unchanged since last commit skip re-hashing. Modified files invalidate their reverse dependency neighborhood, not the whole graph.

**Provenance on everything.** `verified`, `inferred`, `dynamic`, `documentation`, `git`, `unresolved` — every node and edge carries this. Dynamic references (DI containers, event emitters, reflection) get reduced confidence rather than false certainty.

**Zod everywhere.** Config, MCP input schemas, Answer Packet output — all validated. The schema-4/indexer-version-7 versioning with migration tracking is correct for a tool that stores persistent data.

**`codeatlas doctor`** is thorough and covers the right failure modes.

**Test structure is solid.** Unit, integration, parser fixtures, e2e — the right layers exist.

---

### Real problems

**1. Language support is the biggest adoption blocker.**
Three languages: TypeScript, JavaScript, Python. That's it. Most large codebases in enterprise settings are Java, Go, Kotlin, Rust, or C#. You're positioning this as a tool for understanding large codebases, but if someone's primary repo is Go or Java, they can't use it at all. This isn't a v1 gap — it's a constraint that limits who you can even talk to. Tree-sitter has grammars for all of them; the architecture supports adding parsers cleanly. This should be the first roadmap item.

**2. Community detection does not detect communities.**
`src/analysis/communities.ts` runs BFS to find connected components — it labels every transitively linked file as one "community." In any real codebase, 80-90% of files are in one giant connected component, so you get one mega-community and a handful of singletons. This tells an agent almost nothing about modular structure.

What you actually want: Louvain or Leiden algorithm on the weighted adjacency matrix. It finds densely coupled clusters within the giant component — the actual answer to "which files form a coherent subsystem." The current output is technically not wrong but is practically useless for large repos.

**3. Tarjan's SCC in `cycles.ts` is recursive with no depth guard.**
The `connect` function calls itself once per node in the dependency chain. JavaScript's call stack is typically 10,000-15,000 frames. A large TS monorepo with a 500-file transitive dependency chain will throw `RangeError: Maximum call stack size exceeded`. This needs to be rewritten iteratively with an explicit stack.

**4. Node 24+ is an aggressive requirement.**
Node 20 LTS is what most CI/CD pipelines, Docker images, and developer machines run today. `engines: { node: ">=24.0.0" }` will silently fail to install or crash on first run for a large portion of potential users. There's no technical reason this couldn't run on Node 20 — the async/await, SQLite bindings, and tree-sitter bindings all work there. This will kill adoption before the tool gets a chance.

**5. Architecture analysis runs inside the write transaction.**
In `indexer.ts`, `runArchitectureAnalysis` — which includes community detection, cycle detection, coupling metrics, and grouping across the entire file graph — is called *inside* `database.transaction()`. For a 10,000-file repo, this transaction could run for 30-60 seconds while holding the SQLite write lock. Anything trying to read from the DB during indexing (including the freshness check in concurrent MCP calls) will block.

**6. `ensureFreshIndex` blocks every MCP call.**
If the index is stale, every MCP tool call triggers a full `indexRepository()` before responding. For a large repo, this could mean a 60-second wait on the first agent question after a `git pull`. There's no background indexing, no progress streaming, no "here's stale data while I update." The agent times out or the user thinks the tool is broken.

**7. Feature detection is directory-name heuristics pretending to be more.**
`groupKey()` extracts the first non-source-root path segment as the "feature" or "domain" name. If your repo is `src/feature-a/`, you get the feature "feature-a." If your repo is `src/services/auth/`, you get the domain "services." The weighted signal system (routes, models, imports, communities) adds nuance, but the fundamental grouping is still just directory names. On non-standard or flat codebases, this produces meaningless groupings. It works for well-structured repos and breaks badly for others.

**8. TypeScript path aliases are not resolved.**
Projects using `compilerOptions.paths` in `tsconfig.json` (`@components/*` → `src/components/*`, `@/utils` → `lib/utils`, etc.) will generate resolution failures for every aliased import. The resolver only handles relative paths and bare module names. In any large TS project, this is most of the internal imports.

**9. The `package` NodeKind is a dead concept.**
It exists in `graph/types.ts` as a valid node kind. The indexer never generates it. The MCP tools never query for it. It's listed in the type system and the schema but serves no purpose. Either implement monorepo package detection or remove it.

**10. No visualization.**
The tool builds a knowledge graph. Developers understand large codebases by *seeing* graph structure — which modules are highly connected, where the clusters are, where cycles exist. The only consumer interface is MCP. A `codeatlas viz` command that outputs D3/Cytoscape JSON, or a static HTML graph, would make the tool understandable on its own terms without requiring an AI agent as middleware.

**11. All CHANGELOG versions were created the same day.**
0.9.0, 0.8.0 — both tagged 2026-08-27. This isn't a tool with accumulated user feedback; it's a single development sprint presented as a version history. That's fine for where it is, but the tool hasn't been battle-tested against real large repos with real edge cases. The recursive Tarjan's and the community detection issues are exactly the kinds of things that would surface after running against a 50,000-file Java repo.

---

### Summary verdict

The core technical foundation is solid — better than most side projects at this stage. The graph model, provenance system, incremental indexing, and Answer Packet contract are genuinely good decisions that will hold up.

The gap between "works on my TypeScript repo" and "used by developers to understand large codebases" (your stated goal) is primarily: language coverage, correct community detection, stack-safe cycle detection, and handling the blocking re-index problem. Fix those four and the tool is credibly in beta. Without them, it's a well-built proof of concept for TS/JS/Python shops with small-to-medium repos.

Prioritized action list:

1. Add Go and Java tree-sitter parsers — directly doubles addressable repos
2. Replace connected-components with Louvain community detection
3. Make Tarjan's iterative
4. Lower `engines.node` to `>=20.0.0`
5. Move architecture analysis outside the write transaction
6. Add background/async re-indexing or at least stale-data passthrough
7. Resolve `tsconfig.json` path aliases
8. Add a basic `codeatlas viz` output
