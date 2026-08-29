import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { initializeRepository } from "../../src/cli/init.js";
import { getOverview, formatOverview } from "../../src/cli/overview.js";
import { setupRepository } from "../../src/cli/setup.js";
import { createTestRepository, type TestRepository } from "../helpers/repository.js";

const repositories: TestRepository[] = [];

afterEach(async () => {
  await Promise.all(repositories.splice(0).map((repository) => repository.remove()));
});

describe("setup and direct overview", () => {
  it("merges workspace MCP configuration without replacing existing servers", async () => {
    const repository = await createTestRepository();
    repositories.push(repository);
    await repository.write("src/index.ts", "export const ready = true;\n");
    await repository.write(
      ".cursor/mcp.json",
      `${JSON.stringify({ mcpServers: { existing: { command: "existing-server" } } }, null, 2)}\n`,
    );
    await repository.git("add", ".");
    await repository.git("commit", "-m", "setup fixture");
    await initializeRepository(repository.root);

    const result = await setupRepository(repository.root, {
      targets: ["cursor", "antigravity"],
    });
    expect(result.targets.map((target) => target.status)).toEqual(["configured", "configured"]);
    const cursor = JSON.parse(
      await readFile(path.join(repository.root, ".cursor", "mcp.json"), "utf8"),
    ) as { mcpServers: Record<string, unknown> };
    expect(cursor.mcpServers).toMatchObject({
      existing: { command: "existing-server" },
      codeatlas: {
        type: "stdio",
        command: "codeatlas",
        args: ["mcp", "${workspaceFolder}"],
      },
    });
    const antigravity = JSON.parse(
      await readFile(path.join(repository.root, ".agents", "mcp_config.json"), "utf8"),
    ) as { mcpServers: Record<string, unknown> };
    expect(antigravity.mcpServers.codeatlas).toMatchObject({
      command: "codeatlas",
      args: ["mcp", repository.root],
      cwd: repository.root,
    });
    await expect(setupRepository(repository.root, {
      targets: ["cursor", "antigravity"],
    })).resolves.toMatchObject({
      targets: [
        { target: "cursor", status: "already_configured" },
        { target: "antigravity", status: "already_configured" },
      ],
    });
  });

  it("plans CLI integrations without requiring the clients and prints an immediate overview", async () => {
    const repository = await createTestRepository();
    repositories.push(repository);
    await repository.write("src/index.ts", "export function main(): boolean { return true; }\n");
    await repository.git("add", ".");
    await repository.git("commit", "-m", "overview fixture");
    await initializeRepository(repository.root);

    await expect(setupRepository(repository.root, {
      targets: ["codex", "claude"],
      dryRun: true,
    })).resolves.toMatchObject({
      targets: [
        { target: "codex", status: "planned" },
        { target: "claude", status: "planned" },
      ],
    });
    const overview = await getOverview(repository.root);
    expect(overview).toMatchObject({ files: 1 });
    expect(formatOverview(overview)).toContain("Ask your coding agent");
  });
});
