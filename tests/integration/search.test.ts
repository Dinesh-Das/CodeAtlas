import { afterEach, describe, expect, it } from "vitest";
import { initializeRepository } from "../../src/cli/init.js";
import { searchPacket } from "../../src/mcp/graph-tools.js";
import { ensureFreshIndex } from "../../src/mcp/freshness.js";
import { answerPacketSchema } from "../../src/mcp/schemas.js";
import { createTestRepository, type TestRepository } from "../helpers/repository.js";

const repositories: TestRepository[] = [];

afterEach(async () => {
  await Promise.all(repositories.splice(0).map((repository) => repository.remove()));
});

describe("developer-intent search", () => {
  it("normalizes natural questions and paginates beyond the candidate resource cap", async () => {
    const repository = await createTestRepository();
    repositories.push(repository);
    for (let index = 0; index < 250; index += 1) {
      const suffix = String(index).padStart(3, "0");
      await repository.write(
        `src/checkout-${suffix}.ts`,
        `export function checkoutFeature${suffix}(): number { return ${index}; }\n`,
      );
    }
    await repository.git("add", ".");
    await repository.git("commit", "-m", "large search fixture");
    await initializeRepository(repository.root);
    const context = await ensureFreshIndex(repository.root);

    const statements = new Set<string>();
    let cursor: string | null = null;
    for (let pageNumber = 0; pageNumber < 30; pageNumber += 1) {
      const page = answerPacketSchema.parse(
        searchPacket(context, {
          query: "How does checkout work?",
          cursor,
          limit: 50,
        }),
      );
      for (const fact of page.facts) statements.add(fact.statement);
      cursor = page.pagination.cursor;
      if (cursor === null) break;
    }

    expect(statements.size).toBeGreaterThanOrEqual(250);
    expect([...statements].some((statement) => statement.includes("checkoutFeature249"))).toBe(true);
    expect(cursor).toBeNull();
  });
});
