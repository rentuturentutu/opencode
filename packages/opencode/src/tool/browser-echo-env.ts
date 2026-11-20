import type { SessionV1 } from "@opencode-ai/core/v1/session"

export function browserEchoEnvironment(messages: SessionV1.WithParts[]): Record<string, string> {
  const user = messages.findLast((message) => message.info.role === "user")?.info
  const value = user?.role === "user" ? user.metadata?.browser_echo_endpoint : undefined
  if (typeof value !== "string") return {}
  try {
    const url = new URL(value)
    if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port || url.username || url.password || url.search || url.hash || url.pathname !== "/") return {}
    return { JK3_BROWSER_CONTROL_ENDPOINT: url.origin }
  } catch { return {} }
}
