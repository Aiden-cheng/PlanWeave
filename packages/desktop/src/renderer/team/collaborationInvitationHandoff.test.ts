import { describe, expect, it } from "vitest";
import {
  collaborationInvitationHandoffV1Prefix,
  parseCollaborationInvitationHandoff,
  serializeCollaborationInvitationHandoff
} from "./collaborationInvitationHandoff";

const invitationToken = `pw_inv_${"A".repeat(43)}`;

describe("collaboration invitation handoff", () => {
  it("serializes a locale-independent V1 payload with stable field order", () => {
    expect(
      serializeCollaborationInvitationHandoff({
        serverBaseUrl: "https://collaboration.example.test",
        projectId: "project-1",
        invitationToken,
        allowInsecureTransport: false
      })
    ).toBe(
      `${collaborationInvitationHandoffV1Prefix}{"serverBaseUrl":"https://collaboration.example.test","projectId":"project-1","invitationToken":"${invitationToken}","allowInsecureTransport":false}`
    );
  });

  it("round-trips a V1 payload", () => {
    const serialized = serializeCollaborationInvitationHandoff({
      serverBaseUrl: "http://192.168.1.20:56584",
      projectId: "project-1",
      invitationToken,
      allowInsecureTransport: true
    });

    expect(parseCollaborationInvitationHandoff(serialized)).toEqual({
      serverBaseUrl: "http://192.168.1.20:56584",
      projectId: "project-1",
      invitationToken,
      allowInsecureTransport: true
    });
  });

  it("rejects a legacy URL and invitation token when the project ID is absent", () => {
    expect(
      parseCollaborationInvitationHandoff(
        `Join at https://collaboration.example.test with token ${invitationToken}`
      )
    ).toBeNull();
  });

  it("preserves a project ID when the legacy copied text supplies one", () => {
    expect(
      parseCollaborationInvitationHandoff(
        `Server URL: http://192.168.1.20:56584\nProject ID: project-1\nInvitation token: ${invitationToken}`
      )
    ).toEqual({
      serverBaseUrl: "http://192.168.1.20:56584",
      projectId: "project-1",
      invitationToken,
      allowInsecureTransport: true
    });
  });

  it("accepts the established Chinese legacy project label", () => {
    expect(
      parseCollaborationInvitationHandoff(
        `服务器 URL: https://collaboration.example.test\n项目 ID: project-1\n邀请令牌: ${invitationToken}`
      )
    ).toMatchObject({ projectId: "project-1", invitationToken });
  });

  it("rejects malformed or unsafe handoff payloads", () => {
    expect(parseCollaborationInvitationHandoff("not an invitation")).toBeNull();
    expect(
      parseCollaborationInvitationHandoff(
        `${collaborationInvitationHandoffV1Prefix}{"serverBaseUrl":"https://collaboration.example.test","projectId":"project-1"}`
      )
    ).toBeNull();
    expect(
      parseCollaborationInvitationHandoff(
        `${collaborationInvitationHandoffV1Prefix}{"serverBaseUrl":"http://example.com","projectId":"project-1","invitationToken":"${invitationToken}","allowInsecureTransport":true}`
      )
    ).toBeNull();
  });
});
