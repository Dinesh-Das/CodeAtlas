import { sha256 } from "../core/hashing.js";
import type { ArchitectureFinding, FileGraph } from "./types.js";

export function findDependencyCycles(
  repositoryId: string,
  graph: FileGraph,
): ArchitectureFinding[] {
  const indexByFile = new Map<string, number>();
  const lowLink = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const components: string[][] = [];
  let nextIndex = 0;

  const connect = (filePath: string): void => {
    indexByFile.set(filePath, nextIndex);
    lowLink.set(filePath, nextIndex);
    nextIndex += 1;
    stack.push(filePath);
    onStack.add(filePath);

    for (const target of [...(graph.outgoing.get(filePath) ?? [])].sort((left, right) =>
      left.localeCompare(right),
    )) {
      if (!indexByFile.has(target)) {
        connect(target);
        lowLink.set(filePath, Math.min(lowLink.get(filePath)!, lowLink.get(target)!));
      } else if (onStack.has(target)) {
        lowLink.set(filePath, Math.min(lowLink.get(filePath)!, indexByFile.get(target)!));
      }
    }

    if (lowLink.get(filePath) !== indexByFile.get(filePath)) return;
    const component: string[] = [];
    while (stack.length > 0) {
      const member = stack.pop()!;
      onStack.delete(member);
      component.push(member);
      if (member === filePath) break;
    }
    const selfCycle =
      component.length === 1 && graph.outgoing.get(component[0]!)?.has(component[0]!) === true;
    if (component.length > 1 || selfCycle) {
      components.push(component.sort((left, right) => left.localeCompare(right)));
    }
  };

  for (const filePath of [...graph.fileNodes.keys()].sort((left, right) =>
    left.localeCompare(right),
  )) {
    if (!indexByFile.has(filePath)) connect(filePath);
  }

  return components.map((files) => {
    const evidenceLink = graph.links.find(
      (link) => files.includes(link.sourceFile) && files.includes(link.targetFile),
    );
    const filePath = evidenceLink?.filePath ?? files[0]!;
    const line = evidenceLink?.line ?? 1;
    return {
      id: sha256(`${repositoryId}:finding:cycle:${files.join("\n")}`),
      findingType: "circular_dependency",
      severity: files.length >= 4 ? "high" : "medium",
      title: `Circular dependency spans ${files.length} files`,
      filePath,
      line,
      sourceType: "heuristic",
      confidence: Math.min(...graph.links
        .filter((link) => files.includes(link.sourceFile) && files.includes(link.targetFile))
        .map((link) => link.confidence), 0.95),
      evidenceNodeIds: files
        .map((member) => graph.fileNodes.get(member)?.id)
        .filter((id): id is string => id !== undefined),
      metadata: {
        evidence: { source_type: "heuristic", file: filePath, line, column: 0 },
        signal: "circular_dependency",
        files,
        edge_ids: graph.links
          .filter((link) => files.includes(link.sourceFile) && files.includes(link.targetFile))
          .map((link) => link.id),
      },
    };
  });
}
