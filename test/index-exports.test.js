import test from "node:test"
import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"

test("package root source exports OpenAI/Codex account switcher", async () => {
  const source = await readFile(new URL("../src/index.ts", import.meta.url), "utf8")

  assert.match(source, /OpenAICodexAccountSwitcher/)
})

test("package root dist exports both Copilot and OpenAI/Codex switchers", async () => {
  const indexExports = await import("../dist/index.js")
  const pluginExports = await import("../dist/plugin.js")
  const distTypeSource = await readFile(new URL("../dist/index.d.ts", import.meta.url), "utf8")

  assert.equal(typeof indexExports.CopilotAccountSwitcher, "function")
  assert.equal(indexExports.CopilotAccountSwitcher, pluginExports.CopilotAccountSwitcher)

  assert.equal(typeof indexExports.OpenAICodexAccountSwitcher, "function")
  assert.equal(indexExports.OpenAICodexAccountSwitcher, pluginExports.OpenAICodexAccountSwitcher)

  assert.match(distTypeSource, /CopilotAccountSwitcher/)
  assert.match(distTypeSource, /OpenAICodexAccountSwitcher/)
})
