import { afterEach, expect, it } from "bun:test"
import { createServer, type Server } from "node:http"
import { streamText } from "ai"
import { Effect, Layer } from "effect"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { disposeAllInstances, provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { Env } from "@/env"
import { Plugin } from "@/plugin"
import { Provider } from "@/provider/provider"
import { ProviderError } from "@/provider/error"
import { ModelID, ProviderID } from "@/provider/schema"
import { OneAPIStream } from "@/provider/oneapi-stream"

afterEach(async () => {
  await disposeAllInstances()
})

const test = testEffect(
  Layer.mergeAll(Provider.defaultLayer, Env.defaultLayer, Plugin.defaultLayer, CrossSpawnSpawner.defaultLayer),
)

test.live("skips safe empty OneAPI SSE frames and waits for message_stop", () =>
  Effect.gen(function* () {
    const server = yield* Effect.acquireRelease(
      Effect.promise(() => anthropicServer(false)),
      (server) => Effect.sync(() => server.server.close()),
    )

    yield* provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const provider = yield* Provider.Service
          const model = yield* provider.getModel(ProviderID.make("oneapi-anthropic"), ModelID.make("test-model"))
          const result = streamText({
            model: yield* provider.getLanguage(model),
            messages: [{ role: "user", content: "hello" }],
          })

          expect(yield* Effect.promise(() => result.text)).toBe("ok")
        }),
      { config: providerConfig(server.url) },
    )
  }),
)

test.live("reports real premature EOF instead of manufacturing a successful turn", () =>
  Effect.gen(function* () {
    const server = yield* Effect.acquireRelease(
      Effect.promise(() => anthropicServer(true)),
      (server) => Effect.sync(() => server.server.close()),
    )

    yield* provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const provider = yield* Provider.Service
          const model = yield* provider.getModel(ProviderID.make("oneapi-anthropic"), ModelID.make("test-model"))
          const result = streamText({
            model: yield* provider.getLanguage(model),
            onError() {},
            messages: [{ role: "user", content: "hello" }],
          })

          const error = yield* Effect.promise(async () => {
            try {
              for await (const part of result.fullStream) {
                if (part.type === "error") return part.error
              }
            } catch (error) {
              return error
            }
          })
          expect(error).toBeInstanceOf(ProviderError.ResponseStreamError)
        }),
      { config: providerConfig(server.url) },
    )
  }),
)

it("preserves non-empty invalid JSON for the SDK to reject", async () => {
  const response = OneAPIStream.wrapOneAPIAnthropicStream(
    chunkedResponse([
      "event: content_block_delta\n",
      "data: {not-json}\n\n",
      "event: message_stop\n",
      'data: {"type":"message_stop"}\n\n',
    ]),
  )
  expect(await response.text()).toContain("data: {not-json}")
})

function providerConfig(url: string) {
  return {
    formatter: false,
    lsp: false,
    provider: {
      "oneapi-anthropic": {
        name: "OneAPI Anthropic",
        id: "oneapi-anthropic",
        env: [],
        npm: "@ai-sdk/anthropic",
        models: {
          "test-model": {
            id: "test-model",
            name: "Test Model",
            attachment: false,
            reasoning: false,
            temperature: false,
            tool_call: true,
            release_date: "2025-01-01",
            limit: { context: 100_000, output: 10_000 },
            cost: { input: 0, output: 0 },
            options: {},
          },
        },
        options: { apiKey: "test-key", baseURL: url },
      },
    },
  }
}

async function anthropicServer(truncate: boolean): Promise<{ server: Server; url: string }> {
  const server = createServer((_, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" })
    const frames = [
      event({
        type: "message_start",
        message: {
          id: "msg-oneapi",
          type: "message",
          role: "assistant",
          model: "test-model",
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 0 },
        },
      }),
      "data:",
      "event: ping\ndata:",
      event({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
      event({
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "ok" },
      }),
      event({ type: "content_block_stop", index: 0 }),
      event({
        type: "message_delta",
        delta: { stop_reason: "end_turn", stop_sequence: null },
        usage: { output_tokens: 1 },
      }),
    ]
    if (!truncate) frames.push(event({ type: "message_stop" }))
    res.end(frames.join("\n\n") + "\n\n")
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("server did not bind to a TCP port")
  return { server, url: `http://127.0.0.1:${address.port}` }
}

function event(value: unknown) {
  return `data: ${JSON.stringify(value)}`
}

function chunkedResponse(chunks: string[]) {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk))
      controller.close()
    },
  })
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } })
}
