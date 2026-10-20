# Launch readiness — 2026-10-21

Candidate: `0.11.0-beta.1`. Local validation: Windows, Node.js 24.12.0, npm 10.5.2.

**Stable release is blocked by the missing paired held-out provider evaluation.** Local
prerelease verification is recorded below. These checks do not establish that CodeAtlas is the
best competing tool or that it improves real agent task outcomes.

## Changes

- Upgraded the MCP SDK from 1.30.0 to 1.32.1 and individually refreshed five vulnerable transitive
  packages within their existing dependency ranges. No forced upgrades or audit exceptions.
- Enforced exact package version, SHA-256, and packed-file count for prereleases before publishing.
  Previously, those checks were enforced only for stable releases, while the post-publish checksum
  verification ran for every release. A stale prerelease identity could therefore be detected only
  after consuming the immutable npm version.
- Reused the artifact validator in the stable gate, exposed specific remaining stable blockers,
  and added direct and subprocess regression tests.
- Included the high/critical dependency audit in `npm run release:check` itself, in addition to CI.
- Documented artifact identity generation, held-out evaluation requirements, and npm rollback.
- Fixed the subsequent PR CodeQL findings: replaced backtracking test-filename detection in the
  canonical scope classifier, removed its duplicate planner regex, and removed interpolated
  JavaScript from the release-gate test fixture. A timed subprocess regression demonstrates the
  original classification timeout on repeated test markers.

## Verification

| Check | Result |
| --- | --- |
| Locked clean dependency installation | Passed in a disposable directory; SQLite and all six language parser bindings loaded |
| Type checking and lint | Passed |
| Full test and coverage run | 214 tests in 50 files passed; statements 84.03%, branches 71.31%, functions 84.44%, lines 86.58%; all existing thresholds passed |
| npm audit | Zero vulnerabilities across all reported severities |
| Distribution validation | Six host configurations, ten pinned repository records, adapter precision/recall 1.00 |
| Development evaluation validation | 30 tasks across six repositories; fixture/schema checks passed |
| Provider harness dry run | Validated the 180-observation development run shape; no provider calls made |
| Installed package smoke | CLI version, init, status, overview, ask, setup dry run, public API import, and local report passed; final first architecture answer in 14.9 seconds |
| Generated viewer | Built the architecture fixture in filesystem mode and loaded the HTML in the in-app browser; initial screen rendered with no warning/error console entries |
| Artifact identity and prerelease gate | Passed; 618 files, SHA-256 `8d3adffde815713c8aeda317566e87bafdecce4661bd374a256ab0768172fc2d` |
| Stable gate | Exited 1 as expected, with only the missing paired held-out provider evaluation reported |

The package smoke uses a disposable consumer and the exact local tarball. Its first-answer time
is a small-fixture observation, not a large-repository performance claim. Viewer validation covers
initial rendering; it is not a complete accessibility or interaction audit.

## Security dependency review

| Package | Before | After |
| --- | --- | --- |
| `@modelcontextprotocol/sdk` | 1.30.0 | 1.32.1 |
| `fast-uri` | 3.1.6 | 3.1.9 |
| `hono` | 4.13.5 | 4.13.13 |
| `ip-address` | 10.5.0 | 10.7.4 |
| `proxy-addr` | 2.0.7 | 2.0.8 |
| `source-map-js` | 1.2.1 | 1.2.2 |

Reviewed the upstream release notes and advisories, including the SDK's
[OAuth issuer-binding change](https://github.com/modelcontextprotocol/typescript-sdk/releases/tag/1.31.0),
[1.32.0 compatibility notes](https://github.com/modelcontextprotocol/typescript-sdk/releases/tag/1.32.0),
and the [proxy-addr security fix](https://github.com/jshttp/proxy-addr/blob/master/HISTORY.md).
The lockfile diff contains only those six package updates and proxy-addr funding metadata.

The focused source review covered MCP input/result schemas and read-only annotations, real-path
containment for evidence reads, filesystem discovery, secret-file exclusions, Git subprocess
argument handling, and SQLite query boundaries. A targeted credential-pattern scan found no
matches in source, scripts, workflows, documentation, or examples. This is not a penetration test
or a scan of the full Git history.

## Remaining release actions

1. Supply a private held-out suite and exact model/version, run the paired provider harness, and
   independently review the evidence. The stable gate requires at least 20 tasks, three repeats
   per variant, 90% required-file recall, 20% context-token reduction, and no more than 2%
   task-success regression. Keep `providerEvaluation: null` until real evidence exists.
2. Run the current candidate through fresh Linux/macOS/Windows and Node 22.12/24 CI, coverage,
   package smoke, and CodeQL before tagging. The latest inspected
   [main-branch CI](https://github.com/Dinesh-Das/CodeAtlas/actions/runs/34432637730) and
   [CodeQL run](https://github.com/Dinesh-Das/CodeAtlas/actions/runs/39234687439) passed for
   `09fb4c5`; they do not certify this local candidate.
3. Confirm npm trusted-publisher configuration and the intended release channel, then follow
   [RELEASING.md](../RELEASING.md). The registry lookup returned `latest=0.10.0`,
   `beta=0.10.0-beta.2`, and no published `0.11.0-beta.1` at audit time. No package or registry
   metadata was published during this review.

The manifest's ten cross-platform repository records and 222,160-LOC benchmark were collected on
2026-09-10 and remain historical evidence. Their validation dates and results were preserved.

## Local environment

D: ran out of space during dependency installation. Dependencies were installed on C: and exposed
through the ignored workspace `node_modules` junction. Failed installations were preserved in
temporary directories. Free space on D: remains low; restore adequate working space before a
large self-index or another local install. No unrelated project data was removed.
