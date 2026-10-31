import { afterEach, describe, expect, it, vi } from "vitest";
import { compileChangeContext } from "../../src/context/planner.js";
import { serializeChangeContext, validateChangeContextGrounding } from "../../src/context/packet.js";
import { expandCompactContext } from "../../src/context/compact.js";
import { EvidenceExcerptReader } from "../../src/ir/evidence.js";
import { changeContextIr, evidenceIr } from "../../src/mcp/ir-tools.js";
import type { CompactChangeContext } from "../../src/context/compact.js";
import { initializeRepository } from "../../src/cli/init.js";
import { createTestRepository, type TestRepository } from "../helpers/repository.js";

const repositories: TestRepository[] = [];

afterEach(async () => {
  await Promise.all(repositories.splice(0).map((repository) => repository.remove()));
});

function referencedEvidenceIds(value: unknown): string[] {
  if (value === null || typeof value !== "object") return [];
  if (Array.isArray(value)) return value.flatMap(referencedEvidenceIds);
  const record = value as Record<string, unknown>;
  return [
    ...(Array.isArray(record.evidence_ids)
      ? record.evidence_ids.filter((id): id is string => typeof id === "string")
      : []),
    ...Object.entries(record)
      .filter(([key]) => key !== "evidence" && key !== "evidence_ids")
      .flatMap(([, child]) => referencedEvidenceIds(child)),
  ];
}

async function contextRepository(): Promise<TestRepository> {
  const repository = await createTestRepository();
  repositories.push(repository);
  await repository.write("package.json", JSON.stringify({
    scripts: { test: "vitest run", typecheck: "tsc --noEmit", lint: "oxlint src" },
  }, null, 2));
  await repository.write("src/auth/service.ts", [
    "export function authenticate(password: string): boolean {",
    "  return password.length >= 8;",
    "}",
    "",
  ].join("\n"));
  await repository.write("src/auth/http.ts", [
    'import express from "express";',
    'import { authenticate } from "./service.js";',
    "const app = express();",
    "export function login(password: string): boolean { return authenticate(password); }",
    'app.post("/login", login);',
    "",
  ].join("\n"));
  await repository.write("tests/auth.test.ts", [
    'import { authenticate } from "../src/auth/service.js";',
    'export function authenticationTest(): boolean { return authenticate("password"); }',
    "",
  ].join("\n"));
  await repository.write("src/duplicate-a.ts", "export function duplicate(): string { return 'a'; }\n");
  await repository.write("src/duplicate-b.ts", "export function duplicate(): string { return 'b'; }\n");
  await repository.write("README.md", [
    "# Fixture repository",
    "",
    "The prepare_change workflow gives agents implementation context.",
    "",
  ].join("\n"));
  await repository.write("docs/adrs/0001-unrelated.md", [
    "# Use a separate analytics warehouse",
    "",
    "Status: Accepted",
    "",
    "## Decision",
    "Analytics data stays outside the authentication service.",
    "",
  ].join("\n"));
  await repository.git("add", ".");
  await repository.git("commit", "-m", "context fixture");
  await initializeRepository(repository.root);
  return repository;
}

describe("task-context compiler", () => {
  it("does not hydrate source during warm reference-mode MCP retrieval and fetches current proof", async () => {
    const repository = await contextRepository();
    // Building the canonical graph needs source; measure disclosure after that required work.
    await changeContextIr(repository.root, "Change `authenticate`", 8_000, {
      format: "compact", evidenceMode: "references",
    });
    const reads = vi.spyOn(EvidenceExcerptReader.prototype, "read");
    try {
      const result = await changeContextIr(repository.root, "Change `authenticate`", 8_000, {
        format: "compact", evidenceMode: "references",
      });
      expect(reads).not.toHaveBeenCalled();
      const packet = expandCompactContext(result as unknown as CompactChangeContext);
      const proof = packet.evidence.find((item) => item.file === "src/auth/service.ts")!;
      expect(proof.deferred).toBe(true);
      expect(proof.excerpt).toBeNull();
      await repository.write("src/auth/service.ts", "export function authenticate(password: string): boolean { return password.length >= 12; }\n");
      const freshPacket = expandCompactContext(await changeContextIr(repository.root, "Change `authenticate`", 8_000, {
        format: "compact", evidenceMode: "references",
      }) as unknown as CompactChangeContext);
      expect(freshPacket.snapshot.fingerprint).not.toBe(packet.snapshot.fingerprint);
      const currentProof = freshPacket.evidence.find((item) => item.file === proof.file)!;
      expect(currentProof.file_content_hash).not.toBe(proof.file_content_hash);
      reads.mockClear();
      const source = await evidenceIr(repository.root, currentProof.id);
      expect(reads).toHaveBeenCalled();
      expect(JSON.stringify(source)).toContain("password.length >= 12");
    } finally {
      reads.mockRestore();
    }
  });

  it("provides a bounded compact brief with named paths and explicitly deferred source", async () => {
    const repository = await contextRepository();
    const packet = await compileChangeContext(
      "Change `authenticate` and identify its callers and affected tests",
      repository.root,
      { budget: 8_000, format: "compact", evidenceMode: "references" },
    );
    expect(packet.evidence_mode).toBe("references");
    expect(packet.change_candidates[0]?.symbol.name).toBe("authenticate");
    expect(packet.relevant_tests.map((test) => test.symbol.file)).toContain("tests/auth.test.ts");
    expect(packet.evidence.length).toBeGreaterThan(0);
    expect(packet.evidence.every((item) => item.deferred && item.excerpt === null)).toBe(true);
    expect(packet.evidence.every((item) => "file_content_hash" in item)).toBe(true);
    expect(validateChangeContextGrounding(packet)).toEqual([]);
    expect(packet.verified_paths.length).toBeGreaterThan(0);
    const namedIds = new Set([
      ...packet.change_candidates.map((item) => item.symbol.id),
      ...packet.relevant_tests.map((item) => item.symbol.id),
      ...packet.affected_contracts.map((item) => item.symbol.id),
      ...(packet.path_symbols ?? []).map((item) => item.id),
    ]);
    expect(packet.verified_paths.every((item) => item.symbol_ids.every((id) => namedIds.has(id)))).toBe(true);
    const serialized = serializeChangeContext(packet, "compact");
    expect(Buffer.byteLength(serialized)).toBe(packet.budget.used);
    expect(packet.budget.used).toBeLessThanOrEqual(8_000);
    expect(expandCompactContext(JSON.parse(serialized))).toEqual(packet);
  });

  it("keeps ambiguity and unsupported coverage visible in compact briefs", async () => {
    const repository = await contextRepository();
    const ambiguous = await compileChangeContext("Rename `duplicate`", repository.root, {
      budget: 5_000, format: "compact", evidenceMode: "references",
    });
    expect(ambiguous.gaps.some((gap) => gap.code === "ambiguous_target")).toBe(true);
    const unsupported = await compileChangeContext("Change the quantum payroll reconciler", repository.root, {
      budget: 3_000, format: "compact", evidenceMode: "references",
    });
    expect(unsupported.change_candidates).toEqual([]);
    expect(unsupported.gaps.some((gap) => gap.code === "unsupported_coverage")).toBe(true);
  });

  it("returns a grounded, diverse implementation brief inside a conservative budget", async () => {
    const repository = await contextRepository();
    const packet = await compileChangeContext(
      "Add rate limiting around `authenticate` and identify affected tests",
      repository.root,
      { budget: 6_000, format: "json" },
    );

    expect(packet.budget).toMatchObject({
      requested: 6_000,
      unit: "utf8_bytes_upper_bound",
      estimator: "utf8-bytes-upper-bound/v1",
      format: "json",
    });
    expect(packet.budget.used).toBeLessThanOrEqual(packet.budget.requested);
    expect(Buffer.byteLength(serializeChangeContext(packet, "json"), "utf8"))
      .toBeLessThanOrEqual(packet.budget.requested);
    expect(packet.change_candidates).toEqual(expect.arrayContaining([
      expect.objectContaining({
        symbol: expect.objectContaining({ name: "authenticate", file: "src/auth/service.ts" }),
        retrieval_reasons: expect.arrayContaining([expect.stringMatching(/exact symbol|FTS match/u)]),
        recommendation: expect.objectContaining({ fact_class: "inference", action: "modify" }),
        supporting_paths: expect.any(Array),
      }),
    ]));
    expect(packet.relevant_tests.map((item) => item.symbol.file)).toContain("tests/auth.test.ts");
    expect(packet.edit_locations).toEqual(expect.arrayContaining([
      expect.objectContaining({ file: "src/auth/service.ts", action: "modify" }),
    ]));
    expect(packet.validation_commands.map((item) => item.command)).toContain("npm run test");
    expect(packet.constraints.some((item) => item.kind === "decision")).toBe(false);
    expect(packet.verification_checklist).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "edit_location", status: "pending" }),
      expect.objectContaining({ kind: "command", id: "command:validation" }),
    ]));
    const selectedEvidence = new Set(packet.evidence.map((item) => item.id));
    expect(referencedEvidenceIds(packet).every((id) => selectedEvidence.has(id))).toBe(true);
    expect(packet.evidence.every((item) => item.trust === "untrusted_repository_content")).toBe(true);
  }, 30_000);

  it("returns architecture candidates and a precise gap for an underspecified task", async () => {
    const repository = await contextRepository();
    const packet = await compileChangeContext("Fix the bug", repository.root, {
      budget: 4_000,
      format: "markdown",
    });

    expect(packet.change_candidates.length).toBeGreaterThan(0);
    expect(packet.gaps).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "insufficient_task_specificity" }),
    ]));
    expect(Buffer.byteLength(serializeChangeContext(packet, "markdown"), "utf8"))
      .toBeLessThanOrEqual(4_000);
  }, 30_000);

  it("keeps duplicate symbol targets ambiguous", async () => {
    const repository = await contextRepository();
    const packet = await compileChangeContext("Rename `duplicate` without changing behavior", repository.root, {
      budget: 5_000,
      format: "json",
    });

    const gap = packet.gaps.find((item) => item.code === "ambiguous_target");
    expect(gap).toMatchObject({ code: "ambiguous_target", target: "duplicate" });
    expect(gap?.candidate_ids).toHaveLength(2);
  }, 30_000);

  it("seeds candidates from a Git-base change context", async () => {
    const repository = await contextRepository();
    await repository.write("src/auth/service.ts", [
      "export function authenticate(password: string): boolean {",
      "  return password.trim().length >= 10;",
      "}",
      "",
    ].join("\n"));

    const packet = await compileChangeContext("Review the current implementation changes", repository.root, {
      budget: 5_000,
      format: "json",
      gitBase: "HEAD",
    });

    expect(packet.snapshot.id).toMatch(/^worktree-/u);
    expect(packet.change_candidates).toEqual(expect.arrayContaining([
      expect.objectContaining({
        symbol: expect.objectContaining({ name: "authenticate" }),
        retrieval_reasons: expect.arrayContaining(["changed symbol"]),
      }),
    ]));
  }, 30_000);

  it("resolves root documentation files and applies scoped human knowledge", async () => {
    const repository = await contextRepository();
    const documentation = await compileChangeContext(
      "Document the prepare_change workflow in README.md",
      repository.root,
      { budget: 8_000, format: "json" },
    );
    expect(documentation.intent).toMatchObject({
      kind: "documentation",
      explicit_files: expect.arrayContaining(["README.md"]),
    });
    expect(documentation.change_candidates[0]?.symbol.file).toBe("README.md");

    await repository.write(".codeatlas.yml", [
      "version: 1",
      "architecture:",
      "  rules:",
      "    - id: auth-boundary",
      "      description: Authentication must not call legacy code",
      "      source:",
      "        matches_path: src/auth/",
      "      forbid:",
      "        calls:",
      "          matches_path: src/legacy/",
      "knowledge:",
      "  owners:",
      "    - id: authentication",
      "      owner: identity-team",
      "      purpose: Authenticate users",
      "      include: [src/auth/**]",
      "      entrypoint: authenticate",
      "      validation_command: npm run test",
      "  invariants:",
      "    - id: passwords-never-logged",
      "      statement: Passwords never enter logs",
      "      applies_to: [src/auth/**]",
      "  canonical_names:",
      "    - symbol: authenticate",
      "      name: credential verification",
      "",
    ].join("\n"));
    const knowledge = await compileChangeContext(
      "Change credential verification",
      repository.root,
      { budget: 12_000, format: "json" },
    );
    expect(knowledge.change_candidates[0]?.symbol.name).toBe("authenticate");
    expect(knowledge.constraints).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "knowledge_owner", summary: expect.stringContaining("identity-team") }),
      expect.objectContaining({ kind: "architecture_rule", summary: expect.stringContaining("legacy code") }),
    ]));
    expect(knowledge.invariants).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "passwords-never-logged", source: "human_config" }),
    ]));
    expect(knowledge.validation_commands).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "knowledge-validation:authentication", command: "npm run test" }),
    ]));
  }, 30_000);
});
