import { existsSync, readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
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

export interface CompilerPublicApiFacts {
  fingerprint: string;
  exportedSymbols: Readonly<Record<string, string>>;
}

export interface SemanticCompilerInfo {
  version: string;
  source: "repository" | "bundled";
  resolvedPath: string | null;
  targetVersion: string | null;
  fallbackReason:
    | "not_installed"
    | "incompatible_version"
    | "incompatible_api"
    | "load_failed"
    | null;
}

interface SelectedCompiler {
  compiler: typeof ts;
  info: SemanticCompilerInfo;
}

function compatibleCompilerVersion(version: string): boolean {
  const major = Number.parseInt(version.split(".")[0] ?? "", 10);
  return Number.isInteger(major) && major >= 5 && major <= 7;
}

function exposesRequiredCompilerApi(value: Partial<typeof ts>): value is typeof ts {
  return value.sys !== undefined &&
    typeof value.sys.fileExists === "function" &&
    typeof value.sys.readFile === "function" &&
    typeof value.createProgram === "function" &&
    typeof value.resolveModuleName === "function" &&
    typeof value.readConfigFile === "function" &&
    typeof value.parseJsonConfigFileContent === "function" &&
    typeof value.findConfigFile === "function" &&
    typeof value.isCallExpression === "function" &&
    typeof value.isNewExpression === "function" &&
    typeof value.isSourceFile === "function" &&
    value.ModuleKind !== undefined &&
    value.ModuleResolutionKind !== undefined &&
    value.TypeFormatFlags !== undefined &&
    value.SymbolFlags !== undefined &&
    value.SignatureKind !== undefined;
}

function selectTypeScriptCompiler(repositoryRoot: string): SelectedCompiler {
  const bundled: SelectedCompiler = {
    compiler: ts,
    info: {
      version: ts.version,
      source: "bundled",
      resolvedPath: null,
      targetVersion: null,
      fallbackReason: "not_installed",
    },
  };
  try {
    const repositoryRequire = createRequire(path.join(repositoryRoot, "package.json"));
    const resolvedPath = repositoryRequire.resolve("typescript");
    const target = repositoryRequire(resolvedPath) as Partial<typeof ts>;
    if (typeof target.version !== "string") {
      return {
        ...bundled,
        info: { ...bundled.info, resolvedPath, fallbackReason: "load_failed" },
      };
    }
    const targetVersion = target.version;
    if (!compatibleCompilerVersion(targetVersion)) {
      return {
        ...bundled,
        info: {
          ...bundled.info,
          resolvedPath,
          targetVersion,
          fallbackReason: "incompatible_version",
        },
      };
    }
    if (!exposesRequiredCompilerApi(target)) {
      return {
        ...bundled,
        info: {
          ...bundled.info,
          resolvedPath,
          targetVersion,
          fallbackReason: "incompatible_api",
        },
      };
    }
    return {
      compiler: target,
      info: {
        version: targetVersion,
        source: "repository",
        resolvedPath,
        targetVersion,
        fallbackReason: null,
      },
    };
  } catch (error) {
    const missing = (error as NodeJS.ErrnoException).code === "MODULE_NOT_FOUND";
    return {
      ...bundled,
      info: {
        ...bundled.info,
        fallbackReason: missing ? "not_installed" : "load_failed",
      },
    };
  }
}

export function semanticCompilerInfo(repositoryRoot: string): SemanticCompilerInfo {
  return selectTypeScriptCompiler(path.resolve(repositoryRoot)).info;
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
  sourceFilesByIndexedPath?: Map<string, ts.SourceFile>;
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
  semanticResolutionFailures: number;
  publicApiExtractionFailures: number;
  failures: Array<{
    operation: "call_resolution" | "public_api_extraction";
    file: string;
    message: string;
  }>;
  failedFiles: string[];
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
  readonly #compiler: typeof ts;
  readonly #compilerInfo: SemanticCompilerInfo;
  readonly #projectBySource = new Map<string, ProjectContext>();
  readonly #projectByConfig = new Map<string, ProjectContext>();
  readonly #configByDirectory = new Map<string, string | null>();
  #fallbackProject: ProjectContext | null = null;
  readonly #moduleCache = new Map<string, string[]>();
  readonly #relativePathCache = new Map<string, string | null>();
  readonly #workspacePackages = new Map<string, { directory: string; manifest: PackageManifest }>();
  readonly #failedFiles = new Set<string>();
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
    semanticResolutionFailures: 0,
    publicApiExtractionFailures: 0,
    failures: [],
    failedFiles: [],
  };

  constructor(repositoryRoot: string, indexedPaths: ReadonlySet<string>) {
    this.#repositoryRoot = path.resolve(repositoryRoot);
    this.#indexedPaths = indexedPaths;
    const selectedCompiler = selectTypeScriptCompiler(this.#repositoryRoot);
    this.#compiler = selectedCompiler.compiler;
    this.#compilerInfo = selectedCompiler.info;
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
    const cacheKey = path.resolve(absolutePath);
    const cached = this.#relativePathCache.get(cacheKey);
    if (cached !== undefined || this.#relativePathCache.has(cacheKey)) return cached ?? null;
    let resolved = cacheKey;
    try {
      if (existsSync(resolved)) resolved = realpathSync.native(resolved);
    } catch {
      // Broken symlinks and partial installs are ordinary indexing conditions.
    }
    if (!isPathInside(this.#repositoryRoot, resolved)) {
      this.#relativePathCache.set(cacheKey, null);
      return null;
    }
    const relative = toPosixPath(path.relative(this.#repositoryRoot, resolved));
    if (this.#indexedPaths.has(relative)) {
      this.#relativePathCache.set(cacheKey, relative);
      return relative;
    }
    const extension = path.posix.extname(relative);
    const withoutExtension = extension === "" ? relative : relative.slice(0, -extension.length);
    for (const candidate of [
      ...JS_EXTENSIONS.map((suffix) => `${withoutExtension}${suffix}`),
      ...JS_EXTENSIONS.map((suffix) => path.posix.join(relative, `index${suffix}`)),
    ]) {
      if (this.#indexedPaths.has(candidate)) {
        this.#relativePathCache.set(cacheKey, candidate);
        return candidate;
      }
    }
    this.#relativePathCache.set(cacheKey, null);
    return null;
  }

  #sourceFile(project: ProjectContext, indexedPath: string): ts.SourceFile | undefined {
    const absolutePath = path.join(this.#repositoryRoot, ...indexedPath.split("/"));
    const direct = project.program?.getSourceFile(absolutePath);
    if (direct !== undefined) return direct;
    if (project.program === undefined) return undefined;
    if (project.sourceFilesByIndexedPath === undefined) {
      const sourceFiles = new Map<string, ts.SourceFile>();
      for (const sourceFile of project.program.getSourceFiles()) {
        const relativePath = this.#relativeIndexedPath(sourceFile.fileName);
        if (relativePath !== null) sourceFiles.set(relativePath, sourceFile);
      }
      project.sourceFilesByIndexedPath = sourceFiles;
    }
    return project.sourceFilesByIndexedPath.get(indexedPath);
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
      configPath = this.#compiler.findConfigFile(
        sourceDirectory,
        this.#compiler.sys.fileExists,
        "tsconfig.json",
      ) ?? this.#compiler.findConfigFile(
        sourceDirectory,
        this.#compiler.sys.fileExists,
        "jsconfig.json",
      ) ?? null;
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
      const loaded = this.#compiler.readConfigFile(configPath, this.#compiler.sys.readFile);
      if (loaded.error === undefined) {
        const parsed = this.#compiler.parseJsonConfigFileContent(
          loaded.config,
          this.#compiler.sys,
          path.dirname(configPath),
          undefined,
          configPath,
        );
        const compilerOptions = { ...parsed.options };
        // A repository's diagnostic flags must not turn CodeAtlas indexing into an unbounded
        // compiler trace. They do not affect semantic resolution and can emit gigabytes of text.
        delete compilerOptions.traceResolution;
        delete compilerOptions.diagnostics;
        delete compilerOptions.extendedDiagnostics;
        delete compilerOptions.listFiles;
        delete compilerOptions.listEmittedFiles;
        delete compilerOptions.explainFiles;
        delete compilerOptions.generateTrace;
        const project: ProjectContext = {
          configPath,
          options: compilerOptions,
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
    let project = this.#fallbackProject;
    if (project === null) {
      project = {
        configPath: null,
        options: {
          allowJs: true,
          resolveJsonModule: true,
          module: this.#compiler.ModuleKind.NodeNext,
          moduleResolution: this.#compiler.ModuleResolutionKind.NodeNext,
        },
        rootNames: [...this.#indexedPaths]
          .filter((indexedPath) => /\.[cm]?[jt]sx?$/u.test(indexedPath))
          .sort((left, right) => left.localeCompare(right))
          .map((indexedPath) => path.join(this.#repositoryRoot, ...indexedPath.split("/"))),
      };
      this.#fallbackProject = project;
      this.#metrics.projectsDiscovered += 1;
    } else {
      this.#metrics.projectCacheHits += 1;
    }
    this.#projectBySource.set(sourceFile, project);
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
    const resolved = this.#compiler.resolveModuleName(
      specifier,
      absoluteSource,
      project.options,
      this.#compiler.sys,
    )
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
    let programCreationMs = 0;
    try {
      const project = this.#loadProject(reference.evidence.file);
      if (project.program === undefined) {
        const programStartedAt = performance.now();
        project.program = this.#compiler.createProgram({
          rootNames: project.rootNames,
          options: project.options,
          ...(project.projectReferences === undefined
            ? {}
            : { projectReferences: project.projectReferences }),
        });
        programCreationMs = performance.now() - programStartedAt;
        this.#metrics.programCreationMs += programCreationMs;
        this.#metrics.programsCreated += 1;
      }
      project.checker ??= project.program.getTypeChecker();
      const source = this.#sourceFile(project, reference.evidence.file);
      if (source === undefined) {
        this.#metrics.semanticResolutionFailures += 1;
        this.#recordFailure(
          "call_resolution",
          reference.evidence.file,
          new Error("The TypeScript program did not contain the indexed source file."),
        );
        return null;
      }
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
          if (this.#compiler.isCallExpression(node) || this.#compiler.isNewExpression(node)) {
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
      return target;
    } catch (error) {
      this.#metrics.semanticResolutionFailures += 1;
      this.#recordFailure("call_resolution", reference.evidence.file, error);
      return null;
    } finally {
      this.#metrics.semanticResolutionMs += Math.max(
        0,
        performance.now() - semanticStartedAt - programCreationMs,
      );
    }
  }

  /** Returns compiler-resolved exported types, including inferred return/value and JSDoc types. */
  publicApiFacts(sourceFile: string): CompilerPublicApiFacts | null {
    if (!/\.[cm]?[jt]sx?$/u.test(sourceFile)) return null;
    const semanticStartedAt = performance.now();
    let programCreationMs = 0;
    try {
      const project = this.#loadProject(sourceFile);
      if (project.program === undefined) {
        const programStartedAt = performance.now();
        project.program = this.#compiler.createProgram({
          rootNames: project.rootNames,
          options: project.configPath === null
            ? { ...project.options, noLib: true, skipLibCheck: true, types: [] }
            : project.options,
          ...(project.projectReferences === undefined
            ? {}
            : { projectReferences: project.projectReferences }),
        });
        programCreationMs = performance.now() - programStartedAt;
        this.#metrics.programCreationMs += programCreationMs;
        this.#metrics.programsCreated += 1;
      }
      project.checker ??= project.program.getTypeChecker();
      const source = this.#sourceFile(project, sourceFile);
      if (source === undefined) {
        this.#metrics.publicApiExtractionFailures += 1;
        this.#recordFailure(
          "public_api_extraction",
          sourceFile,
          new Error("The TypeScript program did not contain the indexed source file."),
        );
        return null;
      }
      this.#metrics.semanticSourcesIndexed += 1;
      const sourceSymbol = project.checker.getSymbolAtLocation(source) ??
        (source as ts.SourceFile & { symbol?: ts.Symbol }).symbol;
      if (sourceSymbol === undefined) {
        return { fingerprint: "[]", exportedSymbols: {} };
      }
      const formatFlags =
        this.#compiler.TypeFormatFlags.NoTruncation |
        this.#compiler.TypeFormatFlags.WriteTypeArgumentsOfSignature |
        this.#compiler.TypeFormatFlags.UseAliasDefinedOutsideCurrentScope;
      const signatureFlags = this.#compiler.TypeFormatFlags.NoTruncation |
        this.#compiler.TypeFormatFlags.WriteTypeArgumentsOfSignature;
      const entries = project.checker.getExportsOfModule(sourceSymbol)
        .map((exported) => {
          let target = exported;
          if ((exported.flags & this.#compiler.SymbolFlags.Alias) !== 0) {
            try {
              target = project.checker!.getAliasedSymbol(exported);
            } catch {
              target = exported;
            }
          }
          const declaration =
            target.valueDeclaration ??
            target.declarations?.[0] ??
            exported.valueDeclaration ??
            exported.declarations?.[0] ??
            source;
          const valueType = project.checker!.getTypeOfSymbolAtLocation(target, declaration);
          const declaredType = project.checker!.getDeclaredTypeOfSymbol(target);
          const renderType = (type: ts.Type): string =>
            project.checker!.typeToString(type, declaration, formatFlags);
          const renderSignatures = (type: ts.Type): string[] => [
            ...type.getCallSignatures().map((signature) =>
              project.checker!.signatureToString(
                signature,
                declaration,
                signatureFlags,
                this.#compiler.SignatureKind.Call,
              ),
            ),
            ...type.getConstructSignatures().map((signature) =>
              project.checker!.signatureToString(
                signature,
                declaration,
                signatureFlags,
                this.#compiler.SignatureKind.Construct,
              ),
            ),
          ].sort((left, right) => left.localeCompare(right));
          return {
            name: exported.getName(),
            valueType: renderType(valueType),
            declaredType: renderType(declaredType),
            signatures: [...new Set([
              ...renderSignatures(valueType),
              ...renderSignatures(declaredType),
            ])],
          };
        })
        .sort((left, right) => left.name.localeCompare(right.name));
      return {
        fingerprint: JSON.stringify(entries),
        exportedSymbols: Object.fromEntries(
          entries.map((entry) => [entry.name, JSON.stringify(entry)]),
        ),
      };
    } catch (error) {
      this.#metrics.publicApiExtractionFailures += 1;
      this.#recordFailure("public_api_extraction", sourceFile, error);
      return null;
    } finally {
      this.#metrics.semanticResolutionMs += Math.max(
        0,
        performance.now() - semanticStartedAt - programCreationMs,
      );
    }
  }

  metrics(): TypeScriptResolutionMetrics {
    return {
      ...this.#metrics,
      failures: [...this.#metrics.failures],
      failedFiles: [...this.#failedFiles].sort((left, right) => left.localeCompare(right)),
    };
  }

  compilerInfo(): SemanticCompilerInfo {
    return { ...this.#compilerInfo };
  }

  #recordFailure(
    operation: "call_resolution" | "public_api_extraction",
    file: string,
    error: unknown,
  ): void {
    this.#failedFiles.add(file);
    if (this.#metrics.failures.length >= 20) return;
    this.#metrics.failures.push({
      operation,
      file,
      message: error instanceof Error ? error.message : String(error),
    });
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
    while (parent !== undefined && !this.#compiler.isSourceFile(parent)) {
      if (
        (this.#compiler.isClassDeclaration(parent) ||
          this.#compiler.isClassExpression(parent) ||
          this.#compiler.isInterfaceDeclaration(parent) ||
          this.#compiler.isModuleDeclaration(parent)) &&
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
