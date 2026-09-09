import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadV2Config, normalizeV2Config, parseCodeAtlasYaml } from "../../src/rules/config.js";

const roots: string[] = [];

afterEach(async () => {
  delete process.env.CODEATLAS_AI_ENABLED;
  delete process.env.CODEATLAS_HTML_MODE;
  delete process.env.CODEATLAS_MAX_CALL_DEPTH;
  delete process.env.CODEATLAS_MAX_IMPACT_DEPTH;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe(".codeatlas.yml", () => {
  it("keeps AI provider functionality disabled unless explicitly opted in", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codeatlas-v2-config-defaults-"));
    roots.push(root);
    expect(normalizeV2Config({}).ai.enabled).toBe(false);
    await expect(loadV2Config(root)).resolves.toMatchObject({ ai: { enabled: false } });

    process.env.CODEATLAS_AI_ENABLED = "definitely";
    await expect(loadV2Config(root)).rejects.toThrow("CODEATLAS_AI_ENABLED must be true/false or 1/0");
  });

  it("parses domain overrides and nested architecture rules", () => {
    const config = normalizeV2Config(parseCodeAtlasYaml(`
version: 1
index:
  exclude:
    - generated/**
domains:
  authentication:
    include:
      - src/auth/**
architecture:
  rules:
    - id: no-controller-repository
      severity: error
      source:
        layer: controller
      forbid:
        calls:
          layer: repository
`));
    expect(config.index.exclude).toEqual(["generated/**"]);
    expect(config.domains.authentication?.include).toEqual(["src/auth/**"]);
    expect(config.architecture.rules).toEqual([
      expect.objectContaining({
        id: "no-controller-repository",
        severity: "error",
        source: { layer: "controller" },
        forbid: { calls: { layer: "repository" } },
      }),
    ]);
  });

  it("parses team-pinned owners, journeys, invariants, and canonical names", () => {
    const config = normalizeV2Config(parseCodeAtlasYaml(`
knowledge:
  max_documentation_age_days: 90
  owners:
    - id: authentication
      owner: identity-team
      purpose: Authenticate users
      include: [src/auth/**]
      entrypoint: login
      contracts: [POST login]
      validation_command: npm run test:auth
  journeys:
    - id: login-request
      name: Login request
      purpose: Issue a session
      entrypoint: login
  invariants:
    - id: passwords-never-logged
      statement: Passwords never enter logs
      applies_to: [src/auth/**]
  canonical_names:
    - symbol: login
      name: Login entrypoint
`));

    expect(config.knowledge).toMatchObject({
      max_documentation_age_days: 90,
      owners: [expect.objectContaining({ id: "authentication", owner: "identity-team" })],
      journeys: [expect.objectContaining({ id: "login-request", entrypoint: "login" })],
      invariants: [expect.objectContaining({ id: "passwords-never-logged" })],
      canonical_names: [{ symbol: "login", name: "Login entrypoint" }],
    });
  });

  it("rejects invalid ranges, modes, and credential-like config fields", () => {
    expect(() => normalizeV2Config(parseCodeAtlasYaml("version: 2\n"))).toThrow("version must be 1");
    expect(() => normalizeV2Config(parseCodeAtlasYaml("analysis:\n  max_call_depth: 0\n")))
      .toThrow("between 1 and 100");
    expect(() => normalizeV2Config(parseCodeAtlasYaml("html:\n  mode: remote\n")))
      .toThrow("single-file or bundle");
    expect(() => normalizeV2Config(parseCodeAtlasYaml("html:\n  max_single_file_bytes: 10\n")))
      .toThrow("between 1048576 and 1073741824");
    expect(() => normalizeV2Config(parseCodeAtlasYaml("ai:\n  enabled: true\n  api_key: secret\n")))
      .toThrow("Keep credentials and secrets in environment variables");
  });

  it("applies safe environment overrides without storing secrets", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codeatlas-v2-config-"));
    roots.push(root);
    await mkdir(root, { recursive: true });
    await writeFile(path.join(root, ".codeatlas.yml"), [
      "version: 1",
      "analysis:",
      "  max_call_depth: 8",
      "html:",
      "  mode: single-file",
      "ai:",
      "  enabled: false",
      "",
    ].join("\n"), "utf8");
    process.env.CODEATLAS_AI_ENABLED = "true";
    process.env.CODEATLAS_HTML_MODE = "bundle";
    process.env.CODEATLAS_MAX_CALL_DEPTH = "12";
    const config = await loadV2Config(root);
    expect(config.ai.enabled).toBe(true);
    expect(config.html.mode).toBe("bundle");
    expect(config.analysis.max_call_depth).toBe(12);
  });
});
