export type AuthoritativeRefreshResource = "members" | "assignments";

export type AggregateRefreshApplication = {
  application: "applied" | "superseded";
  resource: AuthoritativeRefreshResource;
  token: number;
};

export class AuthoritativeRefreshArbitrator {
  private readonly latest = { members: 0, assignments: 0 };
  private readonly applied = { members: 0, assignments: 0 };
  private pending: {
    generation: number;
    requiredMembers: number;
    requiredAssignments: number;
  } | null = null;

  next(resource: AuthoritativeRefreshResource): number {
    this.latest[resource] += 1;
    return this.latest[resource];
  }

  isLatest(resource: AuthoritativeRefreshResource, token: number): boolean {
    return this.latest[resource] === token;
  }

  latestToken(resource: AuthoritativeRefreshResource): number {
    return this.latest[resource];
  }

  appliedToken(resource: AuthoritativeRefreshResource): number {
    return this.applied[resource];
  }

  beginAggregate(): void {
    this.pending = null;
  }

  cancelAggregate(): void {
    this.pending = null;
  }

  settleAggregate(generation: number, results: readonly AggregateRefreshApplication[]): boolean {
    const superseded = results.filter(({ application }) => application === "superseded");
    if (superseded.length === 0) return true;
    this.pending = {
      generation,
      requiredMembers: superseded.some(({ resource }) => resource === "members")
        ? this.latest.members
        : 0,
      requiredAssignments: superseded.some(({ resource }) => resource === "assignments")
        ? this.latest.assignments
        : 0
    };
    return this.consumeReady(generation);
  }

  markApplied(resource: AuthoritativeRefreshResource, token: number, generation: number): boolean {
    this.applied[resource] = token;
    return this.consumeReady(generation);
  }

  private consumeReady(generation: number): boolean {
    const pending = this.pending;
    if (
      !pending ||
      pending.generation !== generation ||
      this.applied.members < pending.requiredMembers ||
      this.applied.assignments < pending.requiredAssignments
    ) {
      return false;
    }
    this.pending = null;
    return true;
  }
}
