import { sha256 } from "../core/hashing.js";
import type { ArchitectureFinding, FileGraph } from "./types.js";

interface SearchFrame {
  filePath: string;
  parent: string | null;
  neighbors: string[];
  nextNeighbor: number;
}

function stronglyConnectedComponents(graph: FileGraph): string[][] {
  const indexByFile = new Map<string, number>();
  const lowLink = new Map<string, number>();
  const componentStack: string[] = [];
  const onStack = new Set<string>();
  const components: string[][] = [];
  let nextIndex = 0;

  const enter = (filePath: string, parent: string | null): SearchFrame => {
    indexByFile.set(filePath, nextIndex);
    lowLink.set(filePath, nextIndex);
    nextIndex += 1;
    componentStack.push(filePath);
    onStack.add(filePath);
    return {
      filePath,
      parent,
      neighbors: [...(graph.outgoing.get(filePath) ?? [])].sort((left, right) =>
        left.localeCompare(right),
      ),
      nextNeighbor: 0,
    };
  };

  for (const start of [...graph.fileNodes.keys()].sort((left, right) =>
    left.localeCompare(right),
  )) {
    if (indexByFile.has(start)) continue;
    const searchStack: SearchFrame[] = [enter(start, null)];
    while (searchStack.length > 0) {
      const frame = searchStack.at(-1)!;
      const target = frame.neighbors[frame.nextNeighbor];
      if (target !== undefined) {
        frame.nextNeighbor += 1;
        if (!indexByFile.has(target)) {
          searchStack.push(enter(target, frame.filePath));
        } else if (onStack.has(target)) {
          lowLink.set(
            frame.filePath,
            Math.min(lowLink.get(frame.filePath)!, indexByFile.get(target)!),
          );
        }
        continue;
      }

      searchStack.pop();
      if (frame.parent !== null) {
        lowLink.set(
          frame.parent,
          Math.min(lowLink.get(frame.parent)!, lowLink.get(frame.filePath)!),
        );
      }
      if (lowLink.get(frame.filePath) !== indexByFile.get(frame.filePath)) continue;
      const component: string[] = [];
      while (componentStack.length > 0) {
        const member = componentStack.pop()!;
        onStack.delete(member);
        component.push(member);
        if (member === frame.filePath) break;
      }
      const selfCycle = component.length === 1 &&
        graph.outgoing.get(component[0]!)?.has(component[0]!) === true;
      if (component.length > 1 || selfCycle) {
        components.push(component.sort((left, right) => left.localeCompare(right)));
      }
    }
  }
  return components;
}

export function findDependencyCycles(
  repositoryId: string,
  graph: FileGraph,
): ArchitectureFinding[] {
  const components = stronglyConnectedComponents(graph);
  const componentByFile = new Map<string, number>();
  const linksByComponent = components.map(() => [] as FileGraph["links"]);
  for (const [componentId, files] of components.entries()) {
    for (const filePath of files) componentByFile.set(filePath, componentId);
  }
  for (const link of graph.links) {
    const sourceComponent = componentByFile.get(link.sourceFile);
    if (
      sourceComponent !== undefined &&
      sourceComponent === componentByFile.get(link.targetFile)
    ) {
      linksByComponent[sourceComponent]!.push(link);
    }
  }

  return components.map((files, componentId) => {
    const internalLinks = linksByComponent[componentId]!;
    const evidenceLink = internalLinks[0];
    const filePath = evidenceLink?.filePath ?? files[0]!;
    const line = evidenceLink?.line ?? 1;
    let confidence = 0.95;
    for (const link of internalLinks) confidence = Math.min(confidence, link.confidence);
    return {
      id: sha256(`${repositoryId}:finding:cycle:${files.join("\n")}`),
      findingType: "circular_dependency",
      severity: files.length >= 4 ? "high" : "medium",
      title: `Circular dependency spans ${files.length} files`,
      filePath,
      line,
      sourceType: "heuristic",
      confidence,
      evidenceNodeIds: files
        .map((member) => graph.fileNodes.get(member)?.id)
        .filter((id): id is string => id !== undefined),
      metadata: {
        evidence: { source_type: "heuristic", file: filePath, line, column: 0 },
        signal: "circular_dependency",
        files,
        edge_ids: internalLinks.map((link) => link.id),
      },
    };
  });
}
