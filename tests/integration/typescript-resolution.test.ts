import { afterEach, describe, expect, it } from "vitest";
import { initializeRepository } from "../../src/cli/init.js";
import { workspacePaths } from "../../src/core/workspace.js";
import { openDatabase } from "../../src/storage/database.js";
import { createTestRepository, type TestRepository } from "../helpers/repository.js";

const repositories: TestRepository[] = [];

afterEach(async () => {
  await Promise.all(repositories.splice(0).map((repository) => repository.remove()));
});

describe("project-aware TypeScript resolution", () => {
  it("resolves tsconfig paths and uses receiver types for duplicated method names", async () => {
    const repository = await createTestRepository();
    repositories.push(repository);
    await repository.write(
      "tsconfig.json",
      JSON.stringify({
        compilerOptions: {
          target: "ES2022",
          module: "NodeNext",
          moduleResolution: "NodeNext",
          baseUrl: ".",
          paths: { "@app/*": ["src/*"] },
        },
        include: ["src/**/*.ts"],
      }),
    );
    await repository.write(
      "src/payment.ts",
      "export class PaymentService { process(order: string): string { return order; } }\n",
    );
    await repository.write(
      "src/other.ts",
      "export class OtherService { process(value: number): number { return value; } }\n",
    );
    await repository.write(
      "src/domain/index.ts",
      'export { PaymentService } from "../payment.js";\n',
    );
    await repository.write(
      "src/checkout.ts",
      [
        'import { PaymentService } from "@app/domain";',
        "const paymentService = new PaymentService();",
        'export function checkout(): string { return paymentService.process("order"); }',
        "",
      ].join("\n"),
    );
    await repository.git("add", ".");
    await repository.git("commit", "-m", "typescript aliases");
    await initializeRepository(repository.root);

    const database = openDatabase(workspacePaths(repository.root).database, { readonly: true });
    try {
      const imported = database
        .prepare(
          `SELECT target.file_path AS targetFile
           FROM edges JOIN nodes target ON target.id = edges.target_node_id
           WHERE edges.edge_type = 'IMPORTS' AND edges.file_path = 'src/checkout.ts'`,
        )
        .get() as { targetFile: string };
      expect(imported.targetFile).toBe("src/domain/index.ts");

      const calls = database
        .prepare(
          `SELECT target.file_path AS targetFile, target.qualified_name AS targetName,
                  edges.source_type AS sourceType, edges.provenance_category AS provenance
           FROM edges JOIN nodes target ON target.id = edges.target_node_id
           WHERE edges.edge_type = 'CALLS' AND edges.file_path = 'src/checkout.ts'
             AND target.name = 'process'`,
        )
        .all() as Array<{
          targetFile: string;
          targetName: string;
          sourceType: string;
          provenance: string;
        }>;
      expect(calls).toEqual([
        expect.objectContaining({
          targetFile: "src/payment.ts",
          sourceType: "compiler",
          provenance: "verified",
        }),
      ]);
    } finally {
      database.close();
    }
  });

  it("resolves workspace package exports and persists package boundaries", async () => {
    const repository = await createTestRepository();
    repositories.push(repository);
    await repository.write(
      "package.json",
      JSON.stringify({ name: "workspace-root", private: true, workspaces: ["apps/*", "packages/*"] }),
    );
    await repository.write(
      "packages/core/package.json",
      JSON.stringify({
        name: "@company/core",
        private: true,
        exports: { ".": "./src/index.ts" },
      }),
    );
    await repository.write(
      "packages/core/src/index.ts",
      "export function charge(value: number): number { return value; }\n",
    );
    await repository.write(
      "apps/api/package.json",
      JSON.stringify({
        name: "@company/api",
        private: true,
        dependencies: { "@company/core": "workspace:*" },
      }),
    );
    await repository.write(
      "apps/api/src/main.ts",
      'import { charge } from "@company/core";\nexport const result = charge(10);\n',
    );
    await repository.git("add", ".");
    await repository.git("commit", "-m", "workspace packages");
    await initializeRepository(repository.root);

    const database = openDatabase(workspacePaths(repository.root).database, { readonly: true });
    try {
      const imported = database
        .prepare(
          `SELECT target.file_path AS targetFile
           FROM edges JOIN nodes target ON target.id = edges.target_node_id
           WHERE edges.edge_type = 'IMPORTS' AND edges.file_path = 'apps/api/src/main.ts'`,
        )
        .get() as { targetFile: string };
      expect(imported.targetFile).toBe("packages/core/src/index.ts");
      const packages = database
        .prepare("SELECT name FROM nodes WHERE kind = 'package' ORDER BY name")
        .all()
        .map((row) => (row as { name: string }).name);
      expect(packages).toEqual(["@company/api", "@company/core", "workspace-root"]);
      const dependency = database
        .prepare(
          `SELECT source.name AS source, target.name AS target
           FROM edges
           JOIN nodes source ON source.id = edges.source_node_id
           JOIN nodes target ON target.id = edges.target_node_id
           WHERE edges.edge_type = 'DEPENDS_ON' AND source.kind = 'package'`,
        )
        .get();
      expect(dependency).toEqual({ source: "@company/api", target: "@company/core" });
    } finally {
      database.close();
    }
  });
});
