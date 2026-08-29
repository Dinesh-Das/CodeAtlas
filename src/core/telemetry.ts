import { performance } from "node:perf_hooks";

export const INDEX_PHASES = [
  "ignore_config_loading",
  "index_lock_wait",
  "repository_discovery",
  "fingerprinting",
  "git_status_freshness",
  "file_reading",
  "tree_sitter_parsing",
  "symbol_extraction",
  "reference_extraction",
  "typescript_project_discovery",
  "typescript_program_creation",
  "typescript_semantic_resolution",
  "module_import_resolution",
  "candidate_generation",
  "graph_resolution",
  "database_writes",
  "fts_search_indexing",
  "architecture_domain_feature_analysis",
  "community_detection",
  "cycle_detection",
  "hotspot_analysis",
  "git_history_analysis",
  "finalization",
] as const;

export type IndexPhaseName = (typeof INDEX_PHASES)[number];

export interface IndexPhaseMetric {
  phase: IndexPhaseName;
  elapsedMs: number;
  workMs: number | null;
  itemsProcessed: number;
  itemsSkipped: number;
  cacheHits: number;
  cacheMisses: number;
  rssBytes: number;
  heapUsedBytes: number;
  peakRssBytes: number;
  inclusive: boolean;
}

export interface IndexProgress {
  phase: IndexPhaseName;
  status: "started" | "running" | "completed";
  completed: number;
  total: number | null;
  elapsedMs: number;
}

interface RecordOptions {
  workMs?: number | null;
  itemsProcessed?: number;
  itemsSkipped?: number;
  cacheHits?: number;
  cacheMisses?: number;
  inclusive?: boolean;
}

export class IndexTelemetry {
  readonly #metrics = new Map<IndexPhaseName, IndexPhaseMetric>();
  readonly #started = new Map<IndexPhaseName, number>();
  readonly #onProgress: ((progress: IndexProgress) => void) | undefined;
  readonly #memorySampler: NodeJS.Timeout;
  #peakRssBytes: number;
  #lastProgressAt = 0;
  #finished = false;

  constructor(onProgress?: (progress: IndexProgress) => void) {
    this.#onProgress = onProgress;
    this.#peakRssBytes = process.memoryUsage().rss;
    this.#memorySampler = setInterval(() => this.sampleMemory(), 25);
    this.#memorySampler.unref();
  }

  sampleMemory(): void {
    this.#peakRssBytes = Math.max(this.#peakRssBytes, process.memoryUsage().rss);
  }

  start(phase: IndexPhaseName, total: number | null = null): void {
    const started = performance.now();
    this.#started.set(phase, started);
    this.#onProgress?.({
      phase,
      status: "started",
      completed: 0,
      total,
      elapsedMs: 0,
    });
  }

  progress(phase: IndexPhaseName, completed: number, total: number | null): void {
    const now = performance.now();
    if (now - this.#lastProgressAt < 100 && completed !== total) return;
    this.#lastProgressAt = now;
    this.#onProgress?.({
      phase,
      status: "running",
      completed,
      total,
      elapsedMs: now - (this.#started.get(phase) ?? now),
    });
  }

  end(phase: IndexPhaseName, options: RecordOptions = {}): number {
    const elapsedMs = performance.now() - (this.#started.get(phase) ?? performance.now());
    this.record(phase, elapsedMs, options);
    return elapsedMs;
  }

  record(phase: IndexPhaseName, elapsedMs: number, options: RecordOptions = {}): void {
    this.sampleMemory();
    const memory = process.memoryUsage();
    const metric: IndexPhaseMetric = {
      phase,
      elapsedMs: Number(elapsedMs.toFixed(2)),
      workMs:
        options.workMs === undefined || options.workMs === null
          ? null
          : Number(options.workMs.toFixed(2)),
      itemsProcessed: options.itemsProcessed ?? 0,
      itemsSkipped: options.itemsSkipped ?? 0,
      cacheHits: options.cacheHits ?? 0,
      cacheMisses: options.cacheMisses ?? 0,
      rssBytes: memory.rss,
      heapUsedBytes: memory.heapUsed,
      peakRssBytes: this.#peakRssBytes,
      inclusive: options.inclusive ?? false,
    };
    this.#metrics.set(phase, metric);
    this.#onProgress?.({
      phase,
      status: "completed",
      completed: metric.itemsProcessed,
      total: metric.itemsProcessed + metric.itemsSkipped,
      elapsedMs: metric.elapsedMs,
    });
  }

  finish(): IndexPhaseMetric[] {
    if (this.#finished) {
      return INDEX_PHASES.map((phase) => this.#metrics.get(phase)!);
    }
    this.#finished = true;
    clearInterval(this.#memorySampler);
    this.sampleMemory();
    for (const phase of INDEX_PHASES) {
      if (!this.#metrics.has(phase)) this.record(phase, 0);
    }
    return INDEX_PHASES.map((phase) => this.#metrics.get(phase)!);
  }
}
