# Releasing CodeAtlas

CodeAtlas publishes the public npm package `@dinesh-das/codeatlas` from
`.github/workflows/release.yml`. The package is scoped because the unscoped `codeatlas` name is
owned by an unrelated project. The installed executable is still `codeatlas`.

- npm: <https://www.npmjs.com/package/@dinesh-das/codeatlas>
- GitHub: <https://github.com/Dinesh-Das/CodeAtlas>

## One-time npm setup

1. Create or obtain publish access to the npm scope `@dinesh-das`.
2. In the npm package settings, configure a GitHub Actions trusted publisher for repository
   `Dinesh-Das/CodeAtlas` and workflow filename `release.yml`.
3. Do not add a long-lived npm automation token. The workflow uses GitHub OIDC with
   `id-token: write`; npm generates provenance automatically for eligible public packages.

## Release checklist

1. Update `package.json`, `package-lock.json`, `src/version.ts`, and `CHANGELOG.md` to the same
   semantic version.
2. Run `npm ci` followed by `npm run release:check`. For a stable version, populate
   `release-evidence.json` and run `npm run stable:check`; the stable gate requires at least ten
   independent repositories, all supported operating systems and languages, clean install/index/
   overview/agent-question paths, relationship-quality thresholds, and the large-repository budget.
   Generate each repository record from a clean committed checkout with
   `npm run validate:repository -- --repository /absolute/path --id UNIQUE_AUDIT_ID`, then review
   and append its JSON output to `independentRepositories`. The validator packs the current
   CodeAtlas artifact, installs that exact tarball in a disposable consumer, clones the target,
   exercises the installed CLI and public agent API, and records the target commit, CodeAtlas
   version, validation time, and atlas SHA-256. Never count CodeAtlas itself or a development
   fixture as an independent repository.
   Maintainers can run the same operation from **Actions → Stable Release Evidence**. Select an
   independent HTTPS repository, immutable branch/tag, unique audit ID, and runner; the pinned,
   least-privilege workflow uploads the validated JSON record for review. Use all three runners
   across the evidence set and never execute the target repository's install scripts.
3. Commit the release changes and push them through the normal review process.
4. Before a prerelease, verify that npm's `latest` tag is absent or points to a stable version. If
   an older prerelease was accidentally published to `latest`, remove that dist-tag in npm before
   continuing; the release workflow blocks instead of silently preserving an unsafe default channel.
5. Create and push a tag named exactly `v<package version>`, such as `v0.10.0-beta.1`.
6. Confirm the `npm Release` workflow succeeds and verify the published package metadata and
   provenance on npm.
7. Verify the public artifact directly with
   `npx --yes --package=@dinesh-das/codeatlas@<version> codeatlas --version`.

Published npm versions are immutable. Never reuse a version after `npm publish` succeeds; correct
the issue in a new semantic version and update all four version sources before tagging it.

The workflow refuses to publish when the Git tag and package version differ. Every release tag
reruns checks and package installation on Linux, macOS, and Windows with Node.js 22.12 and 24,
plus coverage, dependency audit, CodeQL, and the release-evidence gate. The publish job cannot run
until all of them pass. It builds from a clean `dist/`, publishes with explicit provenance, and
uses pinned action commits. The package smoke test installs the exact npm tarball into a disposable
Git repository, invokes the installed binary, initializes CodeAtlas, and verifies synchronized status.
Prerelease versions publish under their prerelease identifier (`beta`, `rc`, and so on) rather
than npm's `latest` dist-tag. Stable versions publish to `latest`.
