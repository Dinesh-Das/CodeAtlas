import JavaLanguage from "tree-sitter-java";
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

const TYPE_DECLARATIONS = new Set([
  "annotation_type_declaration",
  "class_declaration",
  "enum_declaration",
  "interface_declaration",
  "record_declaration",
]);
const REFLECTION_CALLS = new Set([
  "Class.forName",
  "getDeclaredMethod",
  "getMethod",
  "invoke",
  "loadClass",
]);
const REGISTRATION_METHODS = new Set(["add", "bind", "provide", "register"]);

function nodeName(node: SyntaxNode | null): string | null {
  return identifierText(node);
}

function scopedName(node: SyntaxNode | null): string | null {
  if (node === null) return null;
  const direct = nodeName(node);
  if (direct !== null) return direct;
  if (node.type === "scoped_identifier" || node.type === "scoped_type_identifier") {
    const scope = scopedName(node.childForFieldName("scope"));
    const name = nodeName(node.childForFieldName("name"));
    return scope === null || name === null ? name : `${scope}.${name}`;
  }
  if (node.type === "field_access") {
    const object = scopedName(node.childForFieldName("object"));
    const field = nodeName(node.childForFieldName("field"));
    return object === null || field === null ? field : `${object}.${field}`;
  }
  return null;
}

function modifiers(node: SyntaxNode): string {
  return node.namedChildren.find((child) => child.type === "modifiers")?.text ?? "";
}

function visibility(node: SyntaxNode, fallback = "package"): string {
  const value = modifiers(node);
  if (/\bpublic\b/u.test(value)) return "public";
  if (/\bprotected\b/u.test(value)) return "protected";
  if (/\bprivate\b/u.test(value)) return "private";
  return fallback;
}

function hasAnnotation(node: SyntaxNode, names: readonly string[]): boolean {
  const value = modifiers(node);
  return names.some((name) => new RegExp(`@${name}\\b`, "u").test(value));
}

function methodTarget(node: SyntaxNode): string | null {
  const object = scopedName(node.childForFieldName("object"));
  const name = nodeName(node.childForFieldName("name"));
  return object === null || name === null ? name : `${object}.${name}`;
}

function typeReferences(node: SyntaxNode | null): Array<{ name: string; node: SyntaxNode }> {
  return descendantNodes(node, (candidate) =>
    candidate.type === "type_identifier" || candidate.type === "scoped_type_identifier"
  ).flatMap((candidate) => {
    const name = scopedName(candidate);
    return name === null ? [] : [{ name, node: candidate }];
  });
}

export const javaAdapter: LanguageAdapter = {
  language: "java",
  version: "java-tree-sitter-1@0.23.5",
  engine: "tree-sitter",

  createSyntaxTree(content: string): SyntaxNode {
    return createTree(JavaLanguage, content).rootNode;
  },

  parseFile(input: ParseInput): ParsedFile {
    const root = this.createSyntaxTree(input.content);
    const builder = new ParseGraphBuilder(input, root);
    const packageDeclaration = root.namedChildren.find((child) => child.type === "package_declaration");
    const packageName = packageDeclaration === undefined
      ? ""
      : scopedName(packageDeclaration.namedChildren.find((child) =>
        child.type === "identifier" || child.type === "scoped_identifier"
      ) ?? null) ?? "";
    const moduleScope: Scope = {
      parentNodeId: builder.moduleNodeId,
      qualifiedName: packageName,
      type: "module",
    };
    const types = new Map<string, AddedSymbol>();

    const visitCalls = (node: SyntaxNode, scope: Scope): void => {
      if (node.type === "method_invocation") {
        const target = methodTarget(node);
        if (target === null) {
          addDynamicReference(builder, node, scope.parentNodeId, {
            name: "computed_callable",
            kind: "reflection",
            behavior: "computed_or_reflective_call",
            confidence: 0.25,
          });
        } else {
          builder.addReference({ name: target, kind: "call", sourceNodeId: scope.parentNodeId }, node);
          const method = target.split(".").at(-1) ?? target;
          if (REFLECTION_CALLS.has(target) || REFLECTION_CALLS.has(method)) {
            addDynamicReference(builder, node, scope.parentNodeId, {
              name: "reflective_target",
              kind: "reflection",
              behavior: "runtime_reflection",
              confidence: 0.3,
            });
          }
          if (REGISTRATION_METHODS.has(method)) {
            const argument = node.childForFieldName("arguments")?.namedChildren.at(-1);
            const registered = scopedName(argument ?? null);
            if (registered !== null) {
              addDynamicReference(builder, argument ?? node, scope.parentNodeId, {
                name: registered,
                kind: "runtime_registration",
                behavior: "runtime_registration",
                confidence: 0.6,
              });
            }
          }
        }
      } else if (node.type === "object_creation_expression") {
        const target = scopedName(node.childForFieldName("type"));
        if (target !== null) {
          builder.addReference({ name: target, kind: "call", sourceNodeId: scope.parentNodeId }, node);
        }
      }
      for (const child of node.namedChildren) visitCalls(child, scope);
    };

    const visitType = (node: SyntaxNode, parent: Scope): void => {
      const name = nodeName(node.childForFieldName("name"));
      if (name === null) return;
      const kind = node.type === "interface_declaration" || node.type === "annotation_type_declaration"
        ? "interface"
        : "class";
      const symbol = builder.addSymbol({
        kind,
        name,
        qualifiedName: parent.qualifiedName === "" ? name : `${parent.qualifiedName}.${name}`,
        syntaxNode: node,
        parentNodeId: parent.parentNodeId,
        signature: declarationSignature(input, node),
        visibility: visibility(node, node.type === "interface_declaration" ? "public" : "package"),
      });
      types.set(name, symbol);
      if (visibility(node) === "public") builder.addExport(symbol.id, node);
      const classScope: Scope = {
        parentNodeId: symbol.id,
        qualifiedName: symbol.node.qualifiedName ?? name,
        type: "class",
      };

      const superclass = node.childForFieldName("superclass");
      for (const target of typeReferences(superclass)) {
        builder.addReference({ name: target.name, kind: "extends", sourceNodeId: symbol.id }, target.node);
      }
      const interfaces = node.childForFieldName("interfaces");
      for (const target of typeReferences(interfaces)) {
        builder.addReference({ name: target.name, kind: "implements", sourceNodeId: symbol.id }, target.node);
      }

      const body = node.childForFieldName("body");
      if (body === null) return;
      for (const member of body.namedChildren) {
        if (TYPE_DECLARATIONS.has(member.type)) {
          visitType(member, classScope);
          continue;
        }
        if (member.type === "field_declaration") {
          for (const declarator of member.namedChildren.filter((child) =>
            child.type === "variable_declarator"
          )) {
            const fieldName = nodeName(declarator.childForFieldName("name"));
            if (fieldName === null) continue;
            builder.addSymbol({
              kind: "variable",
              name: fieldName,
              qualifiedName: `${classScope.qualifiedName}.${fieldName}`,
              syntaxNode: declarator,
              parentNodeId: symbol.id,
              signature: declarationSignature(input, member),
              visibility: visibility(member),
            });
          }
          if (hasAnnotation(member, ["Autowired", "Inject"])) {
            for (const target of typeReferences(member.childForFieldName("type"))) {
              addDynamicReference(builder, target.node, symbol.id, {
                name: target.name,
                kind: "dependency_injection",
                behavior: "annotated_field_injection",
                confidence: 0.8,
              });
            }
          }
          continue;
        }
        if (member.type !== "method_declaration" && member.type !== "constructor_declaration") continue;
        const methodName = nodeName(member.childForFieldName("name"));
        if (methodName === null) continue;
        const method = builder.addSymbol({
          kind: "method",
          name: methodName,
          qualifiedName: `${classScope.qualifiedName}.${methodName}`,
          syntaxNode: member,
          parentNodeId: symbol.id,
          signature: declarationSignature(input, member),
          visibility: visibility(member, node.type === "interface_declaration" ? "public" : "package"),
        });
        if (visibility(member, node.type === "interface_declaration" ? "public" : "package") === "public") {
          builder.addExport(method.id, member);
        }
        if (hasAnnotation(member, ["Autowired", "Inject"])) {
          const parameters = member.childForFieldName("parameters");
          for (const target of typeReferences(parameters)) {
            addDynamicReference(builder, target.node, method.id, {
              name: target.name,
              kind: "dependency_injection",
              behavior: "annotated_constructor_or_method_injection",
              confidence: 0.85,
            });
          }
        }
        const bodyNode = member.childForFieldName("body");
        if (bodyNode !== null) {
          visitCalls(bodyNode, {
            parentNodeId: method.id,
            qualifiedName: method.node.qualifiedName ?? methodName,
            type: "function",
          });
        }
      }
    };

    for (const child of root.namedChildren) {
      if (child.type === "import_declaration") {
        const targetNode = child.namedChildren.find((candidate) =>
          candidate.type === "identifier" || candidate.type === "scoped_identifier"
        );
        const target = scopedName(targetNode ?? null);
        if (target !== null) {
          builder.addReference({
            name: target,
            kind: "import",
            sourceNodeId: builder.moduleNodeId,
            localName: target.split(".").at(-1) ?? target,
            importedName: target.split(".").at(-1) ?? target,
          }, targetNode ?? child);
        }
      } else if (TYPE_DECLARATIONS.has(child.type)) {
        visitType(child, moduleScope);
      }
    }

    addGeneratedReference(builder, root, generatedSource(input));
    return builder.result();
  },
};
