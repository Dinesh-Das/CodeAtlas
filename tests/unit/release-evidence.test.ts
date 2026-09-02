import { describe, expect, it } from "vitest";
import {
  STABLE_RELEASE_BUDGETS,
  validateStableReleaseEvidence,
  type ReleaseEvidence,
} from "../../src/release/evidence.js";

function validEvidence(): ReleaseEvidence {
  return {
    schemaVersion: 2,
    targetVersion: "1.0.0",
    releaseArtifact: {
      codeAtlasVersion: "1.0.0",
      packageSha256: "f".repeat(64),
      packedFileCount: 500,
    },
    independentRepositories: Array.from({ length: 10 }, (_, index) => ({
      id: `repository-${index}`,
      repository: `https://example.com/organization/repository-${index}`,
      commit: `${index}`.padStart(40, "a"),
      validatedAt: new Date().toISOString(),
      codeAtlasVersion: "1.0.0-rc.1",
      atlasSha256: `${index}`.padStart(64, "a"),
      operatingSystem: (["linux", "macos", "windows"] as const)[index % 3]!,
      languages: (["typescript", "javascript", "python"] as const).filter(
        (_, languageIndex) => languageIndex === index % 3,
      ),
      checks: {
        install: true,
        index: true,
        overview: true,
        agentQuestion: true,
        noIndexingFailures: true,
      },
      verifiedRelationshipPercent: 70,
      unresolvedRelationshipPercent: 10,
    })),
    largeRepositoryBenchmark: {
      repository: "large/repository",
      commit: "a".repeat(40),
      validatedAt: new Date().toISOString(),
      codeAtlasVersion: "1.0.0-rc.1",
      trackedLoc: STABLE_RELEASE_BUDGETS.minimumTrackedLoc,
      coldIndexMs: STABLE_RELEASE_BUDGETS.maximumColdIndexMs,
      peakRssMiB: STABLE_RELEASE_BUDGETS.maximumPeakRssMiB,
      databaseMiB: STABLE_RELEASE_BUDGETS.maximumDatabaseMiB,
      searchP95Ms: STABLE_RELEASE_BUDGETS.maximumSearchP95Ms,
      impactP95Ms: STABLE_RELEASE_BUDGETS.maximumImpactP95Ms,
      freshnessP95Ms: STABLE_RELEASE_BUDGETS.maximumFreshnessP95Ms,
    },
  };
}

function validate(version: string, evidence: ReleaseEvidence) {
  return validateStableReleaseEvidence(version, evidence, evidence.releaseArtifact);
}

describe("stable release evidence", () => {
  it("accepts a complete independent validation matrix", () => {
    expect(validate("1.0.0", validEvidence())).toEqual({
      ready: true,
      repositoryCount: 10,
      errors: [],
    });
  });

  it("blocks stable release when the external corpus or performance budgets are incomplete", () => {
    const evidence = validEvidence();
    evidence.independentRepositories = evidence.independentRepositories.slice(0, 2);
    evidence.largeRepositoryBenchmark!.peakRssMiB += 1;
    const result = validate("1.0.0", evidence);
    expect(result.ready).toBe(false);
    expect(result.errors).toEqual(expect.arrayContaining([
      expect.stringContaining("2/10"),
      expect.stringContaining("peak RSS budget"),
    ]));
  });

  it("rejects evidence prepared for a different stable version", () => {
    const evidence = validEvidence();
    expect(validate("1.1.0-rc.1", evidence).errors).toContain(
      "Evidence targets 1.0.0, but the release base version is 1.1.0.",
    );
  });

  it("binds stable evidence to the exact packed artifact", () => {
    const evidence = validEvidence();
    const result = validateStableReleaseEvidence("1.0.0", evidence, {
      codeAtlasVersion: "1.0.1",
      packageSha256: "e".repeat(64),
      packedFileCount: 501,
    });
    expect(result.errors).toEqual(expect.arrayContaining([
      expect.stringContaining("SHA-256"),
      expect.stringContaining("file count"),
      expect.stringContaining("Produced package reports 1.0.1"),
    ]));
  });

  it("rejects duplicate origins and self-validation", () => {
    const duplicateEvidence = validEvidence();
    duplicateEvidence.independentRepositories[1]!.repository =
      duplicateEvidence.independentRepositories[0]!.repository;
    expect(validate("1.0.0", duplicateEvidence).errors).toEqual(
      expect.arrayContaining([
        "Independent repository origins must be unique.",
        expect.stringContaining("9/10"),
      ]),
    );

    const selfEvidence = validEvidence();
    selfEvidence.independentRepositories[0]!.repository =
      "https://github.com/Dinesh-Das/CodeAtlas.git";
    expect(validate("1.0.0", selfEvidence).errors).toContain(
      "CodeAtlas cannot count as an independent repository validation.",
    );
  });

  it("rejects stale validation records", () => {
    const evidence = validEvidence();
    evidence.independentRepositories[0]!.validatedAt = "2020-01-01T00:00:00.000Z";
    expect(validate("1.0.0", evidence).errors).toContain(
      "repository-0 validation is outside the 90-day evidence window.",
    );
  });

  it("rejects stale or cross-release benchmark evidence", () => {
    const evidence = validEvidence();
    evidence.largeRepositoryBenchmark!.validatedAt = "2020-01-01T00:00:00.000Z";
    evidence.largeRepositoryBenchmark!.codeAtlasVersion = "2.0.0";
    expect(validate("1.0.0", evidence).errors).toEqual(
      expect.arrayContaining([
        expect.stringContaining("benchmark is outside"),
        expect.stringContaining("benchmark used 2.0.0"),
      ]),
    );
  });
});
