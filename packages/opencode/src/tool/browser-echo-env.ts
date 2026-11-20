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

// The host owns JK3_BROWSER_CONTROL_ENDPOINT for a turn: it points at the loopback proxy that
// stamps every control command with the turn's echo owner. A command that assigns the variable
// itself, typically a model copying the endpoint recorded in skill.yaml
// (`$env:JK3_BROWSER_CONTROL_ENDPOINT="http://127.0.0.1:19500"`), reaches the browser host
// directly and the desktop cannot find the task window. Only a literal loopback origin that
// directly follows the variable name is replaced; other text is left alone.
const endpointAssignment = /(\bJK3_BROWSER_CONTROL_ENDPOINT\s*=\s*["']?)http:\/\/(?:127\.0\.0\.1|localhost|\[::1\]):\d+/gi

export function pinBrowserControlEndpoint(command: string, endpoint: string | undefined) {
  if (!endpoint) return { command, pinned: false }
  let pinned = false
  const next = command.replace(endpointAssignment, (match, prefix: string) => {
    if (match.slice(prefix.length) === endpoint) return match
    pinned = true
    return prefix + endpoint
  })
  return { command: next, pinned }
}