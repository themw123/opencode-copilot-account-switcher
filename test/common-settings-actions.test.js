import test from "node:test"
import assert from "node:assert/strict"

async function loadCommonSettingsActionsOrFail() {
  try {
    return await import("../dist/common-settings-actions.js")
  } catch (error) {
    if (error?.code === "ERR_MODULE_NOT_FOUND") {
      assert.fail("common settings actions module is missing: ../dist/common-settings-actions.js")
    }
    throw error
  }
}

test("common settings actions toggles wechat notifications and writes back", async () => {
  const { applyCommonSettingsAction } = await loadCommonSettingsActionsOrFail()
  const writes = []
  const settings = {
    wechat: {
      notifications: {
        enabled: true,
        question: true,
        permission: true,
        sessionError: true,
      },
    },
  }

  const handled = await applyCommonSettingsAction({
    action: { type: "toggle-wechat-notifications" },
    readSettings: async () => ({ ...settings }),
    writeSettings: async (next, meta) => {
      writes.push({ next, meta })
      Object.assign(settings, next)
    },
  })

  assert.equal(handled, true)
  assert.equal(settings.wechat.notifications.enabled, false)
  assert.equal(writes.length, 1)
  assert.equal(writes[0]?.meta?.actionType, "toggle-wechat-notifications")
})

test("common settings actions toggles wechat question/permission/session-error switches", async () => {
  const { applyCommonSettingsAction } = await loadCommonSettingsActionsOrFail()
  const writes = []
  const settings = {
    wechat: {
      notifications: {
        enabled: true,
        question: false,
        permission: false,
        sessionError: false,
      },
    },
  }

  await applyCommonSettingsAction({
    action: { type: "toggle-wechat-question-notify" },
    readSettings: async () => ({ ...settings }),
    writeSettings: async (next, meta) => {
      writes.push({ next, meta })
      Object.assign(settings, next)
    },
  })
  await applyCommonSettingsAction({
    action: { type: "toggle-wechat-permission-notify" },
    readSettings: async () => ({ ...settings }),
    writeSettings: async (next, meta) => {
      writes.push({ next, meta })
      Object.assign(settings, next)
    },
  })
  await applyCommonSettingsAction({
    action: { type: "toggle-wechat-session-error-notify" },
    readSettings: async () => ({ ...settings }),
    writeSettings: async (next, meta) => {
      writes.push({ next, meta })
      Object.assign(settings, next)
    },
  })

  assert.equal(settings.wechat.notifications.question, true)
  assert.equal(settings.wechat.notifications.permission, true)
  assert.equal(settings.wechat.notifications.sessionError, true)
  assert.deepEqual(writes.map((item) => item.meta?.actionType), [
    "toggle-wechat-question-notify",
    "toggle-wechat-permission-notify",
    "toggle-wechat-session-error-notify",
  ])
})

test("common settings actions keeps wechat-bind/wechat-rebind/wechat-unbind as handled semantic placeholders", async () => {
  const { applyCommonSettingsAction } = await loadCommonSettingsActionsOrFail()
  const writes = []
  const settings = {
    wechat: {
      notifications: {
        enabled: true,
        question: true,
        permission: true,
        sessionError: true,
      },
    },
  }

  for (const type of ["wechat-bind", "wechat-rebind", "wechat-unbind"]) {
    const handled = await applyCommonSettingsAction({
      action: { type },
      readSettings: async () => ({ ...settings }),
      writeSettings: async (next, meta) => {
        writes.push({ next, meta })
      },
    })
    assert.equal(handled, true)
  }

  assert.equal(writes.length, 0)
})

test("common settings actions tolerates partial wechat config without notifications", async () => {
  const { applyCommonSettingsAction } = await loadCommonSettingsActionsOrFail()
  const writes = []
  const settings = {
    wechat: {
      primaryBinding: {
        accountId: "wechat-main",
      },
    },
  }

  const handled = await applyCommonSettingsAction({
    action: { type: "toggle-wechat-notifications" },
    readSettings: async () => ({ ...settings }),
    writeSettings: async (next, meta) => {
      writes.push({ next, meta })
      Object.assign(settings, next)
    },
  })

  assert.equal(handled, true)
  assert.equal(settings.wechat.notifications.enabled, false)
  assert.equal(settings.wechat.notifications.question, true)
  assert.equal(settings.wechat.notifications.permission, true)
  assert.equal(settings.wechat.notifications.sessionError, true)
  assert.equal(writes.length, 1)
})
