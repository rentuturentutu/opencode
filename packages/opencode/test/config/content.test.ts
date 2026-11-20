import { test, expect } from "bun:test"
import { createHash } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import { tmpdir } from "../fixture/fixture"
import { ConfigContent } from "../../src/config/content"
import { ConfigVariable } from "../../src/config/variable"
import { ConfigParse } from "../../src/config/parse"
import { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import { Permission } from "../../src/permission"

function envelope(file: string, text: string) {
  return (
    "dgj-config-content-v1:" +
    createHash("sha256").update(text).digest("hex") +
    ":" +
    Buffer.from(file).toString("base64url")
  )
}

const parse = async (text: string, dir: string) =>
  ConfigParse.schema(
    ConfigV1.Info,
    ConfigParse.jsonc(
      await ConfigVariable.substitute({
        text: await ConfigContent.read(text),
        type: "virtual",
        source: "OPENCODE_CONFIG_CONTENT",
        dir,
      }),
      "OPENCODE_CONFIG_CONTENT",
    ),
    "OPENCODE_CONFIG_CONTENT",
  )

test("raw CONTENT keeps late env/file, JSONC, duplicate keys, surrogate and permission order", async () => {
  await using tmp = await tmpdir()
  const file = path.join(tmp.path, "raw.jsonc")
  const text =
    '{\n // {file:missing-in-comment}\n "model":"first/a", "model":"last/b", "username":"{env:DGJ_CONTENT_FIXTURE}", "agent":{"task":{"prompt":' +
    JSON.stringify("政策\n".repeat(400000) + "{env:DGJ_CONTENT_FIXTURE}{file:./relative.txt}") +
    '}}, "permission":{"bash":{"git *":"allow","*":"deny"},"*":"deny","edit":"ask"}, "instructions":["./policy.md"], "plugin":["./plugin.ts"], "surrogate":"\\ud800", }'
  await fs.writeFile(file, text)
  const transport = envelope(file, text)
  const old = process.env.DGJ_CONTENT_FIXTURE
  try {
    for (const suffix of ["first", "later"]) {
      const dir = path.join(tmp.path, suffix)
      await fs.mkdir(dir)
      process.env.DGJ_CONTENT_FIXTURE = suffix + "{file:./env-file.txt}"
      await fs.writeFile(path.join(dir, "env-file.txt"), " env-" + suffix + "\n")
      await fs.writeFile(
        path.join(dir, "relative.txt"),
        " file-" + suffix + " {env:NOT_RECURSIVE}{file:NOT_RECURSIVE}\n",
      )
      expect((await ConfigContent.read(transport)) === text).toBe(true)
      const expected = await parse(text, dir)
      const actual = await parse(transport, dir)
      expect(JSON.stringify(actual) === JSON.stringify(expected)).toBe(true)
      expect(actual.username).toBe(suffix + "env-" + suffix)
      expect(actual.agent?.task.prompt?.endsWith("file-" + suffix + " {env:NOT_RECURSIVE}{file:NOT_RECURSIVE}")).toBe(
        true,
      )
      expect(Object.keys(actual.permission!)).toEqual(["bash", "*", "edit"])
      expect(Object.keys(actual.permission!.bash!)).toEqual(["git *", "*"])
      expect(Permission.evaluate("bash", "git status", Permission.fromConfig(actual.permission!)).action).toBe("deny")
      expect(actual.plugin).toEqual(expected.plugin)
      expect(actual.instructions).toEqual(["./policy.md"])
      const expanded = await ConfigVariable.substitute({
        text: await ConfigContent.read(transport),
        type: "virtual",
        source: "OPENCODE_CONFIG_CONTENT",
        dir,
      })
      expect((ConfigParse.jsonc(expanded, "test") as { surrogate: string }).surrogate.charCodeAt(0)).toBe(0xd800)
    }
  } finally {
    if (old === undefined) delete process.env.DGJ_CONTENT_FIXTURE
    else process.env.DGJ_CONTENT_FIXTURE = old
  }
})

test("raw CONTENT refuses missing, changed or malformed transport without fallback", async () => {
  await using tmp = await tmpdir()
  const file = path.join(tmp.path, "fixture.json")
  const text = '{"permission":"deny"}'
  const transport = envelope(file, text)
  const check = async (input: string) => {
    const error = await ConfigContent.read(input).then(
      () => undefined,
      (error) => error,
    )
    expect(error?.data?.message).toBe("Cannot read verified CONTENT transport; refusing config fallback")
    expect(error?.data?.path).toBe("OPENCODE_CONFIG_CONTENT")
    expect(String(error).includes(file)).toBe(false)
  }
  await check(transport)
  await fs.writeFile(file, '{"permission":"allow"}')
  await check(transport)
  await check("dgj-config-content-v1:broken")
  await check(envelope("relative.json", text))
  await fs.writeFile(file, text)
  expect(await ConfigContent.read(transport)).toBe(text)
  expect(() => ConfigParse.jsonc(transport, "old-runtime")).toThrow()
  await fs.writeFile(file, transport)
  expect(await ConfigContent.read(envelope(file, transport))).toBe(transport)
})

test("small CONTENT is unchanged, including ordinary strings resembling transport", async () => {
  for (const text of [
    "",
    '{/* c */"username":"dgj-config-content-v1:literal",}',
    '{"permission":{"bash":"allow","*":"deny"}}',
  ]) {
    expect(await ConfigContent.read(text)).toBe(text)
  }
})

test("raw CONTENT retains parser failures instead of accepting a fallback config", async () => {
  await using tmp = await tmpdir()
  const file = path.join(tmp.path, "raw.jsonc")
  for (const text of [
    '{"username":"{file:./missing-relative.txt}"}',
    '{"permission":{"bash":"not-an-action"}}',
    '{"username":',
  ]) {
    await fs.writeFile(file, text)
    const inline = await parse(text, tmp.path).then(
      () => undefined,
      (error) => error,
    )
    const transported = await parse(envelope(file, text), tmp.path).then(
      () => undefined,
      (error) => error,
    )
    expect(Boolean(inline)).toBe(true)
    expect(Boolean(transported)).toBe(true)
    expect(transported.name).toBe(inline.name)
    expect(transported.data).toEqual(inline.data)
  }
})
