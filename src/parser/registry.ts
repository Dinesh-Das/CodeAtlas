import type { DetectedLanguage } from "../core/languages.js";
import type { LanguageAdapter } from "./parser.js";
import { javascriptAdapter, jsxAdapter } from "./languages/javascript.js";
import { pythonAdapter } from "./languages/python.js";
import { tsxAdapter, typescriptAdapter } from "./languages/typescript.js";

export const TREE_SITTER_VERSION = "tree-sitter@0.21.1+codeatlas-buffer-v2";

const adapters = new Map<DetectedLanguage, LanguageAdapter>();

export function registerLanguageAdapter(
  language: DetectedLanguage,
  adapter: LanguageAdapter,
  options: { replace?: boolean } = {},
): () => void {
  if (adapter.language !== language) {
    throw new Error(`Language adapter key ${language} does not match adapter language ${adapter.language}.`);
  }
  if (adapter.version.trim() === "") {
    throw new Error("Language adapters require a non-empty version value.");
  }
  if (adapter.engine !== "tree-sitter") {
    throw new Error(`Language adapter ${language} must use the tree-sitter baseline engine.`);
  }
  const previous = adapters.get(language);
  if (previous !== undefined && options.replace !== true) {
    throw new Error(`Language adapter ${language} is already registered.`);
  }
  adapters.set(language, adapter);
  return () => {
    if (adapters.get(language) !== adapter) return;
    if (previous === undefined) adapters.delete(language);
    else adapters.set(language, previous);
  };
}

for (const [language, adapter] of [
  ["typescript", typescriptAdapter],
  ["tsx", tsxAdapter],
  ["javascript", javascriptAdapter],
  ["jsx", jsxAdapter],
  ["python", pythonAdapter],
] as const) {
  registerLanguageAdapter(language, adapter);
}

export function getLanguageAdapter(language: DetectedLanguage | null): LanguageAdapter | null {
  return language === null ? null : (adapters.get(language) ?? null);
}

export function availableLanguageAdapters(): readonly LanguageAdapter[] {
  return [...adapters.values()].sort((left, right) => left.language.localeCompare(right.language));
}
