// Fixture MCP server, spawned by probe.mjs over stdio.
//
// Built on the raw @modelcontextprotocol/sdk rather than Mastra's MCPServer, so the
// result `_meta` is on the wire regardless of #21277 (MCPServer omitting it).
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const URI = "ui://repro/card";
const server = new McpServer({ name: "repro", version: "1.0.0" });

server.registerResource(
  "card",
  URI,
  { mimeType: "text/html;profile=mcp-app" },
  async () => ({
    contents: [{ uri: URI, mimeType: "text/html;profile=mcp-app", text: "<!doctype html><p>card</p>" }],
  }),
);

server.registerTool(
  "show_card",
  {
    description: "Show a card to the user",
    inputSchema: { cardId: z.string() },
    outputSchema: { cardId: z.string(), title: z.string() },
    _meta: { ui: { resourceUri: URI } },
  },
  async ({ cardId }) => ({
    content: [{ type: "text", text: `Card ${cardId} is on screen.` }],
    structuredContent: { cardId, title: "Fractions" },
    _meta: { ui: { resourceUri: URI } },
  }),
);

await server.connect(new StdioServerTransport());
