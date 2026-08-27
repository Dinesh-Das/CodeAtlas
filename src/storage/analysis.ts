import type {
  ArchitectureFinding,
  ArchitectureMetric,
  CommunityMembership,
} from "../analysis/types.js";
import type { AtlasDatabase } from "./database.js";

export function removeStaleAnalysisNodes(
  database: AtlasDatabase,
  currentNodeIds: ReadonlySet<string>,
): void {
  const existing = database
    .prepare(
      `SELECT id FROM nodes
       WHERE kind IN ('feature', 'domain') AND source_type = 'heuristic'`,
    )
    .all() as Array<{ id: string }>;
  const remove = database.prepare("DELETE FROM nodes WHERE id = ?");
  for (const row of existing) {
    if (!currentNodeIds.has(row.id)) remove.run(row.id);
  }
}

export function replaceArchitectureData(
  database: AtlasDatabase,
  metrics: readonly ArchitectureMetric[],
  findings: readonly ArchitectureFinding[],
  communities: readonly CommunityMembership[],
  timestamp: string,
): void {
  const existingFindingDates = new Map(
    (
      database.prepare("SELECT id, created_at FROM architecture_findings").all() as Array<{
        id: string;
        created_at: string;
      }>
    ).map((row) => [row.id, row.created_at]),
  );
  database.exec(
    "DELETE FROM architecture_metrics; DELETE FROM architecture_findings; DELETE FROM dependency_communities;",
  );

  const insertMetric = database.prepare(
    `INSERT INTO architecture_metrics(
       file_node_id, file_path, fan_in, fan_out, dependency_depth,
       cross_domain_dependencies, line_count, recent_commit_count, recent_churn,
       contributor_count, hotspot_score, last_modified_commit, last_modified_date,
       metadata_json, updated_at
     ) VALUES (
       @fileNodeId, @filePath, @fanIn, @fanOut, @dependencyDepth,
       @crossDomainDependencies, @lineCount, @recentCommitCount, @recentChurn,
       @contributorCount, @hotspotScore, @lastModifiedCommit, @lastModifiedDate,
       @metadataJson, @timestamp
     )`,
  );
  for (const metric of metrics) {
    insertMetric.run({
      ...metric,
      metadataJson: JSON.stringify(metric.metadata),
      timestamp,
    });
  }

  const insertFinding = database.prepare(
    `INSERT INTO architecture_findings(
       id, finding_type, severity, title, file_path, line, source_type,
       confidence, evidence_node_ids_json, metadata_json, created_at, updated_at
     ) VALUES (
       @id, @findingType, @severity, @title, @filePath, @line, @sourceType,
       @confidence, @evidenceNodeIdsJson, @metadataJson, @createdAt, @timestamp
     )`,
  );
  for (const finding of findings) {
    insertFinding.run({
      ...finding,
      evidenceNodeIdsJson: JSON.stringify(finding.evidenceNodeIds),
      metadataJson: JSON.stringify(finding.metadata),
      createdAt: existingFindingDates.get(finding.id) ?? timestamp,
      timestamp,
    });
  }

  const insertCommunity = database.prepare(
    `INSERT INTO dependency_communities(
       community_id, node_id, file_path, member_count, updated_at
     ) VALUES (@communityId, @nodeId, @filePath, @memberCount, @timestamp)`,
  );
  for (const membership of communities) {
    insertCommunity.run({ ...membership, timestamp });
  }
}
