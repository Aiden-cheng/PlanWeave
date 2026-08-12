export type LoadingOwner = {
  generation: number;
  loadingKinds: Map<string, number>;
};

export type LoadingLease = {
  generation: number;
  release(): void;
};

/** A lease always releases against the state generation that acquired it. */
export function beginLoading(owner: LoadingOwner, kind: string): LoadingLease {
  const loadingKinds = owner.loadingKinds;
  loadingKinds.set(kind, (loadingKinds.get(kind) ?? 0) + 1);
  let released = false;
  return {
    generation: owner.generation,
    release() {
      if (released) return;
      released = true;
      const count = loadingKinds.get(kind) ?? 0;
      if (count <= 1) loadingKinds.delete(kind);
      else loadingKinds.set(kind, count - 1);
    }
  };
}
