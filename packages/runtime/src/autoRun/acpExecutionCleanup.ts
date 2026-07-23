export class AcpCleanupTimeoutError extends Error {
  constructor(step: string) {
    super(`ACP ${step} exceeded the cleanup deadline.`);
    this.name = "AcpCleanupTimeoutError";
  }
}

export async function withinAcpCleanupDeadline<T>(
  operation: Promise<T>,
  deadline: number,
  step: string,
  stepLimitMs?: number
): Promise<T> {
  const remaining = Math.max(0, deadline - Date.now());
  const timeoutMs = Math.min(remaining, stepLimitMs ?? remaining);
  if (timeoutMs <= 0) throw new AcpCleanupTimeoutError(step);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new AcpCleanupTimeoutError(step)), timeoutMs);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
