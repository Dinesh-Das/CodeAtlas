import { existsSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import ts from "typescript-compiler";
import type { UnresolvedReference } from "../parser/parser.js";
import { isPathInside, toPosixPath } from "../core/paths.js";
import { workspaceManifestPaths } from "../core/workspace-packages.js";

interface PackageManifest {
  name?: unknown;
  main?: unknown;
  module?: unknown;
  types?: unknown;
  exports?: unknown;
}

export interface SemanticTarget {
  filePath: string;
  name: string;
  qualifiedName: string | null;
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
}

interface SemanticCall {
  expressionStart: number;
  expressionEnd: number;
  callStartLine: number;
  expressionText: string;
  lastName: string;
  target: SemanticTarget | null;
}

interface ProjectContext {
  configPath: string | null;
  options: ts.CompilerOptions;
  rootNames: string[];
  projectReferences?: readonly ts.ProjectReference[];
  program?: ts.Program;
  checker?: ts.TypeChecker;
  callsBySource?: Map<string, readonly SemanticCall[]>;
}

export interface TypeScriptResolutionMetrics {
  projectDiscoveryMs: number;
  programCreationMs: number;
  semanticResolutionMs: number;
  moduleResolutionMs: number;
  projectsDiscovered: number;
  programsCreated: number;
  semanticSourcesIndexed: number;
  projectCacheHits: number;
  moduleCacheHits: number;
  moduleCacheMisses: number;
  semanticCacheHits: number;
  semanticCacheMisses: number;
}

export type UnresolvedImportCategory =
  | "external_dependency"
  | "internal_unresolved"
  | "workspace_unresolved"
  | "alias_unresolved";

const JS_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];

function json(filePath: string): unknown {
  try {
    return JSON.parse(readFileSync(filePath, "utf8")) as unknown;
  } catch {
    return null;
  }
}

function exportTargets(value: unknown, subpath: string): string[] {
  if (typeof value === "string") return [value];
  if (typeof value !== "object" || value === null) return [];
  const record = value as Record<string, unknown>;
  const direct = record[subpath];
  if (direct !== undefined) return exportTargets(direct, subpath);
  for (const [pattern, target] of Object.entries(record)) {
    const star = pattern.indexOf("*");
    if (star < 0) continue;
    const prefix = pattern.slice(0, star);
    const suffix = pattern.slice(star + 1);
    if (!subpath.startsWith(prefix) || !subpath.endsWith(suffix)) continue;
    const matched = subpath.slice(prefix.length, subpath.length - suffix.length);
    return exportTargets(target, subpath).map((entry) => entry.replaceAll("*", matched));
  }
  for (const key of ["types", "import", "require", "default"]) {
    if (record[key] !== undefined) return exportTargets(record[key], subpath);
  }
  return [];
}

/** Project-aware resolver backed by TypeScript's own config and module-resolution APIs. */
export class TypeScriptProjectResolver {
  readonly #repositoryRoot: string;
  readonly #indexedPaths: ReadonlySet<string>;
  readonly #projectBySource = new Map<string, ProjectContext>();
  readonly #projectByConfig = new Map<string, ProjectContext>();
  readonly #configByDirectory = new Map<string, string | null>();
  readonly #moduleCache = new Map<string, string[]>();
  readonly #workspacePackages = new Map<string, { directory: string; manifest: PackageManifest }>();
  readonly #metrics: TypeScriptResolutionMetrics = {
    projectDiscoveryMs: 0,
    programCreationMs: 0,
    semanticResolutionMs: 0,
    moduleResolutionMs: 0,
    projectsDiscovered: 0,
    programsCreated: 0,
    semanticSourcesIndexed: 0,
    projectCacheHits: 0,
    moduleCacheHits: 0,
    moduleCacheMisses: 0,
    semanticCacheHits: 0,
    semanticCacheMisses: 0,
  };

  constructor(repositoryRoot: string, indexedPaths: ReadonlySet<string>) {
    this.#repositoryRoot = path.resolve(repositoryRoot);
    this.#indexedPaths = indexedPaths;
    const workspaceManifests = workspaceManifestPaths(this.#repositoryRoot, indexedPaths);
    for (const relativePath of workspaceManifests) {
      const manifest = json(path.join(this.#repositoryRoot, ...relativePath.split("/")));
      if (typeof manifest !== "object" || manifest === null) continue;
      const typed = manifest as PackageManifest;
      if (typeof typed.name !== "string") continue;
      this.#workspacePackages.set(typed.name, {
        directory: path.posix.dirname(relativePath),
        manifest: typed,
      });
    }
  }

  #relativeIndexedPath(absolutePath: string): string | null {
    let resolved = path.resolve(absolutePath);
    try {
      if (existsSync(resolved)) resolved = realpathSync.native(resolved);
    } catch {
      // Broken symlinks and partial installs are ordinary indexing conditions.
    }
    if (!isPathInside(this.#repositoryRoot, resolved)) return null;
    const relative = toPosixPath(path.relative(this.#repositoryRoot, resolved));
    if (this.#indexedPaths.has(relative)) return relative;
    const extension = path.posix.extname(relative);
    const withoutExtension = extension === "" ? relative : relative.slice(0, -extension.length);
    for (const candidate of [
      ...JS_EXTENSIONS.map((suffix) => `${withoutExtension}${suffix}`),
      ...JS_EXTENSIONS.map((suffix) => path.posix.join(relative, `index${suffix}`)),
    ]) {
      if (this.#indexedPaths.has(candidate)) return candidate;
    }
    return null;
  }

  #loadProject(sourceFile: string): ProjectContext {
    const cached = this.#projectBySource.get(sourceFile);
    if (cached !== undefined) {
      this.#metrics.projectCacheHits += 1;
      return cached;
    }
    const startedAt = performance.now();
    const absoluteSource = path.join(this.#repositoryRoot, ...sourceFile.split("/"));
    const sourceDirectory = path.dirname(absoluteSource);
    let configPath = this.#configByDirectory.get(sourceDirectory);
    if (configPath === undefined) {
      configPath = ts.findConfigFile(sourceDirectory, ts.sys.fileExists, "tsconfig.json") ??
        ts.findConfigFile(sourceDirectory, ts.sys.fileExists, "jsconfig.json") ?? null;
      this.#configByDirectory.set(sourceDirectory, configPath);
    }
    if (configPath !== null) {
      const existing = this.#projectByConfig.get(configPath);
      if (existing !== undefined) {
        this.#projectBySource.set(sourceFile, existing);
        this.#metrics.projectCacheHits += 1;
        this.#metrics.projectDiscoveryMs += performance.now() - startedAt;
        return existing;
      }
      const loaded = ts.readConfigFile(configPath, ts.sys.readFile);
      if (loaded.error === undefined) {
        const parsed = ts.parseJsonConfigFileContent(
          loaded.config,
          ts.sys,
          path.dirname(configPath),
          undefined,
          configPath,
        );
        const project: ProjectContext = {
          configPath,
          options: parsed.options,
          rootNames: parsed.fileNames,
          ...(parsed.projectReferences === undefined
            ? {}
            : { projectReferences: parsed.projectReferences }),
        };
        this.#projectByConfig.set(configPath, project);
        this.#projectBySource.set(sourceFile, project);
        this.#metrics.projectsDiscovered += 1;
        this.#metrics.projectDiscoveryMs += performance.now() - startedAt;
        return project;
      }
    }
    const project: ProjectContext = {
      configPath: null,
      options: {
        allowJs: true,
        resolveJsonModule: true,
        module: ts.ModuleKind.NodeNext,
        moduleResolution: ts.ModuleResolutionKind.NodeNext,
      },
      rootNames: [absoluteSource],
    };
    this.#projectBySource.set(sourceFile, project);
    this.#metrics.projectsDiscovered += 1;
    this.#metrics.projectDiscoveryMs += performance.now() - startedAt;
    return project;
  }

  #workspaceCandidates(specifier: string): string[] {
    const packageName = [...this.#workspacePackages.keys()]
      .filter((name) => specifier === name || specifier.startsWith(`${name}/`))
      .sort((left, right) => right.length - left.length)[0];
    if (packageName === undefined) return [];
    const entry = this.#workspacePackages.get(packageName)!;
    const suffix = specifier.slice(packageName.length).replace(/^\//u, "");
    const subpath = suffix === "" ? "." : `./${suffix}`;
    const manifestTargets = exportTargets(entry.manifest.exports, subpath);
    const legacyTargets = suffix === ""
      ? [entry.manifest.types, entry.manifest.module, entry.manifest.main]
          .filter((value): value is string => typeof value === "string")
      : [suffix];
    return [...manifestTargets, ...legacyTargets, `src/${suffix || "index"}`, suffix || "index"]
      .map((target) => target.replace(/^\.\//u, ""))
      .flatMap((target) => {
        const base = path.posix.normalize(path.posix.join(entry.directory, target));
        const extension = path.posix.extname(base);
        return extension === ""
          ? [base, ...JS_EXTENSIONS.map((value) => `${base}${value}`),
              ...JS_EXTENSIONS.map((value) => path.posix.join(base, `index${value}`))]
          : [base];
      })
      .filter((candidate) => this.#indexedPaths.has(candidate));
  }

  resolveModule(specifier: string, sourceFile: string): string[] {
    const key = `${sourceFile}\0${specifier}`;
    const cached = this.#moduleCache.get(key);
    if (cached !== undefined) {
      this.#metrics.moduleCacheHits += 1;
      return cached;
    }
    this.#metrics.moduleCacheMisses += 1;
    const startedAt = performance.now();
    if (!/\.[cm]?[jt]sx?$/u.test(sourceFile)) return [];
    const project = this.#loadProject(sourceFile);
    const absoluteSource = path.join(this.#repositoryRoot, ...sourceFile.split("/"));
    const resolved = ts.resolveModuleName(specifier, absoluteSource, project.options, ts.sys)
      .resolvedModule?.resolvedFileName;
    const compilerCandidate = resolved === undefined ? null : this.#relativeIndexedPath(resolved);
    const candidates = [...new Set([
      ...(compilerCandidate === null ? [] : [compilerCandidate]),
      ...this.#workspaceCandidates(specifier),
    ])].sort((left, right) => left.localeCompare(right));
    this.#moduleCache.set(key, candidates);
    this.#metrics.moduleResolutionMs += performance.now() - startedAt;
    return candidates;
  }

  classifyUnresolvedModule(
    specifier: string,
    sourceFile: string,
  ): UnresolvedImportCategory {
    if (specifier.startsWith(".") || specifier.startsWith("/")) {
      return "internal_unresolved";
    }
    if (
      [...this.#workspacePackages.keys()].some(
        (name) => specifier === name || specifier.startsWith(`${name}/`),
      )
    ) {
      return "workspace_unresolved";
    }
    if (/\.[cm]?[jt]sx?$/u.test(sourceFile)) {
      const project = this.#loadProject(sourceFile);
      const pathPatterns = Object.keys(project.options.paths ?? {});
      if (
        pathPatterns.some((pattern) => {
          const [prefix, suffix = ""] = pattern.split("*");
          return specifier.startsWith(prefix ?? "") && specifier.endsWith(suffix);
        }) ||
        (project.options.baseUrl !== undefined && /^(?:src|app|lib|packages?)\//u.test(specifier))
      ) {
        return "alias_unresolved";
      }
    }
    return "external_dependency";
  }

  resolveCall(reference: UnresolvedReference): SemanticTarget | null {
    if (reference.kind !== "call" || !/\.[cm]?[jt]sx?$/u.test(reference.evidence.file)) {
      return null;
    }
    const semanticStartedAt = performance.now();
    try {
      const project = this.#loadProject(reference.evidence.file);
      if (project.program === undefined) {
        const programStartedAt = performance.now();
        project.program = ts.createProgram({
          rootNames: project.rootNames,
          options: project.options,
          ...(project.projectReferences === undefined
            ? {}
            : { projectReferences: project.projectReferences }),
        });
        this.#metrics.programCreationMs += performance.now() - programStartedAt;
        this.#metrics.programsCreated += 1;
      }
      project.checker ??= project.program.getTypeChecker();
      const absoluteSource = path.join(
        this.#repositoryRoot,
        ...reference.evidence.file.split("/"),
      );
      const source = project.program.getSourceFile(absoluteSource) ??
        project.program.getSourceFiles().find((file) =>
          this.#relativeIndexedPath(file.fileName) === reference.evidence.file,
        );
      if (source === undefined) return null;
      const position = source.getPositionOfLineAndCharacter(
        Math.max(0, reference.evidence.line - 1),
        Math.max(0, reference.evidence.column),
      );
      const lastName = reference.name.split(".").at(-1) ?? reference.name;
      project.callsBySource ??= new Map();
      let calls = project.callsBySource.get(reference.evidence.file);
      if (calls === undefined) {
        this.#metrics.semanticCacheMisses += 1;
        const indexed: SemanticCall[] = [];
        const visit = (node: ts.Node): void => {
          if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
            const expressionStart = node.expression.getStart(source);
            const expressionEnd = node.expression.getEnd();
            const expressionText = node.expression.getText(source);
            const start = source.getLineAndCharacterOfPosition(node.getStart(source));
            const declaration = project.checker!.getResolvedSignature(node)?.declaration;
            indexed.push({
              expressionStart,
              expressionEnd,
              callStartLine: start.line + 1,
              expressionText,
              lastName: expressionText.split(".").at(-1) ?? expressionText,
              target: declaration === undefined ? null : this.#semanticTarget(declaration),
            });
          }
          node.forEachChild(visit);
        };
        visit(source);
        calls = indexed;
        project.callsBySource.set(reference.evidence.file, calls);
        this.#metrics.semanticSourcesIndexed += 1;
      } else {
        this.#metrics.semanticCacheHits += 1;
      }
      const current = calls.find(
        (call) =>
          position >= call.expressionStart &&
          position <= call.expressionEnd &&
          (call.expressionText === reference.name || call.lastName === lastName),
      ) ?? calls.find(
        (call) =>
          call.callStartLine === reference.evidence.line &&
          (call.expressionText === reference.name || call.lastName === lastName),
      );
      const target = current?.target ?? null;
      this.#metrics.semanticResolutionMs += performance.now() - semanticStartedAt;
      return target;
    } catch {
      this.#metrics.semanticResolutionMs += performance.now() - semanticStartedAt;
      return null;
    }
  }

  metrics(): TypeScriptResolutionMetrics {
    return { ...this.#metrics };
  }

  #semanticTarget(
    declaration: ts.SignatureDeclaration | ts.JSDocSignature,
  ): SemanticTarget | null {
    const source = declaration.getSourceFile();
    const filePath = this.#relativeIndexedPath(source.fileName);
    if (filePath === null) return null;
    const nameNode = "name" in declaration ? declaration.name : undefined;
    const name = nameNode?.getText(source) ?? "anonymous";
    const startPosition = declaration.getStart(source);
    const start = source.getLineAndCharacterOfPosition(startPosition);
    const end = source.getLineAndCharacterOfPosition(declaration.getEnd());
    const qualifiedParts = [name];
    let parent: ts.Node | undefined = declaration.parent;
    while (parent !== undefined && !ts.isSourceFile(parent)) {
      if (
        (ts.isClassDeclaration(parent) ||
          ts.isClassExpression(parent) ||
          ts.isInterfaceDeclaration(parent) ||
          ts.isModuleDeclaration(parent)) &&
        parent.name !== undefined
      ) {
        qualifiedParts.unshift(parent.name.getText(source));
      }
      parent = parent.parent;
    }
    return {
      filePath,
      name,
      qualifiedName: qualifiedParts.length > 1 ? qualifiedParts.join(".") : name,
      startLine: start.line + 1,
      startColumn: start.character,
      endLine: end.line + 1,
      endColumn: end.character,
    };
  }
}
