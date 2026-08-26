import JavaScriptLanguage from "tree-sitter-javascript";
import { EcmaScriptAdapter } from "./ecmascript.js";

export const javascriptAdapter = new EcmaScriptAdapter({
  language: "javascript",
  version: "javascript-tree-sitter-1@0.23.1",
  grammar: JavaScriptLanguage,
});

export const jsxAdapter = new EcmaScriptAdapter({
  language: "jsx",
  version: "jsx-tree-sitter-1@0.23.1",
  grammar: JavaScriptLanguage,
});
