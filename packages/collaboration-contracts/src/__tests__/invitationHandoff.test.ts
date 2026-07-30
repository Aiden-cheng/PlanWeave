import { describe, expect, it } from "vitest";
import {
  collaborationInvitationHandoffV1Prefix,
  collaborationInvitationHandoffV1Schema,
  parseCollaborationInvitationHandoffV1,
  serializeCollaborationInvitationHandoffV1
} from "../index.js";

const invitationToken = `pw_inv_${"A".repeat(43)}`;

describe("collaboration invitation handoff contract", () => {
  it("serializes and parses the stable V1 envelope", () => {
    const handoff = {
      serverBaseUrl: "http://192.168.1.20:56584/",
      projectId: "project-1",
      invitationToken,
      allowInsecureTransport: true
    };

    expect(serializeCollaborationInvitationHandoffV1(handoff)).toBe(
      `${collaborationInvitationHandoffV1Prefix}{"serverBaseUrl":"http://192.168.1.20:56584/","projectId":"project-1","invitationToken":"${invitationToken}","allowInsecureTransport":true}`
    );
    expect(
      parseCollaborationInvitationHandoffV1(serializeCollaborationInvitationHandoffV1(handoff))
    ).toEqual(handoff);
  });

  it("reuses the project, invitation-token, origin, and transport policy validators", () => {
    expect(
      collaborationInvitationHandoffV1Schema.safeParse({
        serverBaseUrl: "http://example.com/",
        projectId: "project-1",
        invitationToken,
        allowInsecureTransport: true
      }).success
    ).toBe(false);
    expect(
      parseCollaborationInvitationHandoffV1(
        `${collaborationInvitationHandoffV1Prefix}{"serverBaseUrl":"https://collaboration.example.test/","projectId":"project-1","invitationToken":"invalid","allowInsecureTransport":false}`
      )
    ).toBeNull();
  });
});
