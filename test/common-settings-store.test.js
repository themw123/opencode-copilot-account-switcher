import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, readFile, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

async function loadCommonSettingsStoreOrFail() {
  try {
    return await import("../dist/common-settings-store.js")
  } catch (error) {
    if (error?.code === "ERR_MODULE_NOT_FOUND") {
      assert.fail("common settings store module is missing: ../dist/common-settings-store.js")
    }
    throw error
  }
}

async function readJson(file) {
  return JSON.parse(await readFile(file, "utf8"))
}

test("common settings store path uses account-switcher settings.json", async () => {
  const { commonSettingsPath } = await loadCommonSettingsStoreOrFail()
  const normalized = commonSettingsPath().replace(/\\/g, "/")

  assert.equal(path.basename(normalized), "settings.json")
  assert.match(normalized, /\/opencode\/account-switcher\/settings\.json$/)
})

test("common settings store migrates legacy copilot flags into dedicated settings file", async () => {
  const { readCommonSettingsStore, writeCommonSettingsStore } = await loadCommonSettingsStoreOrFail()
  const dir = await mkdtemp(path.join(os.tmpdir(), "common-settings-store-legacy-"))
  const settingsFile = path.join(dir, "settings.json")
  const legacyCopilotFile = path.join(dir, "copilot-accounts.json")

  await writeFile(
    legacyCopilotFile,
    JSON.stringify({
      accounts: {},
      loopSafetyEnabled: false,
      loopSafetyProviderScope: "all-models",
      networkRetryEnabled: true,
      experimentalSlashCommandsEnabled: false,
      experimentalStatusSlashCommandEnabled: true,
    }, null, 2),
    "utf8",
  )

  const settings = await readCommonSettingsStore({
    filePath: settingsFile,
    legacyCopilotFilePath: legacyCopilotFile,
  })

  assert.deepEqual(settings, {
    loopSafetyEnabled: false,
    loopSafetyProviderScope: "all-models",
    networkRetryEnabled: true,
    experimentalSlashCommandsEnabled: false,
  })

  await writeCommonSettingsStore(settings, { filePath: settingsFile })
  const raw = await readJson(settingsFile)

  assert.deepEqual(raw, {
    loopSafetyEnabled: false,
    loopSafetyProviderScope: "all-models",
    networkRetryEnabled: true,
    experimentalSlashCommandsEnabled: false,
  })
  assert.equal(Object.hasOwn(raw, "experimentalStatusSlashCommandEnabled"), false)
})

test("common settings store prefers new settings and only backfills missing legacy fields", async () => {
  const { readCommonSettingsStore } = await loadCommonSettingsStoreOrFail()
  const dir = await mkdtemp(path.join(os.tmpdir(), "common-settings-store-merge-"))
  const settingsFile = path.join(dir, "settings.json")
  const legacyCopilotFile = path.join(dir, "copilot-accounts.json")

  await writeFile(
    settingsFile,
    JSON.stringify({
      loopSafetyEnabled: true,
      networkRetryEnabled: false,
    }, null, 2),
    "utf8",
  )
  await writeFile(
    legacyCopilotFile,
    JSON.stringify({
      accounts: {
        legacy: { name: "legacy", refresh: "r", access: "a", expires: 0 },
      },
      loopSafetyEnabled: false,
      loopSafetyProviderScope: "all-models",
      networkRetryEnabled: true,
      experimentalSlashCommandsEnabled: false,
    }, null, 2),
    "utf8",
  )

  const settings = await readCommonSettingsStore({
    filePath: settingsFile,
    legacyCopilotFilePath: legacyCopilotFile,
  })

  assert.deepEqual(settings, {
    loopSafetyEnabled: true,
    loopSafetyProviderScope: "all-models",
    networkRetryEnabled: false,
    experimentalSlashCommandsEnabled: false,
  })
})

test("common settings store migration is idempotent across repeated reads and writes", async () => {
  const { readCommonSettingsStore, writeCommonSettingsStore } = await loadCommonSettingsStoreOrFail()
  const dir = await mkdtemp(path.join(os.tmpdir(), "common-settings-store-idempotent-"))
  const settingsFile = path.join(dir, "settings.json")
  const legacyCopilotFile = path.join(dir, "copilot-accounts.json")

  await writeFile(
    legacyCopilotFile,
    JSON.stringify({
      accounts: {},
      networkRetryEnabled: true,
      experimentalStatusSlashCommandEnabled: false,
    }, null, 2),
    "utf8",
  )

  const first = await readCommonSettingsStore({
    filePath: settingsFile,
    legacyCopilotFilePath: legacyCopilotFile,
  })
  await writeCommonSettingsStore(first, { filePath: settingsFile })

  const second = await readCommonSettingsStore({
    filePath: settingsFile,
    legacyCopilotFilePath: legacyCopilotFile,
  })
  await writeCommonSettingsStore(second, { filePath: settingsFile })

  assert.deepEqual(second, first)
  assert.deepEqual(await readJson(settingsFile), {
    loopSafetyEnabled: true,
    loopSafetyProviderScope: "copilot-only",
    networkRetryEnabled: true,
    experimentalSlashCommandsEnabled: false,
  })
})

test("writing normalized defaults overrides legacy common settings instead of reviving old values", async () => {
  const { readCommonSettingsStore, writeCommonSettingsStore } = await loadCommonSettingsStoreOrFail()
  const dir = await mkdtemp(path.join(os.tmpdir(), "common-settings-store-defaults-"))
  const settingsFile = path.join(dir, "settings.json")
  const legacyCopilotFile = path.join(dir, "copilot-accounts.json")

  await writeFile(
    legacyCopilotFile,
    JSON.stringify({
      accounts: {},
      loopSafetyEnabled: false,
      loopSafetyProviderScope: "all-models",
      networkRetryEnabled: true,
      experimentalSlashCommandsEnabled: false,
    }, null, 2),
    "utf8",
  )

  await writeCommonSettingsStore({
    loopSafetyEnabled: true,
    loopSafetyProviderScope: "copilot-only",
    networkRetryEnabled: false,
    experimentalSlashCommandsEnabled: true,
  }, { filePath: settingsFile })

  assert.deepEqual(await readJson(settingsFile), {
    loopSafetyEnabled: true,
    loopSafetyProviderScope: "copilot-only",
    networkRetryEnabled: false,
    experimentalSlashCommandsEnabled: true,
  })

  const settings = await readCommonSettingsStore({
    filePath: settingsFile,
    legacyCopilotFilePath: legacyCopilotFile,
  })

  assert.deepEqual(settings, {
    loopSafetyEnabled: true,
    loopSafetyProviderScope: "copilot-only",
    networkRetryEnabled: false,
    experimentalSlashCommandsEnabled: true,
  })
})
