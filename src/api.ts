import { registerLanguageExtensions, type DetectedLanguage } from "./core/languages.js";
import { registerLanguageAdapter } from "./parser/registry.js";
import type { LanguageAdapter } from "./parser/parser.js";

export { buildRepository, type BuildResult, type BuildTimings } from "./compiler/build.js";
export {
  answerFromAtlas,
  evaluateArchitectureAnswer,
  type ArchitectureAnswerQuality,
  type AtlasAnswer,
} from "./ai/answering.js";
export {
  estimateAtlasHtmlSize,
  renderAtlasHtml,
  exportAtlasHtml,
  type AtlasHtmlSizeEstimate,
} from "./export/html.js";
export { renderAtlasMarkdown, exportAtlasMarkdown } from "./export/markdown.js";
export { renderAtlasMermaid, exportAtlasMermaid } from "./export/mermaid.js";
export {
  createSourceFreeReviewReport,
  formatSourceFreeReviewReport,
  sourceFreeReviewReport,
  type SourceFreeReviewReport,
} from "./cli/review.js";
export {
  buildKnowledgeReport,
  createKnowledgeArtifacts,
  formatKnowledgeReport,
  renderAgentMap,
  writeKnowledgeArtifacts,
  type KnowledgeFinding,
  type KnowledgeReport,
  type KnowledgeSystem,
} from "./knowledge/system.js";
export { createCodeAtlasServer } from "./mcp/server.js";
export { CODEATLAS_VERSION } from "./version.js";
export { registerFrameworkAdapter } from "./framework/registry.js";
export {
  compileChangeContext,
  compileChangeContextFromAtlas,
  type CompileChangeContextOptions,
} from "./context/planner.js";
export {
  CHANGE_CONTEXT_SCHEMA_VERSION,
  renderChangeContextMarkdown,
  serializeChangeContext,
  validateChangeContextGrounding,
  type ChangeContext,
  type ChangeContextFormat,
} from "./context/packet.js";
export {
  EVALUATION_HARNESS_VERSION,
  EVALUATION_SCHEMA_VERSION,
  evaluationObservationSchema,
  evaluationRunSchema,
  evaluationSuiteSchema,
  type EvaluationObservation,
  type EvaluationRun,
  type EvaluationSuite,
} from "./evaluation/models.js";
export {
  evaluateRun,
  fixtureContentSha256,
  validatePinnedFixtures,
  type EvaluationReport,
} from "./evaluation/runner.js";
export type { FrameworkAdapter, FrameworkEntities, RepositoryContext } from "./framework/types.js";
export type { Atlas, AtlasSymbol, AtlasRelationship, AtlasFlow, ImpactResult } from "./ir/models.js";
export type { LanguageAdapter } from "./parser/parser.js";
export type { DetectedLanguage } from "./core/languages.js";

export interface LanguageExtension {
  language: DetectedLanguage;
  extensions: readonly string[];
  adapter: LanguageAdapter;
  replace?: boolean;
}

/** Register a third-party parser for the current process. Returns a cleanup function for tests/hosts. */
export function registerCodeAtlasLanguage(extension: LanguageExtension): () => void {
  if (extension.adapter.language !== extension.language) {
    throw new Error(
      `Language extension ${extension.language} does not match adapter ${extension.adapter.language}.`,
    );
  }
  const removeExtensions = registerLanguageExtensions(
    extension.language,
    extension.extensions,
    { ...(extension.replace === undefined ? {} : { replace: extension.replace }), source: true },
  );
  try {
    const removeAdapter = registerLanguageAdapter(
      extension.language,
      extension.adapter,
      extension.replace === undefined ? {} : { replace: extension.replace },
    );
    return () => {
      removeAdapter();
      removeExtensions();
    };
  } catch (error) {
    removeExtensions();
    throw error;
  }
}
