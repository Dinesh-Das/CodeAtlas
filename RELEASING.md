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
2. Run `npm ci` followed by `npm run release:check`.
3. Commit the release changes and push them through the normal review process.
4. Create and push a tag named exactly `v<package version>`, such as `v0.10.0-beta.1`.
5. Confirm the `npm Release` workflow succeeds and verify the published package metadata and
   provenance on npm.
6. Verify the public artifact directly with
   `npx --yes --package=@dinesh-das/codeatlas@<version> codeatlas --version`.

Published npm versions are immutable. Never reuse a version after `npm publish` succeeds; correct
the issue in a new semantic version and update all four version sources before tagging it.

The workflow refuses to publish when the Git tag and package version differ. The release check
also builds from a clean `dist/`, packs the exact npm tarball, installs it into a disposable Git
repository, invokes the installed binary, initializes CodeAtlas, and verifies synchronized status.
Prerelease versions publish under their prerelease identifier (`beta`, `rc`, and so on) rather
than npm's `latest` dist-tag. Stable versions publish to `latest`.
