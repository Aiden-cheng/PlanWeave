export class ExecutorCancelledError extends Error {
  constructor(message = "Executor cancelled.") {
    super(message);
    this.name = "AbortError";
  }
}

export function isExecutorCancelledError(error: unknown): error is ExecutorCancelledError {
  return error instanceof ExecutorCancelledError;
}
