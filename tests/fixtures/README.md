# Test fixtures

Each supported language mode has a structural source fixture and a deterministic normalized graph
snapshot:

- TypeScript
- JavaScript
- TSX
- JSX
- Python
- Go
- Java
- Rust

The snapshots cover modules, symbols, containment, exports, transient references, evidence,
confidence, signatures, and literal-value redaction. Relationship fixtures cover imports, calls,
inheritance, implementations, general references, exact and ambiguous targets, provenance,
conditional execution, and resolution issues.

Integration tests also create disposable Git repositories to exercise tracked, untracked,
modified, renamed, and deleted working-tree state. Framework fixtures cover Express, Fastify,
FastAPI, Prisma, and SQLAlchemy. Architecture and MCP fixtures cover features/domains, dependency
communities, control/execution flow, impact, rules, review, snapshots, current source ranges,
pagination, typed errors, uncertainty, freshness, and canonical IR compatibility.
