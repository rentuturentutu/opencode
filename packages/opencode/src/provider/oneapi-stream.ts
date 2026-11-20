import { createParser, type EventSourceMessage } from "eventsource-parser"
import { ProviderError } from "./error"

const encoder = new TextEncoder()

export function wrapOneAPIAnthropicStream(response: Response): Response {
  if (!response.ok || !response.body) return response
  if (!response.headers.get("content-type")?.includes("text/event-stream")) return response

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  const pending: Uint8Array[] = []
  let sawMessageStop = false
  let ended = false

  const parser = createParser({
    onEvent(event) {
      if (isEmptySafeFrame(event)) return
      if (isMessageStop(event)) sawMessageStop = true
      pending.push(encodeEvent(event))
    },
  })

  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      while (pending.length === 0 && !ended) {
        const part = await reader.read()
        if (part.done) {
          parser.feed(decoder.decode())
          ended = true
          continue
        }
        parser.feed(decoder.decode(part.value, { stream: true }))
      }

      const next = pending.shift()
      if (next) {
        controller.enqueue(next)
        return
      }

      if (!sawMessageStop) {
        controller.error(new ProviderError.ResponseStreamError("OneAPI SSE ended before message_stop"))
        return
      }

      controller.close()
    },
    async cancel(reason) {
      await reader.cancel(reason)
    },
  })

  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  })
}

function isEmptySafeFrame(event: EventSourceMessage) {
  if (event.data !== "") return false
  return event.event === undefined || event.event === "message" || event.event === "ping"
}

function isMessageStop(event: EventSourceMessage) {
  try {
    const value: unknown = JSON.parse(event.data)
    return typeof value === "object" && value !== null && "type" in value && value.type === "message_stop"
  } catch {
    return false
  }
}

function encodeEvent(event: EventSourceMessage) {
  const lines: string[] = []
  if (event.event) lines.push(`event: ${event.event}`)
  if (event.id) lines.push(`id: ${event.id}`)
  lines.push(...event.data.split("\n").map((line) => `data: ${line}`))
  return encoder.encode(lines.join("\n") + "\n\n")
}

export * as OneAPIStream from "./oneapi-stream"
