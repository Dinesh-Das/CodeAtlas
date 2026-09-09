# Two-minute demo: change an authenticated contract safely

This recording script demonstrates one concrete task: rename an authenticated order endpoint,
update its OpenAPI response contract, and find every consumer and validation command.

Use a public repository pinned to one commit. Show the commit before starting and keep both runs on
fresh clones with the same agent, model, prompt, and time limit. Record tool calls, elapsed time,
files read, planned files, actual edits, validation result, and regressions in the evaluation
harness. Do not substitute generated capability counts for task success.

## 0:00-0:25 — Native repository search

Ask: “Rename `GET /orders/:id` to `GET /orders/:orderId`, preserve authentication, update the
declared response contract, and tell me what to validate.” Show the native search sequence until
it identifies the route, middleware, handler, service, datastore access, OpenAPI operation,
consumers, and tests. Stop at 25 seconds and retain the incomplete findings rather than editing the
recording.

## 0:25-1:20 — CodeAtlas brief

Run:

```bash
codeatlas context "Rename GET /orders/:id to GET /orders/:orderId, preserve authentication, update the response contract, and identify validation" .
```

In an MCP host, make the equivalent `prepare_change` call. Expand one verified execution path and
one contract edge, open their file/line evidence, then show the edit locations, invariant,
affected tests, validation commands, and unresolved boundary. Keep uncertainty visible.

## 1:20-1:50 — Apply and verify

Let the agent make the bounded edit, run the checklist commands, and generate:

```bash
codeatlas review-report . --base HEAD~1 --format markdown --output reports/demo-review.md
codeatlas report . --output reports/demo-proof.json --include-repository-url
```

Show that the proof report contains commit, fingerprint, latency, memory, database size, graph-fact
distribution, and privacy checks without source excerpts or prompt text.

## 1:50-2:00 — Comparison

Display the paired evaluation row: required-file recall, unnecessary files read/edited, tool calls,
model-visible bytes, wall time, validation result, and regressions. State the result that was
measured. If the CodeAtlas run loses, publish that result and the manifest too.
