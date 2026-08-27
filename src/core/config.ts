import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { CodeAtlasError } from "./errors.js";
import { writeJsonAtomic } from "./workspace.js";

export const configSchema = z
  .object({
    version: z.literal(1),
    languages: z
      .object({
        typescript: z.boolean(),
        javascript: z.boolean(),
        python: z.boolean(),
      })
      .strict(),
    analysis: z
      .object({
        gitHistory: z.boolean(),
        technicalDebt: z.boolean(),
        featureDetection: z.boolean(),
        frameworks: z.boolean().default(true),
        featureOverrides: z
          .array(
            z
              .object({
                name: z.string().trim().min(1).max(120),
                include: z.array(z.string().trim().min(1)).min(1).max(200),
                exclude: z.array(z.string().trim().min(1)).max(200).default([]),
                confidence: z.number().min(0.5).max(1).default(1),
              })
              .strict(),
          )
          .max(500)
          .default([]),
      })
      .strict(),
    limits: z
      .object({
        maxTraversalDepth: z.number().int().min(1).max(100),
        maxSourceSnippetLines: z.number().int().min(1).max(2_000),
        maxSourceSnippetBytes: z.number().int().min(256).max(100_000).default(8_000),
        maxMcpResultNodes: z.number().int().min(1).max(10_000),
        maxExecutionPaths: z.number().int().min(1).max(1_000).default(20),
        maxInvalidationFiles: z.number().int().min(10).max(100_000).default(2_000),
        largeFileLines: z.number().int().min(20).max(1_000_000).default(500),
        largeSymbolLines: z.number().int().min(10).max(100_000).default(80),
        highFanIn: z.number().int().min(1).max(100_000).default(10),
        highFanOut: z.number().int().min(1).max(100_000).default(10),
      })
      .strict(),
  })
  .strict();

export type CodeAtlasConfig = z.infer<typeof configSchema>;

export const DEFAULT_CONFIG: CodeAtlasConfig = {
  version: 1,
  languages: {
    typescript: true,
    javascript: true,
    python: true,
  },
  analysis: {
    gitHistory: true,
    technicalDebt: true,
    featureDetection: true,
    frameworks: true,
    featureOverrides: [],
  },
  limits: {
    maxTraversalDepth: 10,
    maxSourceSnippetLines: 120,
    maxSourceSnippetBytes: 8_000,
    maxMcpResultNodes: 200,
    maxExecutionPaths: 20,
    maxInvalidationFiles: 2_000,
    largeFileLines: 500,
    largeSymbolLines: 80,
    highFanIn: 10,
    highFanOut: 10,
  },
};

export function configPath(repositoryRoot: string): string {
  return path.join(repositoryRoot, ".codeatlas", "config.json");
}

export async function createDefaultConfig(repositoryRoot: string): Promise<CodeAtlasConfig> {
  await writeJsonAtomic(configPath(repositoryRoot), DEFAULT_CONFIG);
  return DEFAULT_CONFIG;
}

export async function loadConfig(repositoryRoot: string): Promise<CodeAtlasConfig> {
  const filePath = configPath(repositoryRoot);
  let input: unknown;

  try {
    input = JSON.parse(await readFile(filePath, "utf8")) as unknown;
  } catch (error) {
    const detail = error instanceof SyntaxError ? error.message : "The file could not be read.";
    throw new CodeAtlasError(
      `Error: .codeatlas/config.json is invalid.\n  ${detail}\nRun \`codeatlas doctor\` for details.`,
      { cause: error },
    );
  }

  const result = configSchema.safeParse(input);
  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `  ${issue.path.join(".") || "config"}: ${issue.message}`)
      .join("\n");
    throw new CodeAtlasError(
      `Error: .codeatlas/config.json is invalid.\n${details}\nRun \`codeatlas doctor\` for details.`,
    );
  }

  return result.data;
}
