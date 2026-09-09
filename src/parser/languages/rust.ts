import RustLanguage from "tree-sitter-rust";
import type { LanguageAdapter, ParsedFile, ParseInput } from "../parser.js";
import {
  createTree,
  declarationSignature,
  ParseGraphBuilder,
  type AddedSymbol,
  type SyntaxNode,
} from "../tree-sitter.js";
import {
  addDynamicReference,
  addGeneratedReference,
  descendantNodes,
  generatedSource,
  identifierText,
} from "./common.js";

interface Scope {
  parentNodeId: string;
  qualifiedName: string;
  type: "module" | "class" | "function";
}

const TYPE_ITEMS = new Set(["enum_item", "struct_item", "trait_item", "type_item"]);
const REFLECTION_MACROS = new Set(["include", "include_bytes", "include_str"]);
const REGISTRATION_CALLS = new Set(["add", "bind", "provide", "register", "service"]);

function qualifiedName(scope: Scope, name: string): string {
  return scope.qualifiedName === "" ? name : `${scope.qualifiedName}.${name}`;
}

function rustName(node: SyntaxNode | null): string | null {
  if (node === null) return null;
  const direct = identifierText(node);
  if (direct !== null) return direct;
  if (node.type === "crate" || node.type === "self" || node.type === "super") return node.type;
  if (node.type === "scoped_identifier" || node.type === "scoped_type_identifier") {
    const path = rustName(node.childForFieldName("path"));
    const name = rustName(node.childForFieldName("name"));
    return path === null || name === null ? name : `${path}::${name}`;
  }
  if (node.type === "field_expression") {
    const value = rustName(node.childForFieldName("value"));
    const field = rustName(node.childForFieldName("field"));
    return value === null || field === null ? field : `${value}.${field}`;
  }
  if (node.type === "generic_type") return rustName(node.childForFieldName("type"));
  return null;
}

function isPublic(node: SyntaxNode): boolean {
  return node.namedChildren.some((child) => child.type === "visibility_modifier");
}

function implType(node: SyntaxNode): string | null {
  return rustName(node.childForFieldName("type"));
}

function functionName(node: SyntaxNode): string | null {
  return rustName(node.childForFieldName("name"));
}

export const rustAdapter: LanguageAdapter = {
  language: "rust",
  version: "rust-tree-sitter-1@0.23.1",
  engine: "tree-sitter",

  createSyntaxTree(content: string): SyntaxNode {
    return createTree(RustLanguage, content).rootNode;
  },

  parseFile(input: ParseInput): ParsedFile {
    const root = this.createSyntaxTree(input.content);
    const builder = new ParseGraphBuilder(input, root);
    const moduleScope: Scope = {
      parentNodeId: builder.moduleNodeId,
      qualifiedName: "",
      type: "module",
    };
    const types = new Map<string, AddedSymbol>();

    const addType = (node: SyntaxNode, parent = moduleScope): AddedSymbol | null => {
      const name = rustName(node.childForFieldName("name"));
      if (name === null) return null;
      const kind = node.type === "trait_item" ? "interface" : "class";
      const symbol = builder.addSymbol({
        kind,
        name,
        qualifiedName: qualifiedName(parent, name),
        syntaxNode: node,
        parentNodeId: parent.parentNodeId,
        signature: declarationSignature(input, node),
        visibility: isPublic(node) ? "public" : "module",
      });
      types.set(name, symbol);
      if (isPublic(node)) builder.addExport(symbol.id, node);
      return symbol;
    };

    for (const child of root.namedChildren) {
      if (TYPE_ITEMS.has(child.type)) addType(child);
    }

    const visitCalls = (node: SyntaxNode, scope: Scope): void => {
      if (node.type === "call_expression") {
        const callable = node.childForFieldName("function");
        const target = rustName(callable);
        if (target === null) {
          addDynamicReference(builder, callable ?? node, scope.parentNodeId, {
            name: "computed_callable",
            kind: "reflection",
            behavior: "computed_or_trait_object_call",
            confidence: 0.25,
          });
        } else {
          builder.addReference({ name: target, kind: "call", sourceNodeId: scope.parentNodeId }, callable ?? node);
          const method = target.split(/::|\./u).at(-1) ?? target;
          if (REGISTRATION_CALLS.has(method)) {
            const registeredNode = node.childForFieldName("arguments")?.namedChildren.at(-1);
            const registered = rustName(registeredNode ?? null);
            if (registered !== null) {
              addDynamicReference(builder, registeredNode ?? node, scope.parentNodeId, {
                name: registered,
                kind: "runtime_registration",
                behavior: "runtime_registration",
                confidence: 0.6,
              });
            }
          }
        }
      } else if (node.type === "macro_invocation") {
        const macro = rustName(node.childForFieldName("macro"));
        if (macro !== null && REFLECTION_MACROS.has(macro)) {
          addDynamicReference(builder, node, scope.parentNodeId, {
            name: "compile_time_generated_target",
            kind: "reflection",
            behavior: "compile_time_source_inclusion",
            confidence: 0.5,
          });
        }
      }
      for (const child of node.namedChildren) visitCalls(child, scope);
    };

    const addFunction = (node: SyntaxNode, owner: AddedSymbol | null): void => {
      const name = functionName(node);
      if (name === null) return;
      const scope: Scope = owner === null
        ? moduleScope
        : {
            parentNodeId: owner.id,
            qualifiedName: owner.node.qualifiedName ?? owner.node.name,
            type: "class",
          };
      const symbol = builder.addSymbol({
        kind: owner === null ? "function" : "method",
        name,
        qualifiedName: qualifiedName(scope, name),
        syntaxNode: node,
        parentNodeId: scope.parentNodeId,
        signature: declarationSignature(input, node),
        visibility: isPublic(node) ? "public" : "module",
      });
      if (isPublic(node)) builder.addExport(symbol.id, node);
      const body = node.childForFieldName("body");
      if (body !== null) {
        visitCalls(body, {
          parentNodeId: symbol.id,
          qualifiedName: symbol.node.qualifiedName ?? name,
          type: "function",
        });
      }
    };

    for (const child of root.namedChildren) {
      if (child.type === "use_declaration") {
        const argument = child.childForFieldName("argument");
        const target = rustName(argument);
        if (target !== null) {
          const imported = target.split("::").at(-1) ?? target;
          builder.addReference({
            name: target,
            kind: "import",
            sourceNodeId: builder.moduleNodeId,
            localName: imported,
            importedName: imported,
          }, argument ?? child);
        }
        continue;
      }
      if (child.type === "function_item") {
        addFunction(child, null);
        continue;
      }
      if (child.type === "trait_item") {
        const ownerName = rustName(child.childForFieldName("name"));
        const owner = ownerName === null ? null : types.get(ownerName) ?? null;
        for (const method of descendantNodes(child.childForFieldName("body"), (candidate) =>
          candidate.type === "function_signature_item" || candidate.type === "function_item"
        )) {
          addFunction(method, owner);
        }
        continue;
      }
      if (child.type !== "impl_item") continue;
      const ownerName = implType(child);
      const owner = ownerName === null ? null : types.get(ownerName.split("::").at(-1) ?? ownerName) ?? null;
      const trait = rustName(child.childForFieldName("trait"));
      if (owner !== null && trait !== null) {
        builder.addReference({ name: trait, kind: "implements", sourceNodeId: owner.id }, child.childForFieldName("trait") ?? child);
      }
      for (const method of child.childForFieldName("body")?.namedChildren ?? []) {
        if (method.type === "function_item") addFunction(method, owner);
      }
    }

    addGeneratedReference(builder, root, generatedSource(input));
    return builder.result();
  },
};
