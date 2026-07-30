import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, describe, expect, it } from "vitest";
import { registerPlanweaveTools } from "../toolRegistry.js";
import { defaultPlanweaveToolNames } from "../tools.js";

let client: Client | undefined;
let server: McpServer | undefined;

afterEach(async () => {
  await client?.close();
  await server?.close();
  client = undefined;
  server = undefined;
});

async function connectRegistry(): Promise<Client> {
  server = new McpServer({ name: "planweave-registry-test", version: "0.0.0" });
  registerPlanweaveTools(server);
  client = new Client({ name: "planweave-registry-test-client", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

describe("PlanWeave MCP tool registry", () => {
  it.each([
    ["update_block_planning", { sharedResources: ["api"], parallelSafe: true }],
    ["update_block_planning", { sharedResources: ["api"], parallelLocks: ["legacy"] }],
    [
      "bulk_update_blocks",
      {
        updates: [{ blockRef: "T-001#B-001", sharedResources: ["api"], locks: ["legacy"] }]
      }
    ],
    [
      "bulk_update_parallel_policy",
      {
        blocks: [{ blockRef: "T-001#B-001", sharedResources: ["api"], exclusive: true }]
      }
    ]
  ] as const)("rejects removed fields at the registered %s boundary", async (name, args) => {
    const registryClient = await connectRegistry();

    const result = await registryClient.callTool({
      name,
      arguments: { projectId: "project-1", ...args }
    });

    expect(result).toMatchObject({ isError: true });
    const errorText = result.content
      .map((content) => (content.type === "text" ? content.text : ""))
      .join("\n");
    expect(errorText).toContain("MCP error -32602");
    expect(errorText).toContain("Unrecognized key");
  });

  it("publishes strict input schemas for every registered tool", async () => {
    const registryClient = await connectRegistry();
    const tools = await registryClient.listTools();

    expect(tools.tools.map((tool) => tool.name).sort()).toEqual([...defaultPlanweaveToolNames].sort());
    for (const tool of tools.tools) {
      expect(tool.inputSchema).toMatchObject({
        additionalProperties: false
      });
    }
  });

  it.each([
    ["update_task", { projectId: "project-1", taskId: "T-001" }, "At least one of title"],
    [
      "update_block",
      { projectId: "project-1", title: "Updated" },
      "blockRef is required unless taskId and blockId are provided."
    ],
    [
      "update_canvas_execution_policy",
      { projectId: "project-1" },
      "At least one execution policy field must be provided."
    ],
    [
      "update_block_planning",
      { projectId: "project-1", blockRef: "T-001#B-001" },
      "At least one block planning field must be provided."
    ],
    [
      "set_review_pipeline",
      {
        projectId: "project-1",
        taskId: "T-001",
        steps: [
          {
            blockRef: "not-a-block-ref",
            title: "Review",
            preset: "architecture",
            inputContext: "Implementation report",
            passCriteria: "Clear boundaries",
            feedbackFormat: "Findings",
            promptMarkdown: "# Review"
          }
        ]
      },
      "blockRef must use '<taskId>#<blockId>'."
    ]
  ] as const)("enforces %s parser refinements at the registered boundary", async (name, args, message) => {
    const registryClient = await connectRegistry();

    const result = await registryClient.callTool({ name, arguments: args });
    const errorText = result.content
      .map((content) => (content.type === "text" ? content.text : ""))
      .join("\n");

    expect(result).toMatchObject({ isError: true });
    expect(errorText).toContain("MCP error -32602");
    expect(errorText).toContain(message);
  });

  it("rejects unknown fields through the set_review_pipeline alias", async () => {
    const registryClient = await connectRegistry();
    const result = await registryClient.callTool({
      name: "set_review_pipeline",
      arguments: {
        projectId: "project-1",
        taskId: "T-001",
        steps: [],
        legacy: true
      }
    });
    const errorText = result.content
      .map((content) => (content.type === "text" ? content.text : ""))
      .join("\n");

    expect(result).toMatchObject({ isError: true });
    expect(errorText).toContain("MCP error -32602");
    expect(errorText).toContain("Unrecognized key");
  });
});
