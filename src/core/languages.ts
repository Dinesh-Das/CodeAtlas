import path from "node:path";

export type DetectedLanguage =
  | "typescript"
  | "tsx"
  | "javascript"
  | "jsx"
  | "python"
  | "json"
  | "yaml"
  | "toml";

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

export function detectLanguage(filePath: string): DetectedLanguage | null {
  return EXTENSION_LANGUAGES.get(path.extname(filePath).toLowerCase()) ?? null;
}

export function isSourceLanguage(language: DetectedLanguage | null): boolean {
  return (
    language === "typescript" ||
    language === "tsx" ||
    language === "javascript" ||
    language === "jsx" ||
    language === "python"
  );
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
