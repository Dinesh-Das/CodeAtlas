import type { DetectedLanguage } from "../core/languages.js";
import type { LanguageAdapter } from "./parser.js";
import { javascriptAdapter, jsxAdapter } from "./languages/javascript.js";
import { pythonAdapter } from "./languages/python.js";
import { tsxAdapter, typescriptAdapter } from "./languages/typescript.js";

export const TREE_SITTER_VERSION = "tree-sitter@0.21.1";

const adapters = new Map<DetectedLanguage, LanguageAdapter>([
  ["typescript", typescriptAdapter],
  ["tsx", tsxAdapter],
  ["javascript", javascriptAdapter],
  ["jsx", jsxAdapter],
  ["python", pythonAdapter],
]);

export function getLanguageAdapter(language: DetectedLanguage | null): LanguageAdapter | null {
  return language === null ? null : (adapters.get(language) ?? null);
}

export function availableLanguageAdapters(): readonly LanguageAdapter[] {
  return [...adapters.values()];
}
