export * as ConfigContent from "./content"

import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { InvalidError } from "@opencode-ai/core/v1/config/error"

// This is a transport envelope, not a new config layer or a {file:} token.
// Keep it invalid JSONC so older runtimes reject it rather than lose policy.
const prefix = "dgj-config-content-v1:"

export async function read(text: string): Promise<string> {
  if (!text.startsWith(prefix)) return text
  const fail = () =>
    new InvalidError({
      path: "OPENCODE_CONFIG_CONTENT",
      message: "Cannot read verified CONTENT transport; refusing config fallback",
    })
  const match = /^([a-f0-9]{64}):([A-Za-z0-9_-]+)$/.exec(text.slice(prefix.length))
  if (!match) throw fail()
  const file = Buffer.from(match[2], "base64url").toString("utf8")
  if (!path.isAbsolute(file) || file.includes("\0") || Buffer.from(file).toString("base64url") !== match[2]) {
    throw fail()
  }
  // No cache, trim, substitution, path rebasing or recursive envelope decoding.
  // Every new instance must evaluate env/file markers at its usual load time.
  const bytes = await readFile(file).catch(() => {
    throw fail()
  })
  if (createHash("sha256").update(bytes).digest("hex") !== match[1]) throw fail()
  return bytes.toString("utf8")
}
