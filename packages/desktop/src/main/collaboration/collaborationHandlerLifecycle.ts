export type CollaborationHandlerLifecycle = {
  run<T>(operation: () => Promise<T>): Promise<T>;
  closeAndDrain(): Promise<void>;
};

export function createCollaborationHandlerLifecycle(): CollaborationHandlerLifecycle {
  let closing = false;
  const pending = new Set<Promise<unknown>>();

  return {
    run<T>(operation: () => Promise<T>): Promise<T> {
      if (closing) {
        return Promise.reject(new Error("Collaboration handlers are shutting down."));
      }
      const result = Promise.resolve().then(operation);
      pending.add(result);
      void result.then(
        () => pending.delete(result),
        () => pending.delete(result)
      );
      return result;
    },

    async closeAndDrain(): Promise<void> {
      closing = true;
      while (pending.size > 0) {
        await Promise.allSettled([...pending]);
      }
    }
  };
}
