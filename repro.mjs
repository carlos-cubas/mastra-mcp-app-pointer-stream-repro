// MCP server -> MCPClient -> Agent -> toAISdkStream -> AI SDK UI message.
// Does the MCP App pointer (`_meta.ui.resourceUri`) reach the UI stream?
import { fileURLToPath } from "node:url";
import { MCPClient, getMcpCallToolMeta } from "@mastra/mcp";
import { Agent } from "@mastra/core/agent";
import { MastraLanguageModelV2Mock, simulateReadableStream } from "@mastra/core/test-utils/llm-mock";
import { toAISdkStream } from "@mastra/ai-sdk";
import { convertToModelMessages, readUIMessageStream } from "ai";

const URI = "ui://repro/card";
const TOOL = "repro_show_card";
const count = (haystack, needle) => haystack.split(needle).length - 1;

const mcp = new MCPClient({
  servers: { repro: { command: process.execPath, args: [fileURLToPath(new URL("./server.mjs", import.meta.url))] } },
});

// The model calls the tool once, then answers. doStream is a function because the
// mock's array form hands the first call the second response.
function makeModel() {
  const finish = (finishReason) => ({ type: "finish", finishReason, usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } });
  const responses = [
    [
      { type: "stream-start", warnings: [] },
      { type: "tool-call", toolCallId: "call-1", toolName: TOOL, input: JSON.stringify({ cardId: "c-1" }) },
      finish("tool-calls"),
    ],
    [
      { type: "stream-start", warnings: [] },
      { type: "text-start", id: "t1" },
      { type: "text-delta", id: "t1", delta: "Done." },
      { type: "text-end", id: "t1" },
      finish("stop"),
    ],
  ];
  let call = 0;
  return new MastraLanguageModelV2Mock({ doStream: async () => ({ stream: simulateReadableStream({ chunks: responses[call++] }) }) });
}

// Adds a field to the tool-input chunks of every tool whose definition carries `_meta.ui`.
const onToolInput = (tools, field) =>
  new TransformStream({
    transform(chunk, controller) {
      const ui = tools[chunk.toolName]?.mcp?._meta?.ui;
      if (ui && (chunk.type === "tool-input-start" || chunk.type === "tool-input-available")) {
        chunk = { ...chunk, ...field(ui, chunk) };
      }
      controller.enqueue(chunk);
    },
  });

async function run(label, tools, transform) {
  const agent = new Agent({ id: "repro", name: "repro", instructions: "Show the card.", model: makeModel(), tools });
  const stream = await agent.stream("Show card c-1", { maxSteps: 2 });
  let ui = toAISdkStream(stream, { from: "agent", version: "v7" });
  if (transform) ui = ui.pipeThrough(transform);

  const chunks = [];
  for await (const chunk of ui) chunks.push(chunk);
  const wire = chunks.map((c) => JSON.stringify(c)).join("\n");

  let message;
  for await (const m of readUIMessageStream({
    stream: new ReadableStream({ start(c) { chunks.forEach((x) => c.enqueue(x)); c.close(); } }),
  })) message = m;
  const part = message.parts.find((p) => p.toolCallId === "call-1");

  // What the NEXT turn sends the model provider for this tool call.
  const modelMessages = await convertToModelMessages([message]);
  const call = modelMessages.flatMap((m) => (Array.isArray(m.content) ? m.content : [])).find((c) => c.type === "tool-call");

  console.log(`\n${label}`);
  console.log(`  "${URI}" on the stream : ${count(wire, URI)}`);
  console.log(`  "Fractions" on stream  : ${count(wire, "Fractions")}   <- control: the tool output IS on the stream`);
  console.log(`  part.state             : ${part?.state}`);
  console.log(`  part.output            : ${JSON.stringify(part?.output)}`);
  console.log(`  part.toolMetadata      : ${JSON.stringify(part?.toolMetadata)}`);
  console.log(`  part.callProviderMetadata : ${JSON.stringify(part?.callProviderMetadata)}`);
  console.log(`  next turn, tool-call providerOptions : ${JSON.stringify(call?.providerOptions)}`);
  return count(wire, URI);
}

try {
  const tools = await mcp.listTools();
  const tool = tools[TOOL];

  // A: the tool definition carries the pointer, with serverId stamped by the client.
  console.log(`A definition : ${JSON.stringify(tool?.mcp?._meta?.ui)}   <- control: on the built tool`);

  // B: the execute result carries it too, on the hidden channel from #22102.
  const executed = await tool.execute({ cardId: "c-1" }, {});
  console.log(`B execute    : ${JSON.stringify(getMcpCallToolMeta(executed))}   <- control: getMcpCallToolMeta`);
  console.log(`               JSON.stringify -> ${JSON.stringify(executed)}`);

  const shipped = await run("C toAISdkStream, as shipped", tools);

  // D: the AI SDK's tool-owned channel, in the shape @ai-sdk/mcp writes.
  const viaToolMetadata = await run(
    "D same run, pointer copied onto the tool-input chunks as toolMetadata.app",
    tools,
    onToolInput(tools, (ui, chunk) => ({ toolMetadata: { ...chunk.toolMetadata, app: { ...ui, mimeType: "text/html;profile=mcp-app" } } })),
  );

  // E: the same pointer on providerMetadata instead, for comparison.
  await run(
    "E same run, pointer copied onto the tool-input chunks as providerMetadata.mcp.app",
    tools,
    onToolInput(tools, (ui, chunk) => ({ providerMetadata: { ...chunk.providerMetadata, mcp: { app: ui } } })),
  );

  console.log(
    shipped === 0 && viaToolMetadata > 0
      ? "\nREPRODUCED: the pointer is on the tool definition and the execute result, and never reaches the UI stream"
      : `\nNOT REPRODUCED (shipped=${shipped}, toolMetadata=${viaToolMetadata})`,
  );
} finally {
  await mcp.disconnect();
}
