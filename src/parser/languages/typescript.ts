import TypeScriptLanguages from "tree-sitter-typescript";
import { EcmaScriptAdapter } from "./ecmascript.js";

export const typescriptAdapter = new EcmaScriptAdapter({
  language: "typescript",
  version: "typescript-tree-sitter-2@0.23.2",
  grammar: TypeScriptLanguages.typescript,
});

export const tsxAdapter = new EcmaScriptAdapter({
  language: "tsx",
  version: "tsx-tree-sitter-2@0.23.2",
  grammar: TypeScriptLanguages.tsx,
});
