import { afterEach, describe, expect, test } from "bun:test"
import { jsonSchema, tool } from "ai"
import { Effect, Stream } from "effect"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { ModelV2 } from "@opencode-ai/core/model"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { Provider } from "@/provider/provider"
import { ProviderTransform } from "@/provider/transform"
import { LLM } from "@/session/llm"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { SessionPrompt } from "@/session/prompt"
import { MessageID, SessionID } from "@/session/schema"
import { disposeAllInstances, provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { testProviderConfig } from "../lib/test-provider"

const vision = "DeepSeek-V4-Flash-Vision-Exp"
const api = (id = vision, npm = "@ai-sdk/anthropic") => ({ api: { id, npm, url: "https://example.test/v1" } })

describe("Vision tool choice compatibility", () => {
  test("relaxes only forced choice on the affected Anthropic model", () => {
    expect(ProviderTransform.toolChoice(api(), "required")).toBe("auto")
    expect(ProviderTransform.toolChoice(api(vision.toLowerCase()), "required")).toBe("auto")
    for (const choice of [undefined, "auto", "none"] as const) {
      expect(ProviderTransform.toolChoice(api(), choice)).toBe(choice)
    }
    for (const id of [
      "DeepSeek-V4.1-Flash",
      "DeepSeek-V4-Flash",
      "DeepSeek-V4-Pro",
      "claude-sonnet-4-6",
      vision + "-other",
    ]) {
      expect(ProviderTransform.toolChoice(api(id), "required")).toBe("required")
    }
    expect(ProviderTransform.toolChoice(api(vision, "@ai-sdk/openai-compatible"), "required")).toBe("required")
  })
})

afterEach(disposeAllInstances)
const it = testEffect(AppNodeBuilder.build(LayerNode.group([LLM.node, Provider.node, CrossSpawnSpawner.node])))
const nativeIt = testEffect(
  AppNodeBuilder.build(LayerNode.group([LLM.node, Provider.node, CrossSpawnSpawner.node]), [
    [RuntimeFlags.node, RuntimeFlags.layer({ experimentalNativeLlm: true })],
  ]),
)

// The experimental native request path (openai and anthropic providers only) builds its own request,
// so it needs the same relaxation as the AI SDK path.
for (const modelID of [vision, "DeepSeek-V4.1-Flash"]) {
  nativeIt.live("native LLM path applies the forced tool choice rule: " + modelID, () =>
    Effect.gen(function* () {
      const requests: Record<string, unknown>[] = []
      const frames = [
        {
          type: "message_start",
          message: {
            id: "native-diagnostic",
            type: "message",
            role: "assistant",
            model: modelID,
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 10, output_tokens: 0 },
          },
        },
        { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "OK" } },
        { type: "content_block_stop", index: 0 },
        { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 2 } },
        { type: "message_stop" },
      ]
        .map((frame) => "data: " + JSON.stringify(frame) + "\n\n")
        .join("")
      const server = yield* Effect.acquireRelease(
        Effect.sync(() =>
          Bun.serve({
            port: 0,
            hostname: "127.0.0.1",
            async fetch(req) {
              requests.push((await req.json()) as Record<string, unknown>)
              return new Response(frames, { headers: { "content-type": "text/event-stream" } })
            },
          }),
        ),
        (server) => Effect.sync(() => server.stop(true)),
      )
      const fixture = testProviderConfig(server.url.toString()).provider.test
      yield* provideTmpdirInstance(
        () =>
          Effect.gen(function* () {
            const provider = yield* Provider.Service
            const llm = yield* LLM.Service
            const providerID = ProviderV2.ID.make("anthropic")
            const model = yield* provider.getModel(providerID, ModelV2.ID.make(modelID))
            const sessionID = SessionID.make("ses_vision_native")
            yield* llm
              .stream({
                user: {
                  id: MessageID.make("msg_vision_native"),
                  sessionID,
                  role: "user",
                  time: { created: 1 },
                  agent: "test",
                  model: { providerID, modelID: model.id },
                },
                sessionID,
                model,
                agent: {
                  name: "test",
                  mode: "primary",
                  options: {},
                  permission: [{ permission: "*", pattern: "*", action: "allow" }],
                },
                system: ["Reply OK."],
                messages: [{ role: "user", content: [{ type: "text", text: "Reply OK" }] }],
                tools: {
                  read_only_probe: tool({
                    description: "Read-only diagnostic tool",
                    inputSchema: jsonSchema({ type: "object", properties: {} }),
                  }),
                },
                toolChoice: "required",
                retries: 0,
              })
              .pipe(Stream.runCollect)
            expect(requests).toHaveLength(1)
            expect(requests[0].tool_choice).toEqual({ type: modelID === vision ? "auto" : "any" })
          }),
        {
          config: {
            formatter: false,
            lsp: false,
            enabled_providers: ["anthropic"],
            provider: {
              anthropic: {
                ...fixture,
                id: "anthropic",
                npm: "@ai-sdk/anthropic",
                models: {
                  [modelID]: {
                    ...fixture.models["test-model"],
                    id: modelID,
                    attachment: true,
                    limit: { context: 128000, output: 8192 },
                    modalities: { input: ["text", "image"], output: ["text"] },
                  },
                },
              },
            },
          },
        },
      )
    }),
  )
}

for (const modelID of [vision, "DeepSeek-V4.1-Flash"]) {
  it.live("serializes real LLM request and retains structured tools: " + modelID, () =>
    Effect.gen(function* () {
      const requests: Record<string, unknown>[] = []
      const answer = { text: "OK", outcome: { status: "answered", summary: "OK" } }
      const frames = [
        {
          type: "message_start",
          message: {
            id: "diagnostic",
            type: "message",
            role: "assistant",
            model: modelID,
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 10, output_tokens: 0 },
          },
        },
        {
          type: "content_block_start",
          index: 0,
          content_block: { type: "tool_use", id: "call_result", name: "StructuredOutput", input: {} },
        },
        {
          type: "content_block_delta",
          index: 0,
          delta: { type: "input_json_delta", partial_json: JSON.stringify(answer) },
        },
        { type: "content_block_stop", index: 0 },
        {
          type: "message_delta",
          delta: { stop_reason: "tool_use", stop_sequence: null },
          usage: { output_tokens: 20 },
        },
        { type: "message_stop" },
      ]
        .map((frame) => "data: " + JSON.stringify(frame) + "\n\n")
        .join("")
      const server = yield* Effect.acquireRelease(
        Effect.sync(() =>
          Bun.serve({
            port: 0,
            hostname: "127.0.0.1",
            async fetch(req) {
              const body = (await req.json()) as Record<string, unknown>
              requests.push(body)
              if (modelID === vision && (body.tool_choice as { type: string }).type !== "auto") {
                return Response.json(
                  { error: { type: "400001", message: "MaaS rejects forced tools" } },
                  { status: 400 },
                )
              }
              return new Response(frames, { headers: { "content-type": "text/event-stream" } })
            },
          }),
        ),
        (server) => Effect.sync(() => server.stop(true)),
      )
      const fixture = testProviderConfig(server.url.toString()).provider.test
      yield* provideTmpdirInstance(
        () =>
          Effect.gen(function* () {
            const provider = yield* Provider.Service
            const llm = yield* LLM.Service
            const providerID = ProviderV2.ID.make("oneapi-anthropic")
            const model = yield* provider.getModel(providerID, ModelV2.ID.make(modelID))
            const sessionID = SessionID.make("ses_vision_diagnostic")
            const captured: unknown[] = []
            const schema = {
              type: "object",
              required: ["text", "outcome"],
              properties: {
                text: { type: "string" },
                outcome: {
                  type: "object",
                  required: ["status", "summary"],
                  properties: { status: { type: "string", enum: ["answered"] }, summary: { type: "string" } },
                },
              },
            }
            const events = yield* llm
              .stream({
                user: {
                  id: MessageID.make("msg_vision_diagnostic"),
                  sessionID,
                  role: "user",
                  time: { created: 1 },
                  agent: "test",
                  model: { providerID, modelID: model.id },
                  format: new SessionV1.OutputFormatJsonSchema({ type: "json_schema", retryCount: 2, schema }),
                },
                sessionID,
                model,
                agent: {
                  name: "test",
                  mode: "primary",
                  options: {},
                  permission: [{ permission: "*", pattern: "*", action: "allow" }],
                },
                system: ["Submit the answer using StructuredOutput."],
                messages: [
                  {
                    role: "user",
                    content: [
                      { type: "text", text: "Reply OK" },
                      { type: "image", image: new Uint8Array([137, 80, 78, 71]), mediaType: "image/png" },
                    ],
                  },
                ],
                tools: {
                  StructuredOutput: SessionPrompt.createStructuredOutputTool({
                    schema,
                    onSuccess: (output) => {
                      captured.push(output)
                    },
                  }),
                  read_only_probe: tool({
                    description: "Read-only diagnostic tool",
                    inputSchema: jsonSchema({ type: "object", properties: {} }),
                  }),
                },
                toolChoice: "required",
                retries: 0,
              })
              .pipe(Stream.runCollect)
            expect(events.some((event) => event.type === "provider-error")).toBe(false)
            expect(requests).toHaveLength(1)
            expect(requests[0].model).toBe(modelID)
            expect(requests[0].messages).toEqual(
              expect.arrayContaining([
                expect.objectContaining({
                  role: "user",
                  content: expect.arrayContaining([
                    expect.objectContaining({
                      type: "image",
                      source: { type: "base64", media_type: "image/png", data: "iVBORw==" },
                    }),
                  ]),
                }),
              ]),
            )
            expect(requests[0].tool_choice).toEqual({ type: modelID === vision ? "auto" : "any" })
            expect(requests[0].tools).toEqual(
              expect.arrayContaining([
                expect.objectContaining({ name: "StructuredOutput", input_schema: schema }),
                expect.objectContaining({ name: "read_only_probe" }),
              ]),
            )
            expect(captured).toEqual([answer])
          }),
        {
          config: {
            formatter: false,
            lsp: false,
            enabled_providers: ["oneapi-anthropic"],
            provider: {
              "oneapi-anthropic": {
                ...fixture,
                id: "oneapi-anthropic",
                npm: "@ai-sdk/anthropic",
                models: {
                  [modelID]: {
                    ...fixture.models["test-model"],
                    id: modelID,
                    attachment: true,
                    limit: { context: 128000, output: 8192 },
                    modalities: { input: ["text", "image"], output: ["text"] },
                  },
                },
              },
            },
          },
        },
      )
    }),
  )
}
