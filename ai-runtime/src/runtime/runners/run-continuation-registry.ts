import type { RunId } from "../core/types";

export class RunContinuationConflictError extends Error {
  readonly code = "RUN_CONTINUATION_IN_PROGRESS";

  constructor(readonly runId: RunId) {
    super("A continuation is already active for this Runtime Run.");
    this.name = "RunContinuationConflictError";
  }
}

export class RunContinuationRegistry {
  readonly #activeRunIds = new Set<RunId>();

  isActive(runId: RunId): boolean {
    return this.#activeRunIds.has(runId);
  }

  acquire(runId: RunId): () => void {
    if (this.#activeRunIds.has(runId)) {
      throw new RunContinuationConflictError(runId);
    }
    this.#activeRunIds.add(runId);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#activeRunIds.delete(runId);
    };
  }

  async runExclusive<T>(
    runId: RunId,
    operation: () => Promise<T>,
  ): Promise<T> {
    const release = this.acquire(runId);
    try {
      return await operation();
    } finally {
      release();
    }
  }
}
