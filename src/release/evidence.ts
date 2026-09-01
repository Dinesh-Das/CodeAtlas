import { z } from "zod";

export const STABLE_RELEASE_BUDGETS = {
  minimumIndependentRepositories: 10,
  minimumTrackedLoc: 100_000,
  maximumColdIndexMs: 600_000,
  maximumPeakRssMiB: 6_144,
  maximumDatabaseMiB: 1_024,
  maximumSearchP95Ms: 100,
  maximumImpactP95Ms: 300,
  maximumFreshnessP95Ms: 5_000,
  minimumVerifiedRelationshipPercent: 50,
  maximumUnresolvedRelationshipPercent: 20,
  maximumEvidenceAgeDays: 90,
} as const;

export const repositoryValidationSchema = z.object({
  id: z.string().regex(/^[0-9A-Za-z][0-9A-Za-z._-]{0,99}$/u),
  repository: z.string().url().refine((value) => value.startsWith("https://"), {
    message: "Repository must use an HTTPS URL.",
  }),
  commit: z.string().regex(/^[0-9a-f]{7,64}$/iu),
  validatedAt: z.string().datetime({ offset: true }),
  codeAtlasVersion: z.string().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u),
  atlasSha256: z.string().regex(/^[0-9a-f]{64}$/iu),
  operatingSystem: z.enum(["linux", "macos", "windows"]),
  languages: z.array(z.enum(["typescript", "javascript", "python"])).min(1),
  checks: z.object({
    install: z.literal(true),
    index: z.literal(true),
    overview: z.literal(true),
    agentQuestion: z.literal(true),
    noIndexingFailures: z.literal(true),
  }).strict(),
  verifiedRelationshipPercent: z.number().min(0).max(100),
  unresolvedRelationshipPercent: z.number().min(0).max(100),
}).strict();

const benchmarkSchema = z.object({
  repository: z.string().trim().min(1),
  commit: z.string().regex(/^[0-9a-f]{7,64}$/iu),
  trackedLoc: z.number().int().positive(),
  coldIndexMs: z.number().positive(),
  peakRssMiB: z.number().positive(),
  databaseMiB: z.number().positive(),
  searchP95Ms: z.number().positive(),
  impactP95Ms: z.number().positive(),
  freshnessP95Ms: z.number().positive(),
}).strict();

export const releaseEvidenceSchema = z.object({
  schemaVersion: z.literal(1),
  targetVersion: z.string().regex(/^\d+\.\d+\.\d+$/u),
  independentRepositories: z.array(repositoryValidationSchema),
  largeRepositoryBenchmark: benchmarkSchema.nullable(),
}).strict();

export type ReleaseEvidence = z.infer<typeof releaseEvidenceSchema>;

export interface ReleaseEvidenceResult {
  ready: boolean;
  repositoryCount: number;
  errors: string[];
}

function stableVersion(version: string): string {
  return version.split("-")[0] ?? version;
}

function normalizedRepository(repository: string): string {
  return repository.toLowerCase().replace(/\.git$/u, "").replace(/\/$/u, "");
}

export function validateStableReleaseEvidence(
  version: string,
  input: unknown,
): ReleaseEvidenceResult {
  const parsed = releaseEvidenceSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ready: false,
      repositoryCount: 0,
      errors: parsed.error.issues.map((issue) =>
        `${issue.path.join(".") || "releaseEvidence"}: ${issue.message}`,
      ),
    };
  }
  const evidence = parsed.data;
  const errors: string[] = [];
  if (evidence.targetVersion !== stableVersion(version)) {
    errors.push(
      `Evidence targets ${evidence.targetVersion}, but the release base version is ${stableVersion(version)}.`,
    );
  }
  const uniqueRepositories = new Set(
    evidence.independentRepositories.map((entry) => normalizedRepository(entry.repository)),
  );
  if (uniqueRepositories.size < STABLE_RELEASE_BUDGETS.minimumIndependentRepositories) {
    errors.push(
      `Validated independent repositories: ${uniqueRepositories.size}/${STABLE_RELEASE_BUDGETS.minimumIndependentRepositories}.`,
    );
  }
  if (uniqueRepositories.size !== evidence.independentRepositories.length) {
    errors.push("Independent repository origins must be unique.");
  }
  if (uniqueRepositories.has("https://github.com/dinesh-das/codeatlas")) {
    errors.push("CodeAtlas cannot count as an independent repository validation.");
  }
  const repositoryIds = new Set(evidence.independentRepositories.map((entry) => entry.id));
  if (repositoryIds.size !== evidence.independentRepositories.length) {
    errors.push("Independent repository validation IDs must be unique.");
  }
  const operatingSystems = new Set(
    evidence.independentRepositories.map((entry) => entry.operatingSystem),
  );
  for (const operatingSystem of ["linux", "macos", "windows"] as const) {
    if (!operatingSystems.has(operatingSystem)) {
      errors.push(`Independent validation is missing ${operatingSystem}.`);
    }
  }
  const languages = new Set(evidence.independentRepositories.flatMap((entry) => entry.languages));
  for (const language of ["typescript", "javascript", "python"] as const) {
    if (!languages.has(language)) errors.push(`Independent validation is missing ${language}.`);
  }
  for (const repository of evidence.independentRepositories) {
    const validationAgeMs = Date.now() - Date.parse(repository.validatedAt);
    const maximumAgeMs = STABLE_RELEASE_BUDGETS.maximumEvidenceAgeDays * 86_400_000;
    if (validationAgeMs > maximumAgeMs || validationAgeMs < -86_400_000) {
      errors.push(
        `${repository.id} validation is outside the ${STABLE_RELEASE_BUDGETS.maximumEvidenceAgeDays}-day evidence window.`,
      );
    }
    if (stableVersion(repository.codeAtlasVersion) !== stableVersion(version)) {
      errors.push(
        `${repository.id} was validated with ${repository.codeAtlasVersion}, not the ${stableVersion(version)} release line.`,
      );
    }
    if (
      repository.verifiedRelationshipPercent <
      STABLE_RELEASE_BUDGETS.minimumVerifiedRelationshipPercent
    ) {
      errors.push(
        `${repository.id} has less than ${STABLE_RELEASE_BUDGETS.minimumVerifiedRelationshipPercent}% verified relationships.`,
      );
    }
    if (
      repository.unresolvedRelationshipPercent >
      STABLE_RELEASE_BUDGETS.maximumUnresolvedRelationshipPercent
    ) {
      errors.push(
        `${repository.id} has more than ${STABLE_RELEASE_BUDGETS.maximumUnresolvedRelationshipPercent}% unresolved relationships.`,
      );
    }
  }
  const benchmark = evidence.largeRepositoryBenchmark;
  if (benchmark === null) {
    errors.push("A large-repository benchmark is required.");
  } else {
    if (benchmark.trackedLoc < STABLE_RELEASE_BUDGETS.minimumTrackedLoc) {
      errors.push(
        `tracked LOC minimum failed: ${benchmark.trackedLoc} < ${STABLE_RELEASE_BUDGETS.minimumTrackedLoc}.`,
      );
    }
    const budgetChecks: Array<[number, number, string]> = [
      [benchmark.coldIndexMs, STABLE_RELEASE_BUDGETS.maximumColdIndexMs, "cold index budget"],
      [benchmark.peakRssMiB, STABLE_RELEASE_BUDGETS.maximumPeakRssMiB, "peak RSS budget"],
      [benchmark.databaseMiB, STABLE_RELEASE_BUDGETS.maximumDatabaseMiB, "database size budget"],
      [benchmark.searchP95Ms, STABLE_RELEASE_BUDGETS.maximumSearchP95Ms, "search p95 budget"],
      [benchmark.impactP95Ms, STABLE_RELEASE_BUDGETS.maximumImpactP95Ms, "impact p95 budget"],
      [benchmark.freshnessP95Ms, STABLE_RELEASE_BUDGETS.maximumFreshnessP95Ms, "freshness p95 budget"],
    ];
    for (const [actual, limit, label] of budgetChecks) {
      if (actual > limit) errors.push(`${label} failed: ${actual} > ${limit}.`);
    }
  }
  return {
    ready: errors.length === 0,
    repositoryCount: uniqueRepositories.size,
    errors,
  };
}
