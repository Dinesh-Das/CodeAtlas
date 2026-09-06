import { afterEach, describe, expect, it } from "vitest";
import { compileChangeContext } from "../../src/context/planner.js";
import { serializeChangeContext } from "../../src/context/packet.js";
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
  await repository.git("add", ".");
  await repository.git("commit", "-m", "context fixture");
  await initializeRepository(repository.root);
  return repository;
}

describe("task-context compiler", () => {
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
});
