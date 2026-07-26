import { describe, expect, it } from "vitest";
import { summarizeChromiumAccessibilityTree } from "../main/chromiumAccessibility";

describe("Chromium accessibility surface summarizer", () => {
  it("accepts a named live surface and its descendant live region", () => {
    const summary = summarizeChromiumAccessibilityTree(
      {
        nodes: [
          {
            nodeId: "comments",
            role: { value: "region" },
            name: { value: "Comments" },
            childIds: ["comments-live"]
          },
          {
            nodeId: "comments-live",
            parentId: "comments",
            role: { value: "generic" },
            properties: [{ name: "live", value: { value: "polite" } }]
          },
          {
            nodeId: "unrelated-live",
            role: { value: "generic" },
            properties: [{ name: "live", value: { value: "polite" } }]
          }
        ]
      },
      ["Comments"],
      { allowedRoles: ["region"] }
    );

    expect(summary).toMatchObject({
      namedRegion: true,
      liveRegion: true,
      roleNamePairs: 1
    });
  });

  it("fails closed when the target and live node are separate surfaces", () => {
    const summary = summarizeChromiumAccessibilityTree(
      {
        nodes: [
          { nodeId: "comments", role: { value: "region" }, name: { value: "Comments" } },
          {
            nodeId: "unrelated-live",
            role: { value: "generic" },
            properties: [{ name: "live", value: { value: "polite" } }]
          }
        ]
      },
      ["Comments"],
      { allowedRoles: ["region"] }
    );

    expect(summary.namedRegion).toBe(true);
    expect(summary.liveRegion).toBe(false);
  });

  it("rejects a target subtree whose live property is off", () => {
    const summary = summarizeChromiumAccessibilityTree(
      {
        nodes: [
          {
            nodeId: "activity",
            role: { value: "region" },
            name: { value: "Activity" },
            childIds: ["activity-live"]
          },
          {
            nodeId: "activity-live",
            parentId: "activity",
            role: { value: "generic" },
            properties: [{ name: "live", value: { value: "off" } }]
          }
        ]
      },
      ["Activity"],
      { allowedRoles: ["region"] }
    );

    expect(summary.namedRegion).toBe(true);
    expect(summary.liveRegion).toBe(false);
  });
});
