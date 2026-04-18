/**
 * Query Cache for code-intel-mcp
 * 
 * Features:
 * - LRU eviction when max entries reached
 * - TTL-based expiration (default 5 minutes)
 * - Pattern-based invalidation for cache consistency
 * - Statistics tracking (hits, misses, evictions)
 */

interface CacheEntry<T> {
  value: T;
  createdAt: number;
  expiresAt: number;
}

interface CacheStats {
  hits: number;
  misses: number;
  evictions: number;
  size: number;
  maxSize: number;
}

export class QueryCache {
  private cache: Map<string, CacheEntry<unknown>>;
  private maxEntries: number;
  private defaultTtlMs: number;
  private stats: CacheStats;

  constructor(maxEntries = 500, defaultTtlMs = 5 * 60 * 1000) {
    this.cache = new Map();
    this.maxEntries = maxEntries;
    this.defaultTtlMs = defaultTtlMs;
    this.stats = { hits: 0, misses: 0, evictions: 0, size: 0, maxSize: maxEntries };
  }

  get<T>(key: string): T | undefined {
    const entry = this.cache.get(key);
    if (!entry) {
      this.stats.misses++;
      return undefined;
    }
    if (Date.now() > entry.expiresAt) {
      this.cache.delete(key);
      this.stats.misses++;
      this.stats.evictions++;
      this.stats.size = this.cache.size;
      return undefined;
    }
    this.cache.delete(key);
    this.cache.set(key, entry);
    this.stats.hits++;
    return entry.value as T;
  }

  set<T>(key: string, value: T, ttlMs?: number): void {
    if (this.cache.size >= this.maxEntries && !this.cache.has(key)) {
      const oldestKey = this.cache.keys().next().value;
      if (oldestKey !== undefined) {
        this.cache.delete(oldestKey);
        this.stats.evictions++;
      }
    }
    const ttl = ttlMs ?? this.defaultTtlMs;
    this.cache.set(key, {
      value,
      createdAt: Date.now(),
      expiresAt: Date.now() + ttl,
    });
    this.stats.size = this.cache.size;
  }

  invalidate(key: string): boolean {
    const result = this.cache.delete(key);
    this.stats.size = this.cache.size;
    return result;
  }

  invalidatePattern(pattern: string): number {
    let count = 0;
    for (const key of this.cache.keys()) {
      if (key.includes(pattern)) {
        this.cache.delete(key);
        count++;
      }
    }
    this.stats.size = this.cache.size;
    return count;
  }

  invalidateProject(projectPath: string): number {
    return this.invalidatePattern(`project=${projectPath}`);
  }

  clear(): void {
    this.cache.clear();
    this.stats = { hits: 0, misses: 0, evictions: 0, size: 0, maxSize: this.maxEntries };
  }

  getStats(): CacheStats {
    return { ...this.stats, size: this.cache.size };
  }
}

export function makeCacheKey(prefix: string, params: Record<string, unknown>): string {
  const sorted = Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== "")
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`)
    .join("&");
  return `${prefix}?${sorted}`;
}
