import path from "node:path";

export type BuiltInLanguage =
  | "typescript"
  | "tsx"
  | "javascript"
  | "jsx"
  | "python"
  | "json"
  | "yaml"
  | "toml";

export type DetectedLanguage = BuiltInLanguage | (string & {});

const EXTENSION_LANGUAGES = new Map<string, DetectedLanguage>([
  [".ts", "typescript"],
  [".mts", "typescript"],
  [".cts", "typescript"],
  [".tsx", "tsx"],
  [".js", "javascript"],
  [".mjs", "javascript"],
  [".cjs", "javascript"],
  [".jsx", "jsx"],
  [".py", "python"],
  [".pyi", "python"],
  [".json", "json"],
  [".jsonc", "json"],
  [".yaml", "yaml"],
  [".yml", "yaml"],
  [".toml", "toml"],
]);
const SOURCE_LANGUAGES = new Set<DetectedLanguage>([
  "typescript", "tsx", "javascript", "jsx", "python",
]);

export function registerLanguageExtensions(
  language: DetectedLanguage,
  extensions: readonly string[],
  options: { replace?: boolean; source?: boolean } = {},
): () => void {
  if (language.trim() === "" || extensions.length === 0) {
    throw new Error("Language extensions require a language name and at least one extension.");
  }
  const normalized = extensions.map((extension) => {
    const value = extension.toLocaleLowerCase();
    if (!/^\.[a-z0-9][a-z0-9._+-]*$/u.test(value)) {
      throw new Error(`Invalid language extension: ${extension}`);
    }
    return value;
  });
  const previous = normalized.map((extension) => [extension, EXTENSION_LANGUAGES.get(extension)] as const);
  for (const [extension, prior] of previous) {
    if (prior !== undefined && prior !== language && options.replace !== true) {
      throw new Error(`Language extension ${extension} is already registered for ${prior}.`);
    }
  }
  for (const extension of normalized) EXTENSION_LANGUAGES.set(extension, language);
  const wasSource = SOURCE_LANGUAGES.has(language);
  if (options.source !== false) SOURCE_LANGUAGES.add(language);
  return () => {
    for (const [extension, prior] of previous) {
      if (EXTENSION_LANGUAGES.get(extension) !== language) continue;
      if (prior === undefined) EXTENSION_LANGUAGES.delete(extension);
      else EXTENSION_LANGUAGES.set(extension, prior);
    }
    if (!wasSource) SOURCE_LANGUAGES.delete(language);
  };
}

export function detectLanguage(filePath: string): DetectedLanguage | null {
  return EXTENSION_LANGUAGES.get(path.extname(filePath).toLowerCase()) ?? null;
}

export function isSourceLanguage(language: DetectedLanguage | null): boolean {
  return language !== null && SOURCE_LANGUAGES.has(language);
}

export function isLanguageEnabled(
  language: DetectedLanguage | null,
  enabled: { typescript: boolean; javascript: boolean; python: boolean },
): boolean {
  if (language === "typescript" || language === "tsx") return enabled.typescript;
  if (language === "javascript" || language === "jsx") return enabled.javascript;
  if (language === "python") return enabled.python;
  return language !== null;
}
