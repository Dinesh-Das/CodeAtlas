# CodeAtlas roadmap

CodeAtlas is an evidence-first code intelligence layer for AI coding agents. Roadmap priority is
driven by incorrect or missing evidence on real repositories, not by raw language-count growth.

## Beta exit criteria

- Validate on 10–20 repositories not used during development.
- Publish accuracy fixtures for every corrected graph edge and framework gap.
- Keep cold, incremental, query-latency, peak-memory, and database-size benchmark history.
- Document known compiler/framework coverage limits and surface them through `doctor`.
- Prove the install → index → overview → agent-question path on all supported operating systems.

## Next

- Broaden production Fastify and Prisma fixtures from public issue reports.
- Add optional local semantic candidate retrieval; graph/compiler evidence remains the validator.
- Improve framework projection incrementality and large-monorepo compiler memory reuse.
- Add benchmark comparisons across several large TypeScript, JavaScript, and Python repositories.
- Improve architecture names and starting-point recommendations using deterministic repository
  evidence and explicit confidence.

## Later

- Additional language and framework adapters based on demonstrated demand.
- A local visualization that consumes the same evidence packets as MCP clients.
- Stable extension APIs for third-party framework adapters and retrieval strategies.

See [CONTRIBUTING.md](CONTRIBUTING.md) before proposing or implementing a roadmap item.
