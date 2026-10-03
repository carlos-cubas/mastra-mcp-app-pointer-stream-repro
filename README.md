# `toAISdkStream` never carries the MCP App pointer

Upstream issue: https://github.com/mastra-ai/mastra/issues/NNNNN

Minimal reproduction for `@mastra/ai-sdk` with `@mastra/mcp`. No ports, keys or network calls. The fixture
MCP server runs over **stdio**, spawned by the repro, and the model is `MastraLanguageModelV2Mock`.

```bash
npm install
npm run repro
```

## Expected vs actual

```
A definition : {"resourceUri":"ui://repro/card","serverId":"repro"}   <- control: on the built tool
B execute    : {"ui":{"resourceUri":"ui://repro/card","serverId":"repro"}}   <- control: getMcpCallToolMeta
               JSON.stringify -> {"cardId":"c-1","title":"Fractions"}

C toAISdkStream, as shipped
  "ui://repro/card" on the stream : 0
  "Fractions" on stream  : 1   <- control: the tool output IS on the stream
  part.state             : output-available
  part.output            : {"cardId":"c-1","title":"Fractions"}
  part.toolMetadata      : undefined
  part.callProviderMetadata : undefined
  next turn, tool-call providerOptions : undefined

D same run, pointer copied onto the tool-input chunks as toolMetadata.app
  "ui://repro/card" on the stream : 1
  "Fractions" on stream  : 1   <- control: the tool output IS on the stream
  part.state             : output-available
  part.output            : {"cardId":"c-1","title":"Fractions"}
  part.toolMetadata      : {"app":{"resourceUri":"ui://repro/card","serverId":"repro","mimeType":"text/html;profile=mcp-app"}}
  part.callProviderMetadata : undefined
  next turn, tool-call providerOptions : undefined

E same run, pointer copied onto the tool-input chunks as providerMetadata.mcp.app
  "ui://repro/card" on the stream : 1
  "Fractions" on stream  : 1   <- control: the tool output IS on the stream
  part.state             : output-available
  part.output            : {"cardId":"c-1","title":"Fractions"}
  part.toolMetadata      : undefined
  part.callProviderMetadata : {"mcp":{"app":{"resourceUri":"ui://repro/card","serverId":"repro"}}}
  next turn, tool-call providerOptions : {"mcp":{"app":{"resourceUri":"ui://repro/card","serverId":"repro"}}}

REPRODUCED: the pointer is on the tool definition and the execute result, and never reaches the UI stream
```

`C` should look like `D`.

## What each step shows

- **A** and **B**: `@mastra/mcp` has the pointer, on the built tool and on the execute result.  The result
  copy is on the non-enumerable `MCP_CALL_TOOL_META` from mastra-ai/mastra#22102, so `JSON.stringify` drops it.
- **C**: the stream `toAISdkStream` produces, which is what `handleChatStream` and `chatRoute` send. The pointer
  is not on it, and the tool output is, so the probe is reading the right stream.
- **D**: the pointer copied from the definition onto the `tool-input-*` chunks as `toolMetadata.app`, in the
  shape `@ai-sdk/mcp` writes. It lands on the UI part.
- **E**: the same pointer on `providerMetadata` instead.   It lands too, and `convertToModelMessages` then hands
  it to the model provider as `providerOptions` on the next turn, because `providerMetadata` is the provider's
  channel.

D and E are host-side `TransformStream`s in `repro.mjs`, and they only exist to show where the AI SDK puts each
field.

## Where

`client-sdks/ai-sdk/src/helpers.ts` builds `tool-input-start` and `tool-input-available` with
`providerMetadata: chunk.payload.providerMetadata` and nothing from the tool. The fixture is built on the raw
`@modelcontextprotocol/sdk`, so the result `_meta` is on the wire regardless of mastra-ai/mastra#21277.

## Versions

`@mastra/core` 1.74.0, `@mastra/mcp` 2.1.2, `@mastra/ai-sdk` 1.10.6, `ai` 7.0.127, latest at the time of
writing.  Node 25.1.0, macOS arm64.
