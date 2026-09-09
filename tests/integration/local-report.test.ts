import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildRepository } from "../../src/compiler/build.js";
import {
  createLocalProofReport,
  writeLocalProofReport,
} from "../../src/report/local.js";
import { createTestRepository, type TestRepository } from "../helpers/repository.js";

const repositories: TestRepository[] = [];

afterEach(async () => {
  await Promise.all(repositories.splice(0).map((repository) => repository.remove()));
});

describe("local proof report", () => {
  it("writes reproducible metrics without source or prompt content", async () => {
    const repository = await createTestRepository();
    repositories.push(repository);
    await repository.write("src/service.ts", "export function charge(): boolean { return true; }\n");
    await repository.write("src/index.ts", "import { charge } from './service.js';\nexport const ready = charge();\n");
    await repository.git("add", ".");
    await repository.git("commit", "-m", "proof report fixture");
    await buildRepository(repository.root);

    const report = await createLocalProofReport(repository.root);
    expect(report).toMatchObject({
      schema_version: "1.0",
      repository: { commit: expect.stringMatching(/^[0-9a-f]{40}$/u) },
      index: { files: 2, synchronized: true },
      performance: { samples: 25 },
      privacy: {
        local_only: true,
        source_excerpt_included: false,
        query_or_prompt_text_included: false,
        raw_content_columns: [],
        indexed_sensitive_paths: 0,
        passed: true,
      },
    });
    expect(report.repository).not.toHaveProperty("url");
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain("function charge");
    const output = path.join(repository.root, "reports", "proof.json");
    await writeLocalProofReport(report, output);
    expect(JSON.parse(await readFile(output, "utf8"))).toEqual(report);
  });
});
