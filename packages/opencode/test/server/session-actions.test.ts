import { afterEach, describe, expect, mock } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Effect, Layer } from "effect"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { MessageID, PartID } from "@/session/schema"
import { Session as SessionNs } from "@/session/session"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { httpApiLayer, requestInDirectory } from "./httpapi-layer"

const it = testEffect(Layer.mergeAll(LayerNode.compile(SessionNs.node), httpApiLayer))

afterEach(async () => {
  mock.restore()
  await disposeAllInstances()
})

describe("session action routes", () => {
  it.instance(
    "session routes expose metadata on create, update, get, and fork",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const headers = { "Content-Type": "application/json" }

        const created = yield* requestInDirectory("/session", test.directory, {
          method: "POST",
          headers,
          body: JSON.stringify({
            title: "meta-session",
            metadata: { source: "sdk", trace: { id: "abc" } },
          }),
        })
        expect(created.status).toBe(200)

        const session = (yield* created.json) as SessionNs.Info
        expect(session.metadata).toEqual({ source: "sdk", trace: { id: "abc" } })

        const updated = yield* requestInDirectory(`/session/${session.id}`, test.directory, {
          method: "PATCH",
          headers,
          body: JSON.stringify({ metadata: { source: "sdk", trace: { id: "def" }, tags: ["one"] } }),
        })
        expect(updated.status).toBe(200)

        const next = (yield* updated.json) as SessionNs.Info
        expect(next.metadata).toEqual({ source: "sdk", trace: { id: "def" }, tags: ["one"] })

        const fetched = yield* requestInDirectory(`/session/${session.id}`, test.directory)
        expect(fetched.status).toBe(200)
        expect(((yield* fetched.json) as SessionNs.Info).metadata).toEqual(next.metadata)

        const forked = yield* requestInDirectory(`/session/${session.id}/fork`, test.directory, {
          method: "POST",
          headers,
          body: JSON.stringify({}),
        })
        expect(forked.status).toBe(200)

        const fork = (yield* forked.json) as SessionNs.Info
        expect(fork.metadata).toEqual(next.metadata)

        const reset = yield* requestInDirectory(`/session/${session.id}`, test.directory, {
          method: "PATCH",
          headers,
          body: JSON.stringify({ metadata: {} }),
        })
        expect(reset.status).toBe(200)
        expect(((yield* reset.json) as SessionNs.Info).metadata).toEqual({})

        yield* SessionNs.Service.use((svc) => svc.remove(fork.id).pipe(Effect.ignore))
        yield* SessionNs.Service.use((svc) => svc.remove(session.id).pipe(Effect.ignore))
      }),
    { git: true },
  )

  it.instance(
    "fork route preserves a persisted structured-output prompt",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const service = yield* SessionNs.Service
        const original = yield* Effect.acquireRelease(service.create({ metadata: { source: "replay" } }), (info) =>
          service.remove(info.id).pipe(Effect.ignore),
        )
        const messageID = MessageID.ascending()
        yield* service.updateMessage({
          id: messageID,
          sessionID: original.id,
          role: "user",
          time: { created: 1 },
          agent: "replay",
          model: { providerID: "test", modelID: "test" },
          format: new SessionV1.OutputFormatJsonSchema({
            type: "json_schema",
            schema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
            retryCount: 2,
          }),
        } as SessionV1.User)
        yield* service.updatePart({
          id: PartID.ascending(),
          messageID,
          sessionID: original.id,
          type: "text",
          text: "retained task",
        })
        const before = yield* service.messages({ sessionID: original.id })
        const res = yield* requestInDirectory(`/session/${original.id}/fork`, test.directory, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{}",
        })
        expect(res.status).toBe(200)
        const fork = (yield* res.json) as SessionNs.Info
        yield* Effect.addFinalizer(() => service.remove(fork.id).pipe(Effect.ignore))
        const copied = yield* service.messages({ sessionID: fork.id })
        expect(fork.metadata).toEqual(original.metadata)
        expect(copied).toHaveLength(1)
        expect(copied[0]!.info.role === "user" && copied[0]!.info.format).toEqual(
          before[0]!.info.role === "user" && before[0]!.info.format,
        )
        expect(copied[0]!.parts[0]).toMatchObject({
          type: "text",
          text: "retained task",
          sessionID: fork.id,
          messageID: copied[0]!.info.id,
        })
        expect(yield* service.messages({ sessionID: original.id })).toEqual(before)
      }),
    { git: true },
  )

  it.instance(
    "abort route returns success",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const session = yield* Effect.acquireRelease(SessionNs.use.create({}), (created) =>
          SessionNs.use.remove(created.id).pipe(Effect.ignore),
        )

        const res = yield* requestInDirectory(`/session/${session.id}/abort`, test.directory, { method: "POST" })

        expect(res.status).toBe(200)
        expect(yield* res.json).toBe(true)
        expect(res.headers["x-mobao-resume-after-abort"]).toBeUndefined()
        const acknowledged = yield* requestInDirectory("/session/" + session.id + "/abort", test.directory, {
          method: "POST",
          headers: { "x-mobao-resume-after-abort": "v1" },
        })
        expect(acknowledged.status).toBe(200)
        expect(yield* acknowledged.json).toBe(true)
        expect(acknowledged.headers["x-mobao-resume-after-abort"]).toBe("v1")
        expect(acknowledged.headers["x-mobao-resume-session"]).toBe(session.id)
      }),
    { git: true },
  )

  it.instance(
    "experimental background route is a no-op without synchronous subagents",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const session = yield* Effect.acquireRelease(SessionNs.use.create({}), (created) =>
          SessionNs.use.remove(created.id).pipe(Effect.ignore),
        )

        const res = yield* requestInDirectory(`/experimental/session/${session.id}/background`, test.directory, {
          method: "POST",
        })

        expect(res.status).toBe(200)
        expect(yield* res.json).toBe(false)
      }),
    { git: true },
  )
})
