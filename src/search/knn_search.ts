// --- START OF FILE knn_search_partitioned.ts ---

import * as distanceMetrics from "../utils/distance_metrics";
import { createTimer } from "../utils/profiling";

import { PartitionedVectorDB } from "../vector/partitioned_vector_db"; // Import Partitioned DB
import { Vector, SearchResult, SearchOptions, DistanceMetric, KNNOptionsPartitioned, KNNStatsPartitioned } from "../types";
import { LRUCache } from "lru-cache"; // Still using cache for results

/**
 * KNNEngineSearch using PartitionedVectorDB.
 * Note: Search will only be performed on partitions that are loaded into memory (LRU cache).
 */
/**
 * A class that performs K-nearest neighbors (KNN) search operations using a partitioned vector database.
 * 
 * KNNEngineSearch provides an efficient way to find similar vectors in a high-dimensional space
 * by using a partitioned database architecture. It supports different distance metrics, result caching,
 * and maintains performance statistics.
 * 
 * Features:
 * - Works with partitioned vector databases for scalable search operations
 * - Caches search results to improve performance for repeated queries
 * - Maintains statistics for performance monitoring
 * - Supports various distance metrics (euclidean by default)
 * 
 * @example
 * ```typescript
 * const db = new PartitionedVectorDB(...);
 * const knnSearch = new KNNEngineSearch(db, { metric: 'cosine' });
 * 
 * // Perform a search
 * const results = await knnSearch.findNearest(queryVector, 10, { filter: myFilter });
 * 
 * // Get performance stats
 * const stats = knnSearch.getStats();
 * ```
 */
export class KNNEngineSearch {
  private db: PartitionedVectorDB; // Using PartitionedVectorDB
  private options: Required<KNNOptionsPartitioned>;
  private distanceFunc: (a: Vector, b: Vector) => number; // Still need distance function for reference
  private timer: ReturnType<typeof createTimer>;
  private resultCache: LRUCache<string, SearchResult[]>;
  private stats: {
    calls: number;
    totalTime: number;
    lastSearchTime: number;
    cacheHits: number;
    cacheMisses: number;
  };

  constructor(
    db: PartitionedVectorDB, // Accept PartitionedVectorDB
    options: KNNOptionsPartitioned = {}
  ) {
    this.db = db;

    // Simplified default values
    const defaults = {
      metric: "euclidean" as DistanceMetric, // Default metric
      cacheResults: true,
    };

    // Merge defaults with options
    this.options = {
      ...defaults,
      ...Object.fromEntries(
        Object.entries(options).filter(([_, v]) => v !== undefined)
      ),
    } as Required<KNNOptionsPartitioned>;

    // Get distance function (may not be used directly but kept for reference)
    this.distanceFunc = distanceMetrics.getDistanceFunction(
      this.options.metric
    );

    // No longer caching normalized vectors
    // this.normalizedCache = new Map();
    // this.vectorNorms = new Map();
    // No more workers
    // this.workers = [];
    this.timer = createTimer();

    // Result cache is still useful
    this.resultCache = new LRUCache<string, SearchResult[]>({
      max: 1000, // Cache size can be adjusted
    });

    // Initialize statistics
    this.stats = {
      calls: 0,
      totalTime: 0,
      lastSearchTime: 0,
      cacheHits: 0,
      cacheMisses: 0,
    };

    // No more norm precomputation
    // if (this.options.metric === 'cosine') {
    //   this._precomputeNorms();
    // }
  }

  /**
   * Find k-nearest neighbors for the query vector.
   * Search is performed on partitions currently loaded in PartitionedVectorDB.
   */
  async findNearest(
    query: Vector,
    k: number = 10,
    options: SearchOptions = {} // Options passed down to DB (filter, probes, etc.)
  ): Promise<SearchResult[]> {
    const timer = this.timer;
    timer.start("knn_partitioned_search");
    this.stats.calls++;

    const typedQuery =
      query instanceof Float32Array ? query : new Float32Array(query);

    // Check result cache
    if (this.options.cacheResults) {
      const cacheKey = this._getCacheKey(typedQuery, k, options);
      const cachedResults = this.resultCache.get(cacheKey);
      if (cachedResults) {
        this.stats.cacheHits++;
        const searchTime = timer.getElapsed("knn_partitioned_search");
        this.stats.lastSearchTime = searchTime;
        this.stats.totalTime += searchTime;
        timer.stop("knn_partitioned_search"); // Stop timer here for cache hit
        return [...cachedResults]; // Return a copy
      }
      this.stats.cacheMisses++;
    }

    // Call findNearest of PartitionedVectorDB
    // PartitionedDB will handle searching on loaded partitions,
    // applying filters, metrics, probes and aggregating results.
    let results: SearchResult[];
    try {
      results = await this.db.findNearest(typedQuery, k, {
        filter: options.filter, // Pass down filter
        distanceMetric: this.options.metric, // Use metric from KNN options
        probes: options.probes, // Pass down probes if included in SearchOptions
        // Other options in SearchOptions can also be passed if PartitionedDB supports them
      });
    } catch (error) {
      console.error("Error during PartitionedDB findNearest:", error);
      timer.stop("knn_partitioned_search"); // Stop timer on error
      // May throw error or return empty array depending on requirements
      throw error;
    }

    // Cache results if enabled
    if (this.options.cacheResults) {
      const cacheKey = this._getCacheKey(typedQuery, k, options);
      this.resultCache.set(cacheKey, [...results]); // Store a copy
    }

    const searchTime = timer.getElapsed("knn_partitioned_search");
    this.stats.lastSearchTime = searchTime;
    this.stats.totalTime += searchTime;
    timer.stop("knn_partitioned_search");

    return results;
  }

  /**
   * Create cache key (keeping original logic)
   * @private
   */
  private _getCacheKey(
    query: Vector,
    k: number,
    options: SearchOptions
  ): string {
    const queryHash = Array.from(query)
      .map((v) => v.toFixed(4))
      .join(",");
    const filterInfo = options.filter
      ? `filterHash:${options.filter.toString().length}`
      : "noFilter"; // Simplified filter hash
    const probesInfo = options.probes ? `probes${options.probes}` : "";
    return `${queryHash}_k${k}_${this.options.metric}_${filterInfo}_${probesInfo}`;
  }

  /**
   * Get statistics about KNN search (simplified version)
   */
  getStats(): KNNStatsPartitioned {
    return {
      calls: this.stats.calls,
      totalTime: this.stats.totalTime,
      avgTime:
        this.stats.calls > 0 ? this.stats.totalTime / this.stats.calls : 0,
      lastSearchTime: this.stats.lastSearchTime,
      cacheHits: this.stats.cacheHits,
      cacheMisses: this.stats.cacheMisses,
      cachedResultsCount: this.resultCache.size,
      options: { ...this.options },
    };
  }

  /**
   * Clear result cache
   */
  clearCache(): void {
    // No more norm/normalized cache
    // this.normalizedCache.clear();
    // this.vectorNorms.clear();
    this.resultCache.clear();
    console.log("KNN result cache cleared.");
  }

  /**
   * Release resources (mainly cache)
   */
  close(): void {
    // No more workers to terminate
    this.clearCache();
    console.log("KNNPartitioned closed (caches cleared).");
    // Note: Don't call db.close() here, PartitionedDB management is external.
  }
}
