/** Default slice size: 256 KiB (keeps JSON-RPC base64 response ~350 KiB, safely under 1 MiB cap) */
export const DEFAULT_CHUNK_BYTES = 256 * 1024;
/** Hard slice ceiling: 512 KiB */
export const MAX_CHUNK_BYTES = 512 * 1024;
/** Antigravity allows at most 4 in-flight `callServerTool` calls per app; cap strictly at 3 */
export const MAX_APP_CONCURRENT_REQUESTS = 3;

/**
 * Pure browser/Node isomorphic bounded-concurrency scheduler (`<= 3` in-flight requests).
 * Zero `node:*` imports so Vite singlefile UI bundles cleanly without browser shims.
 */
export class BoundedConcurrencyQueue {
  private readonly maxConcurrent: number;
  private activeCount = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(maxConcurrent = MAX_APP_CONCURRENT_REQUESTS) {
    this.maxConcurrent = Math.max(1, Math.min(MAX_APP_CONCURRENT_REQUESTS, Math.floor(maxConcurrent)));
  }

  public get inFlight(): number {
    return this.activeCount;
  }

  public async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.activeCount >= this.maxConcurrent) {
      await new Promise<void>((resolve) => {
        this.waiters.push(resolve);
      });
    }
    this.activeCount++;
    try {
      return await task();
    } finally {
      this.activeCount--;
      const next = this.waiters.shift();
      if (next) next();
    }
  }
}
