import { describe, expect, it } from "vitest";
import type {
  AssignmentDisplayProjection,
  EligibleAssigneesResponse,
  HumanMembershipView,
  WorkItemRef
} from "@planweave-ai/collaboration-contracts";
import {
  assigneeDisplayLabelsFromTranslator,
  buildAssigneeCurrentDisplay,
  buildAssigneePickerViewModel,
  buildAssigneeSections,
  canAssignWork,
  filterAssigneeOptions,
  resolveAssigneePickerMode,
  targetsEqual,
  type AssigneeDisplayLabels
} from "../renderer/collaboration/assignmentViewModels";
import { createTranslator } from "../renderer/i18n";
import type { CollaborationHostProjection } from "../shared/collaborationReadModels";
import type { CollaborationStatus } from "../shared/collaboration";

const taskItem: WorkItemRef = { kind: "task", canvasId: "canvas-1", taskId: "T-1" };
const blockItem: WorkItemRef = { kind: "block", canvasId: "canvas-1", blockRef: "T-1#B-001" };

function member(
  partial: Partial<HumanMembershipView> &
    Pick<HumanMembershipView, "humanPrincipalId" | "displayName" | "role">
): HumanMembershipView {
  return {
    membershipId: partial.membershipId ?? `m-${partial.humanPrincipalId}`,
    projectId: partial.projectId ?? "project-1",
    humanPrincipalId: partial.humanPrincipalId,
    displayName: partial.displayName,
    role: partial.role,
    createdAt: partial.createdAt ?? "2030-01-01T00:00:00.000Z",
    updatedAt: partial.updatedAt ?? "2030-01-01T00:00:00.000Z"
  };
}

function statusFor(principalId: string): CollaborationStatus {
  return {
    profiles: [
      {
        profileId: "profile-1",
        displayName: "Demo",
        serverBaseUrl: "https://example.test",
        projectId: "project-1",
        allowInsecureTransport: false,
        hasDeviceCredential: true,
        deviceCredentialPersistence: "persisted",
        deviceCredentialId: "device-1",
        humanPrincipalId: principalId,
        updatedAt: "2030-01-01T00:00:00.000Z"
      }
    ],
    activeProfileId: "profile-1",
    credentialStorage: "available",
    nonPersistenceWarning: null,
    session: {
      phase: "connected",
      activeProfileId: "profile-1",
      detail: null,
      lastErrorCode: null,
      lastErrorMessage: null
    },
    updatedAt: "2030-01-01T00:00:00.000Z"
  };
}

describe("assignmentViewModels", () => {
  it("builds Task sections with people only (no machine targets)", () => {
    const members = [
      member({ humanPrincipalId: "human-1", displayName: "Ada", role: "owner" }),
      member({ humanPrincipalId: "human-2", displayName: "Bob", role: "member" })
    ];
    const hosts: CollaborationHostProjection[] = [
      {
        hostId: "host-1",
        projectId: "project-1",
        displayName: "Builder",
        online: true,
        revoked: false,
        authorizedForProject: true,
        exists: true,
        capabilities: ["shell"]
      }
    ];
    const sections = buildAssigneeSections({
      workItem: taskItem,
      assignment: null,
      members,
      hosts,
      eligible: null
    });
    expect(sections.map((section) => section.id)).toEqual(["unassigned", "people"]);
    expect(sections.flatMap((section) => section.options).some((o) => o.kind === "exact_host")).toBe(
      false
    );
    expect(
      sections.flatMap((section) => section.options).some((o) => o.kind === "automatic_host")
    ).toBe(false);
    expect(sections.find((s) => s.id === "people")?.options.map((o) => o.label)).toEqual([
      "Ada",
      "Bob"
    ]);
  });

  it("builds Block sections with people, compatible hosts, and automatic selection", () => {
    const members = [member({ humanPrincipalId: "human-1", displayName: "Ada", role: "owner" })];
    const eligible: EligibleAssigneesResponse = {
      workItem: blockItem,
      humans: [
        {
          projectId: "project-1",
          humanPrincipalId: "human-1",
          membershipActive: true,
          displayName: "Ada"
        }
      ],
      hosts: [
        {
          projectId: "project-1",
          hostId: "host-ok",
          exists: true,
          revoked: false,
          authorizedForProject: true,
          online: true,
          capabilities: ["shell", "git"],
          displayName: "Ready Host",
          capacityRemaining: 2
        },
        {
          projectId: "project-1",
          hostId: "host-offline",
          exists: true,
          revoked: false,
          authorizedForProject: true,
          online: false,
          capabilities: ["shell"],
          displayName: "Offline Host",
          capacityRemaining: 1
        },
        {
          projectId: "project-1",
          hostId: "host-cap",
          exists: true,
          revoked: false,
          authorizedForProject: true,
          online: true,
          capabilities: ["shell"],
          displayName: "Full Host",
          capacityRemaining: 0
        }
      ],
      nextHumanCursor: null,
      nextHostCursor: null
    };

    const sections = buildAssigneeSections({
      workItem: blockItem,
      assignment: null,
      members,
      hosts: [],
      eligible
    });
    expect(sections.map((s) => s.id)).toEqual(["unassigned", "people", "hosts", "automatic"]);
    const hosts = sections.find((s) => s.id === "hosts")?.options ?? [];
    const offline = hosts.find((h) => h.id === "exact_host:host-offline");
    expect(offline?.selectable).toBe(true);
    expect(offline?.warningReason).toBe("host_offline");
    const full = hosts.find((h) => h.id === "exact_host:host-cap");
    expect(full?.selectable).toBe(true);
    expect(full?.warningReason).toBe("host_at_capacity");
    expect(sections.find((s) => s.id === "automatic")?.options[0]?.target).toEqual({
      kind: "automatic_host"
    });
  });

  it("marks incompatible or revoked hosts as not selectable with explicit reasons", () => {
    const sections = buildAssigneeSections({
      workItem: blockItem,
      assignment: null,
      members: [],
      hosts: [
        {
          hostId: "host-revoked",
          projectId: "project-1",
          displayName: "Revoked",
          online: true,
          revoked: true,
          authorizedForProject: true,
          exists: true,
          capabilities: ["shell"]
        },
        {
          hostId: "host-mismatch",
          projectId: "project-1",
          displayName: "Mismatch",
          online: true,
          revoked: false,
          authorizedForProject: true,
          exists: true,
          capabilities: ["shell"]
        }
      ],
      eligible: null,
      requiredCapabilities: ["gpu"]
    });
    const hosts = sections.find((s) => s.id === "hosts")?.options ?? [];
    expect(hosts.find((h) => h.id === "exact_host:host-revoked")?.unavailableReason).toBe(
      "host_revoked"
    );
    expect(hosts.find((h) => h.id === "exact_host:host-mismatch")?.unavailableReason).toBe(
      "host_capability_mismatch"
    );
    expect(hosts.every((h) => !h.selectable)).toBe(true);
  });

  it("surfaces inactive current human assignment without inventing a new target", () => {
    const assignment: AssignmentDisplayProjection = {
      projectId: "project-1",
      workItem: taskItem,
      target: { kind: "human", humanPrincipalId: "gone" },
      revision: 3,
      human: {
        humanPrincipalId: "gone",
        displayName: "Former",
        membershipActive: false
      },
      availability: { status: "invalid", reason: "human_membership_inactive" }
    };
    const current = buildAssigneeCurrentDisplay(assignment);
    expect(current.label).toBe("Former");
    expect(current.issueReason).toBe("human_membership_inactive");
    expect(current.revision).toBe(3);

    const sections = buildAssigneeSections({
      workItem: taskItem,
      assignment,
      members: [],
      hosts: [],
      eligible: null
    });
    const option = sections
      .flatMap((s) => s.options)
      .find((o) => o.id === "human:gone");
    expect(option?.selectable).toBe(false);
    expect(option?.unavailableReason).toBe("human_membership_inactive");
    expect(option?.selected).toBe(true);
  });

  it("filters options by typeahead query", () => {
    const sections = buildAssigneeSections({
      workItem: taskItem,
      assignment: null,
      members: [
        member({ humanPrincipalId: "h1", displayName: "Ada Lovelace", role: "owner" }),
        member({ humanPrincipalId: "h2", displayName: "Grace Hopper", role: "member" })
      ],
      hosts: [],
      eligible: null
    });
    const filtered = filterAssigneeOptions(sections, "hop");
    expect(filtered.map((o) => o.label)).toEqual(["Grace Hopper"]);
  });

  it("authorizes only connected project members to edit", () => {
    const members = [member({ humanPrincipalId: "human-1", displayName: "Ada", role: "member" })];
    expect(canAssignWork({ status: statusFor("human-1"), members })).toBe(true);
    expect(canAssignWork({ status: statusFor("outsider"), members })).toBe(false);
    expect(canAssignWork({ status: null, members })).toBe(false);
  });

  it("maps modes including stale conflict and offline", () => {
    expect(
      resolveAssigneePickerMode({
        status: statusFor("human-1"),
        syncPhase: "stale_conflict",
        staleConflict: false,
        loading: false
      })
    ).toBe("stale_conflict");
    expect(
      resolveAssigneePickerMode({
        status: {
          ...statusFor("human-1"),
          session: { ...statusFor("human-1").session, phase: "connecting", detail: "reconnecting" }
        },
        syncPhase: "reconnecting",
        staleConflict: false,
        loading: false
      })
    ).toBe("connecting");
  });

  it("blocks edit on role failure and keeps expected revision from assignment", () => {
    const assignment: AssignmentDisplayProjection = {
      projectId: "project-1",
      workItem: taskItem,
      target: { kind: "unassigned" },
      revision: 4,
      availability: { status: "unassigned", reason: "unassigned" }
    };
    const vm = buildAssigneePickerViewModel({
      workItem: taskItem,
      assignment,
      members: [member({ humanPrincipalId: "human-1", displayName: "Ada", role: "owner" })],
      hosts: [],
      eligible: null,
      status: statusFor("outsider"),
      syncPhase: "ready",
      loading: false,
      pending: false,
      staleConflict: false,
      lastError: null
    });
    expect(vm.canEdit).toBe(false);
    expect(vm.editBlockedReason).toBe("role_insufficient");
    expect(vm.expectedRevision).toBe(4);
    expect(vm.sections.flatMap((s) => s.options).every((o) => !o.selectable)).toBe(true);
  });

  it("compares assignment targets by identity", () => {
    expect(
      targetsEqual(
        { kind: "human", humanPrincipalId: "a" },
        { kind: "human", humanPrincipalId: "a" }
      )
    ).toBe(true);
    expect(targetsEqual({ kind: "unassigned" }, { kind: "automatic_host" })).toBe(false);
  });

  it("localizes primary labels and secondary host hints via catalog labels", () => {
    const zhLabels: AssigneeDisplayLabels = assigneeDisplayLabelsFromTranslator(
      createTranslator("zh-CN")
    );
    const enLabels = assigneeDisplayLabelsFromTranslator(createTranslator("en"));

    expect(zhLabels.unassigned).toBe("未分配");
    expect(zhLabels.automaticHost).toBe("自动 Host");
    expect(zhLabels.automaticHostSelection).toBe("自动选择 Host");
    expect(zhLabels.inactiveMembership).toBe("成员资格已失效");
    expect(zhLabels.hostOffline).toBe("离线");
    expect(zhLabels.hostAtCapacity).toBe("已满载");
    expect(enLabels.unassigned).toBe("Unassigned");
    expect(enLabels.automaticHost).toBe("Automatic host");

    const zhCurrent = buildAssigneeCurrentDisplay(null, zhLabels);
    expect(zhCurrent.label).toBe("未分配");

    const automaticAssignment: AssignmentDisplayProjection = {
      projectId: "project-1",
      workItem: blockItem,
      target: { kind: "automatic_host" },
      revision: 1,
      availability: { status: "pending", reason: "automatic_pending_selection" }
    };
    expect(buildAssigneeCurrentDisplay(automaticAssignment, zhLabels).label).toBe("自动 Host");

    const sections = buildAssigneeSections({
      workItem: blockItem,
      assignment: null,
      members: [],
      hosts: [],
      eligible: {
        workItem: blockItem,
        humans: [
          {
            projectId: "project-1",
            humanPrincipalId: "gone",
            membershipActive: false,
            displayName: "Former"
          }
        ],
        hosts: [
          {
            projectId: "project-1",
            hostId: "host-offline",
            exists: true,
            revoked: false,
            authorizedForProject: true,
            online: false,
            capabilities: ["shell"],
            displayName: "Offline Host",
            capacityRemaining: 1
          }
        ],
        nextHumanCursor: null,
        nextHostCursor: null
      },
      labels: zhLabels
    });

    expect(sections.find((s) => s.id === "unassigned")?.options[0]?.label).toBe("未分配");
    expect(sections.find((s) => s.id === "automatic")?.options[0]?.label).toBe("自动选择 Host");
    expect(sections.find((s) => s.id === "automatic")?.options[0]?.secondaryLabel).toBe(
      "派发时由服务器选择兼容 Host"
    );
    expect(
      sections
        .find((s) => s.id === "people")
        ?.options.find((o) => o.id === "human:gone")?.secondaryLabel
    ).toBe("成员资格已失效");
    expect(
      sections
        .find((s) => s.id === "hosts")
        ?.options.find((o) => o.id === "exact_host:host-offline")?.secondaryLabel
    ).toContain("离线");
  });
});
