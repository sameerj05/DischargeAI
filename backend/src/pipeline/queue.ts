import PQueue from "p-queue";

/**
 * In-process job runner, concurrency 1, with the SQL `jobs` table as the source of truth for status.
 * Boot re-enqueues unfinished jobs (see context.ts); the raw input for jobs that never reached the
 * `raw` document is gone after a restart and those jobs are marked failed honestly.
 */
export class JobQueue {
  private readonly queue = new PQueue({ concurrency: 1 });
  private readonly inFlight = new Set<string>();

  add(jobId: string, run: () => Promise<void>): void {
    if (this.inFlight.has(jobId)) return;
    this.inFlight.add(jobId);
    void this.queue.add(async () => {
      try {
        await run();
      } finally {
        this.inFlight.delete(jobId);
      }
    });
  }

  /** Resolves once every queued job has finished. Tests use this instead of polling. */
  onIdle(): Promise<void> {
    return this.queue.onIdle();
  }

  get size(): number {
    return this.queue.size + this.queue.pending;
  }
}
