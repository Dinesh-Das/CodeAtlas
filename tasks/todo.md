# Compact repository context

- [x] Add and test a lossless compact context codec, including literal safety.
- [x] Integrate source-reference policy and named path symbols into byte budgeting.
- [x] Expose compatible CLI/API/MCP controls and test compiled workflows.
- [x] Add reproducible context measurements and document interpretation and usage.
- [x] Run project checks, package smoke, and review the complete diff.

Verification: `npm run check` passed; the final coverage run passed 228 tests across
51 files with 85.17% statements, 72% branches, 85.49% functions, and 87.7% lines.
`npm run package:smoke` passed with the installed compact CLI and public API exports.
Context measurements are recorded in `reports/context-compression-2026-10-31.json`.
These measurements do not replace held-out agent outcomes or a matched Graphify benchmark.
