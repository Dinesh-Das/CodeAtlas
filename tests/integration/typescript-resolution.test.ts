import { afterEach, describe, expect, it } from "vitest";
import { initializeRepository } from "../../src/cli/init.js";
import { workspacePaths } from "../../src/core/workspace.js";
import { semanticCompilerInfo } from "../../src/graph/typescript-resolution.js";
import { openDatabase } from "../../src/storage/database.js";
import { createTestRepository, type TestRepository } from "../helpers/repository.js";

const repositories: TestRepository[] = [];

afterEach(async () => {
  await Promise.all(repositories.splice(0).map((repository) => repository.remove()));
});

describe("project-aware TypeScript resolution", () => {
  it("shares one fallback compiler program across configless source files", async () => {
    const repository = await createTestRepository();
    repositories.push(repository);
    for (const name of ["A", "B", "C"]) {
      await repository.write(
        `src/${name.toLowerCase()}.js`,
        [
          `export class ${name} { process() { return "${name}"; } }`,
          `export function run${name}() {`,
          `  const service = new ${name}();`,
          "  return service.process();",
          "}",
          "",
        ].join("\n"),
      );
    }
    await repository.git("add", ".");
    await repository.git("commit", "-m", "configless compiler project");

    const result = await initializeRepository(repository.root);
    expect(
      result.phaseMetrics.find((metric) => metric.phase === "typescript_project_discovery"),
    ).toMatchObject({ itemsProcessed: 1 });
    expect(
      result.phaseMetrics.find((metric) => metric.phase === "typescript_program_creation"),
    ).toMatchObject({ itemsProcessed: 1 });
  });

  it("prefers an explicit runtime module over a neighboring declaration file", async () => {
    const repository = await createTestRepository();
    repositories.push(repository);
    await repository.write(
      "src/index.js",
      "export default function runtimeEntry() { return true; }\n",
    );
    await repository.write(
      "src/index.d.ts",
      "export default function runtimeEntry(): boolean;\n",
    );
    await repository.write(
      "src/consumer.js",
      'import runtimeEntry from "./index.js";\nexport function run() { return runtimeEntry(); }\n',
    );
    await repository.git("add", ".");
    await repository.git("commit", "-m", "explicit runtime import");
    await initializeRepository(repository.root);

    const database = openDatabase(workspacePaths(repository.root).database, { readonly: true });
    try {
      const imports = database
        .prepare(
          `SELECT target.file_path AS targetFile, edges.provenance_category AS provenance
           FROM edges JOIN nodes target ON target.id = edges.target_node_id
           WHERE edges.edge_type = 'IMPORTS' AND edges.file_path = 'src/consumer.js'`,
        )
        .all();
      expect(imports).toEqual([{ targetFile: "src/index.js", provenance: "verified" }]);
      expect(
        database
          .prepare(
            `SELECT target.file_path AS targetFile, edges.provenance_category AS provenance
             FROM edges JOIN nodes target ON target.id = edges.target_node_id
             WHERE edges.edge_type = 'CALLS' AND edges.file_path = 'src/consumer.js'
               AND target.name = 'runtimeEntry'`,
          )
          .all(),
      ).toEqual([{ targetFile: "src/index.js", provenance: "verified" }]);
    } finally {
      database.close();
    }
  });

  it("falls back when a target TypeScript package lacks the required compiler API", async () => {
    const repository = await createTestRepository();
    repositories.push(repository);
    await repository.write(
      "node_modules/typescript/package.json",
      JSON.stringify({ name: "typescript", version: "7.0.2", main: "index.cjs" }),
    );
    await repository.write(
      "node_modules/typescript/index.cjs",
      'module.exports = { version: "7.0.2" };\n',
    );

    expect(semanticCompilerInfo(repository.root)).toMatchObject({
      source: "bundled",
      targetVersion: "7.0.2",
      fallbackReason: "incompatible_api",
    });
  });

  it("preserves exact compiler declaration identity for duplicate methods in one file", async () => {
    const repository = await createTestRepository();
    repositories.push(repository);
    await repository.write(
      "tsconfig.json",
      JSON.stringify({ compilerOptions: { target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext" } }),
    );
    await repository.write(
      "src/processors.ts",
      [
        "export class PaymentProcessor {",
        "  process(value: string): string { return value; }",
        "}",
        "export class RefundProcessor {",
        "  process(value: string): string { return value; }",
        "}",
        "export function checkout(): string {",
        "  const processor = new PaymentProcessor();",
        "  return processor.process('order');",
        "}",
        "",
      ].join("\n"),
    );
    await repository.git("add", ".");
    await repository.git("commit", "-m", "same-file semantic identity");
    await initializeRepository(repository.root);

    const database = openDatabase(workspacePaths(repository.root).database, { readonly: true });
    try {
      const calls = database
        .prepare(
          `SELECT target.qualified_name AS targetName,
                  target.start_line AS targetLine, edges.source_type AS sourceType
           FROM edges JOIN nodes target ON target.id = edges.target_node_id
           WHERE edges.edge_type = 'CALLS' AND edges.file_path = 'src/processors.ts'
             AND target.name = 'process'`,
        )
        .all();
      expect(calls).toEqual([
        { targetName: "PaymentProcessor.process", targetLine: 2, sourceType: "compiler" },
      ]);
    } finally {
      database.close();
    }
  });

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

  it("scopes hundreds of ambiguous method names before applying the candidate cap", async () => {
    const repository = await createTestRepository();
    repositories.push(repository);
    await repository.write(
      "tsconfig.json",
      JSON.stringify({
        compilerOptions: { target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext" },
        include: ["src/**/*.ts"],
      }),
    );
    for (let index = 0; index < 500; index += 1) {
      await repository.write(
        `src/services/service-${index}.ts`,
        `export class Service${index} { process(): number { return ${index}; } }\n`,
      );
    }
    await repository.write(
      "src/consumer.ts",
      [
        'import { Service499 } from "./services/service-499.js";',
        "export function run(): number {",
        "  const service: any = new Service499();",
        "  return service.process();",
        "}",
        "",
      ].join("\n"),
    );
    await repository.git("add", ".");
    await repository.git("commit", "-m", "ambiguous method scope");
    await initializeRepository(repository.root);

    const database = openDatabase(workspacePaths(repository.root).database, { readonly: true });
    try {
      const calls = database
        .prepare(
          `SELECT target.file_path AS targetFile
           FROM edges JOIN nodes target ON target.id = edges.target_node_id
           WHERE edges.edge_type = 'CALLS' AND edges.file_path = 'src/consumer.ts'
             AND target.name = 'process'`,
        )
        .all();
      expect(calls).toEqual([{ targetFile: "src/services/service-499.ts" }]);
    } finally {
      database.close();
    }
  }, 30_000);

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

  it("resolves wildcard package exports and ignores nested non-workspace manifests", async () => {
    const repository = await createTestRepository();
    repositories.push(repository);
    await repository.write(
      "package.json",
      JSON.stringify({ name: "workspace-root", private: true, workspaces: ["packages/*"] }),
    );
    await repository.write(
      "packages/core/package.json",
      JSON.stringify({
        name: "@company/core",
        private: true,
        exports: { "./*": "./src/*.ts" },
      }),
    );
    await repository.write(
      "packages/core/src/payments.ts",
      "export function charge(value: number): number { return value; }\n",
    );
    await repository.write(
      "packages/api/package.json",
      JSON.stringify({
        name: "@company/api",
        private: true,
        dependencies: { "@company/core": "workspace:*" },
      }),
    );
    await repository.write(
      "packages/api/src/main.ts",
      'import { charge } from "@company/core/payments";\nexport const result = charge(10);\n',
    );
    await repository.write(
      "vendor/embedded/package.json",
      JSON.stringify({ name: "@vendor/not-a-workspace", private: true }),
    );
    await repository.write("vendor/embedded/index.ts", "export const embedded = true;\n");
    await repository.git("add", ".");
    await repository.git("commit", "-m", "wildcard workspace exports");
    await initializeRepository(repository.root);

    const database = openDatabase(workspacePaths(repository.root).database, { readonly: true });
    try {
      expect(
        database
          .prepare(
            `SELECT target.file_path
             FROM edges JOIN nodes target ON target.id = edges.target_node_id
             WHERE edges.edge_type = 'IMPORTS'
               AND edges.file_path = 'packages/api/src/main.ts'`,
          )
          .pluck()
          .get(),
      ).toBe("packages/core/src/payments.ts");
      expect(
        database.prepare("SELECT name FROM nodes WHERE kind = 'package' ORDER BY name").pluck().all(),
      ).toEqual(["@company/api", "@company/core", "workspace-root"]);
    } finally {
      database.close();
    }
  });
});
