import { test, expect } from "bun:test"
import { browserEchoEnvironment } from "../../src/tool/browser-echo-env"
const user = (metadata: Record<string, unknown>) => ({ info: { role: "user", metadata }, parts: [] }) as any

test("browser endpoint comes from latest host metadata, not prose or old turns", () => {
 expect(browserEchoEnvironment([user({ browser_echo_endpoint: "http://127.0.0.1:12345" })])).toEqual({ JK3_BROWSER_CONTROL_ENDPOINT: "http://127.0.0.1:12345" })
 expect(browserEchoEnvironment([user({ browser_echo_endpoint: "http://127.0.0.1:12345" }), user({})])).toEqual({})
 expect(browserEchoEnvironment([{ info: { role: "assistant", metadata: { browser_echo_endpoint: "http://127.0.0.1:12345" } }, parts: [] } as any])).toEqual({})
})
test("rejects remote, credentialed, path, query and malformed endpoints", () => {
 for (const value of ["https://127.0.0.1:12345", "http://remote.test:12345", "http://127.0.0.1", "http://u:p@127.0.0.1:12345", "http://127.0.0.1:12345/command", "http://127.0.0.1:12345?x=y", "http://127.0.0.1:12345#x", {}, "bad"]) expect(browserEchoEnvironment([user({ browser_echo_endpoint: value })])).toEqual({})
})
