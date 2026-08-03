export type CollaborationCoordinationQueue = <T>(operation: () => Promise<T>) => Promise<T>;

export function createCollaborationCoordinationQueue(): CollaborationCoordinationQueue {
  let operationQueue: Promise<unknown> = Promise.resolve();
  return <T>(operation: () => Promise<T>): Promise<T> => {
    const next = operationQueue.catch(() => undefined).then(operation);
    operationQueue = next.then(
      () => undefined,
      () => undefined
    );
    return next;
  };
}
