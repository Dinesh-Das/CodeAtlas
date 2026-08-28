import { afterEach, describe, expect, it } from "vitest";
import { workspaceManifestPaths } from "../../src/core/workspace-packages.js";
import { createTestRepository, type TestRepository } from "../helpers/repository.js";

const repositories: TestRepository[] = [];

afterEach(async () => {
  await Promise.all(repositories.splice(0).map((repository) => repository.remove()));
});

describe("workspace package patterns", () => {
  it("supports brace, globstar, extglob, and exclusion patterns", async () => {
    const repository = await createTestRepository();
    repositories.push(repository);
    await repository.write(
      "package.json",
      JSON.stringify({
        name: "root",
        private: true,
        workspaces: [
          "{apps,packages}/*",
          "plugins/**/+(official|community)/*",
          "!packages/excluded",
        ],
      }),
    );
    const indexedPaths = new Set([
      "package.json",
      "apps/api/package.json",
      "packages/core/package.json",
      "packages/excluded/package.json",
      "plugins/backend/official/auth/package.json",
      "plugins/backend/community/cache/package.json",
      "plugins/backend/private/internal/package.json",
      "vendor/nested/package.json",
    ]);
    expect([...workspaceManifestPaths(repository.root, indexedPaths)].sort()).toEqual([
      "apps/api/package.json",
      "package.json",
      "packages/core/package.json",
      "plugins/backend/community/cache/package.json",
      "plugins/backend/official/auth/package.json",
    ]);
  });
});
