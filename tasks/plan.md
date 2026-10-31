# Implementation plan: compact repository context

Specification: `docs/compact-context-spec.md`.

The existing planner ranks useful context but repeatedly serializes symbol and
evidence identities. Normalize the selected facts, then let its existing budget
packer measure that representation. Source can be deferred explicitly for agents
that can fetch evidence progressively.

Build order: codec -> budgeted planner -> CLI/MCP -> reproducible measurements.
No storage migration or production dependency is required.

Risks: dictionary aliases must never rewrite prose, source deferral must remain
explicit, and compact output must preserve evidence closure and byte bounds.
Tests cover each boundary, including the compiled distribution.

Task acceptance and verification are tracked in `tasks/todo.md`.
