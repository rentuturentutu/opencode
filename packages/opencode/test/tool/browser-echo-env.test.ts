import { test, expect } from "bun:test"
import { browserEchoEnvironment, pinBrowserControlEndpoint } from "../../src/tool/browser-echo-env"
const user = (metadata: Record<string, unknown>) => ({ info: { role: "user", metadata }, parts: [] }) as any

test("browser endpoint comes from latest host metadata, not prose or old turns", () => {
 expect(browserEchoEnvironment([user({ browser_echo_endpoint: "http://127.0.0.1:12345" })])).toEqual({ JK3_BROWSER_CONTROL_ENDPOINT: "http://127.0.0.1:12345" })
 expect(browserEchoEnvironment([user({ browser_echo_endpoint: "http://127.0.0.1:12345" }), user({})])).toEqual({})
 expect(browserEchoEnvironment([{ info: { role: "assistant", metadata: { browser_echo_endpoint: "http://127.0.0.1:12345" } }, parts: [] } as any])).toEqual({})
})
test("rejects remote, credentialed, path, query and malformed endpoints", () => {
 for (const value of ["https://127.0.0.1:12345", "http://remote.test:12345", "http://127.0.0.1", "http://u:p@127.0.0.1:12345", "http://127.0.0.1:12345/command", "http://127.0.0.1:12345?x=y", "http://127.0.0.1:12345#x", {}, "bad"]) expect(browserEchoEnvironment([user({ browser_echo_endpoint: value })])).toEqual({})
})

const turn = "http://127.0.0.1:50123"
test("an explicit endpoint assignment is pointed at the host-managed turn endpoint", () => {
  const cases: Array<[string, string]> = [
    [
      `$env:JK3_BROWSER_CONTROL_ENDPOINT="http://127.0.0.1:19500"; node scripts/replay.mjs 2>&1 | Out-String -Width 4000`,
      `$env:JK3_BROWSER_CONTROL_ENDPOINT="${turn}"; node scripts/replay.mjs 2>&1 | Out-String -Width 4000`,
    ],
    [
      `$env:JK3_BROWSER_CONTROL_ENDPOINT = 'http://localhost:19500'; node a.mjs`,
      `$env:JK3_BROWSER_CONTROL_ENDPOINT = '${turn}'; node a.mjs`,
    ],
    [
      `set JK3_BROWSER_CONTROL_ENDPOINT=http://127.0.0.1:19500&& node a.mjs`,
      `set JK3_BROWSER_CONTROL_ENDPOINT=${turn}&& node a.mjs`,
    ],
    [
      `set "JK3_BROWSER_CONTROL_ENDPOINT=http://127.0.0.1:19500" && node a.mjs`,
      `set "JK3_BROWSER_CONTROL_ENDPOINT=${turn}" && node a.mjs`,
    ],
    [
      `JK3_BROWSER_CONTROL_ENDPOINT=http://127.0.0.1:19500 node a.mjs`,
      `JK3_BROWSER_CONTROL_ENDPOINT=${turn} node a.mjs`,
    ],
    [
      `export JK3_BROWSER_CONTROL_ENDPOINT='http://[::1]:19500'; node a.mjs`,
      `export JK3_BROWSER_CONTROL_ENDPOINT='${turn}'; node a.mjs`,
    ],
  ]
  for (const [command, expected] of cases) {
    expect(pinBrowserControlEndpoint(command, turn)).toEqual({ command: expected, pinned: true })
  }
})

test("only the endpoint assignment is changed", () => {
  const untouched = [
    `node scripts/replay.mjs`,
    `$env:JK3_BROWSER_CONTROL_ENDPOINT="${turn}"; node a.mjs`,
    `echo $env:JK3_BROWSER_CONTROL_ENDPOINT`,
    `curl http://127.0.0.1:19500/status`,
    `$env:JK3_BROWSER_CONTROL_ENDPOINT=$other; node a.mjs`,
    `$env:JK3_BROWSER_CONTROL_ENDPOINT="https://remote.test:19500"; node a.mjs`,
    `$env:OTHER_ENDPOINT="http://127.0.0.1:19500"; node a.mjs`,
  ]
  for (const command of untouched) {
    expect(pinBrowserControlEndpoint(command, turn)).toEqual({ command, pinned: false })
  }
})

test("without a host turn endpoint every command is left as written", () => {
  const command = `$env:JK3_BROWSER_CONTROL_ENDPOINT="http://127.0.0.1:19500"; node a.mjs`
  expect(pinBrowserControlEndpoint(command, undefined)).toEqual({ command, pinned: false })
})