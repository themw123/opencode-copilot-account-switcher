import test from "node:test"
import assert from "node:assert/strict"

test("status command sends loading toast first", async () => {
  const calls = []
  const { handleStatusCommand } = await import("../dist/status-command.js")

  await assert.rejects(
    handleStatusCommand({
      client: {
        tui: {
          showToast: async (options) => calls.push(options),
        },
      },
      loadStore: async () => ({
        active: "alice",
        accounts: {
          alice: { name: "alice", refresh: "ghu_x", access: "ghu_x", expires: 0 },
        },
      }),
      writeStore: async () => {},
      refreshQuota: async (store) => {
        store.accounts.alice = {
          ...store.accounts.alice,
          quota: { updatedAt: 123, snapshots: { premium: { remaining: 10, entitlement: 50 } } },
        }
        return { type: "success", name: "alice", entry: store.accounts.alice }
      },
    }),
    (error) => error?.name === "StatusCommandHandledError",
  )

  assert.equal(calls.length >= 1, true)
  assert.equal(calls[0]?.body?.variant, "info")
  assert.match(calls[0]?.body?.message ?? "", /fetching|quota|Copilot|拉取/i)
})

test("showStatusToast swallows toast delivery failures", async () => {
  const warnings = []
  const calls = []
  const { showStatusToast } = await import("../dist/status-command.js")

  await assert.doesNotReject(() => showStatusToast({
    client: {
      tui: {
        showToast: async (options) => {
          calls.push(options)
          throw new Error("toast failed")
        },
      },
    },
    message: "fetching quota",
    variant: "info",
    warn: (scope, error) => warnings.push(`${scope}:${String(error)}`),
  }))

  assert.equal(calls.length, 1)
  assert.equal(warnings.length, 1)
})

test("showStatusToast no-ops when showToast is unavailable", async () => {
  const warnings = []
  const { showStatusToast } = await import("../dist/status-command.js")

  await assert.doesNotReject(() => showStatusToast({
    client: {},
    message: "fetching quota",
    variant: "info",
    warn: (scope, error) => warnings.push(`${scope}:${String(error)}`),
  }))

  assert.equal(warnings.length, 0)
})

test("showStatusToast preserves tui showToast this binding", async () => {
  const calls = []
  const { showStatusToast } = await import("../dist/status-command.js")

  const tui = {
    _client: { id: "ok" },
    async showToast(options) {
      const marker = this?._client?.id
      if (!marker) throw new TypeError("undefined is not an object (evaluating 'this._client')")
      calls.push({ marker, options })
    },
  }

  await assert.doesNotReject(() => showStatusToast({
    client: { tui },
    message: "fetching quota",
    variant: "info",
  }))

  assert.equal(calls.length, 1)
  assert.equal(calls[0]?.marker, "ok")
  assert.equal(calls[0]?.options?.body?.variant, "info")
})

test("status command reports store load failure with controlled interrupt", async () => {
  const calls = []
  const { handleStatusCommand } = await import("../dist/status-command.js")

  await assert.rejects(
    handleStatusCommand({
      client: {
        tui: {
          showToast: async (options) => calls.push(options),
        },
      },
      loadStore: async () => {
        throw new Error("store read failed")
      },
      writeStore: async () => {
        throw new Error("should not run")
      },
      refreshQuota: async () => {
        throw new Error("should not run")
      },
    }),
    (error) => error?.name === "StatusCommandHandledError",
  )

  assert.equal(calls.length, 1)
  assert.equal(calls[0]?.body?.variant, "error")
  assert.match(calls[0]?.body?.message ?? "", /store|read failed|读取/i)
  assert.doesNotMatch(calls[0]?.body?.message ?? "", /StatusCommandHandledError|status-command-handled|handled/i)
})

test("status command treats undefined store as store load failure", async () => {
  const calls = []
  const { handleStatusCommand } = await import("../dist/status-command.js")

  await assert.rejects(
    handleStatusCommand({
      client: {
        tui: {
          showToast: async (options) => calls.push(options),
        },
      },
      loadStore: async () => undefined,
      writeStore: async () => {
        throw new Error("should not run")
      },
      refreshQuota: async () => {
        throw new Error("should not run")
      },
    }),
    (error) => error?.name === "StatusCommandHandledError",
  )

  assert.equal(calls.length, 1)
  assert.equal(calls[0]?.body?.variant, "error")
  assert.match(calls[0]?.body?.message ?? "", /store|读取/i)
  assert.doesNotMatch(calls[0]?.body?.message ?? "", /StatusCommandHandledError|status-command-handled|handled/i)
})

test("status command without active account sends only one error toast", async () => {
  const calls = []
  let refreshCount = 0
  const { handleStatusCommand } = await import("../dist/status-command.js")

  await assert.rejects(
    handleStatusCommand({
      client: {
        tui: {
          showToast: async (options) => calls.push(options),
        },
      },
      loadStore: async () => ({ accounts: {} }),
      writeStore: async () => {
        throw new Error("should not run")
      },
      refreshQuota: async () => {
        refreshCount += 1
        return { type: "refresh-failed", error: "should not run" }
      },
    }),
    (error) => error?.name === "StatusCommandHandledError",
  )

  assert.equal(refreshCount, 0)
  assert.equal(calls.length, 1)
  assert.equal(calls[0]?.body?.variant, "error")
  assert.match(calls[0]?.body?.message ?? "", /active account|当前账号/i)
  assert.doesNotMatch(calls[0]?.body?.message ?? "", /StatusCommandHandledError|status-command-handled|handled/i)
})

test("status command with stale active key sends one missing-active error toast", async () => {
  const calls = []
  let refreshCount = 0
  const { handleStatusCommand } = await import("../dist/status-command.js")

  await assert.rejects(
    handleStatusCommand({
      client: {
        tui: {
          showToast: async (options) => calls.push(options),
        },
      },
      loadStore: async () => ({
        active: "ghost",
        accounts: {},
      }),
      writeStore: async () => {
        throw new Error("should not run")
      },
      refreshQuota: async () => {
        refreshCount += 1
        return { type: "missing-active" }
      },
    }),
    (error) => error?.name === "StatusCommandHandledError",
  )

  assert.equal(refreshCount, 0)
  assert.equal(calls.length, 1)
  assert.equal(calls[0]?.body?.variant, "error")
  assert.match(calls[0]?.body?.message ?? "", /active account|当前账号/i)
  assert.doesNotMatch(calls[0]?.body?.message ?? "", /StatusCommandHandledError|status-command-handled|handled/i)
})

test("status command handles refreshQuota missing-active after loading toast", async () => {
  const calls = []
  const writes = []
  let refreshCount = 0
  const { handleStatusCommand } = await import("../dist/status-command.js")

  await assert.rejects(
    handleStatusCommand({
      client: {
        tui: {
          showToast: async (options) => calls.push(options),
        },
      },
      loadStore: async () => ({
        active: "alice",
        accounts: {
          alice: { name: "alice", refresh: "ghu_x", access: "ghu_x", expires: 0 },
        },
      }),
      writeStore: async (store, meta) => writes.push({ store, meta }),
      refreshQuota: async () => {
        refreshCount += 1
        return { type: "missing-active" }
      },
    }),
    (error) => error?.name === "StatusCommandHandledError",
  )

  assert.equal(refreshCount, 1)
  assert.equal(calls.length, 2)
  assert.equal(calls[0]?.body?.variant, "info")
  assert.equal(calls[1]?.body?.variant, "error")
  assert.match(calls[1]?.body?.message ?? "", /active account|当前账号/i)
  assert.equal(writes.length, 0)
})

test("status command refreshes quota, persists store, and ends with controlled interrupt", async () => {
  const calls = []
  const writes = []
  let refreshCount = 0
  const { handleStatusCommand } = await import("../dist/status-command.js")

  await assert.rejects(
    handleStatusCommand({
      client: {
        tui: {
          showToast: async (options) => calls.push(options),
        },
      },
      loadStore: async () => ({
        active: "alice",
        activeAccountNames: ["alice", "bob"],
        modelAccountAssignments: {
          "gpt-4.1": ["bob", "alice"],
          "claude-3.7": ["alice"],
        },
        accounts: {
          alice: { name: "alice", refresh: "ghu_x", access: "ghu_x", expires: 0 },
          bob: { name: "bob", refresh: "ghu_y", access: "ghu_y", expires: 0 },
        },
      }),
      writeStore: async (store, meta) => writes.push({ store, meta }),
      refreshQuota: async (store) => {
        refreshCount += 1
        store.accounts.alice = {
          ...store.accounts.alice,
          quota: {
            updatedAt: 123,
            snapshots: {
              premium: { remaining: 10, entitlement: 50 },
              chat: { remaining: 20, entitlement: 100 },
              completions: { remaining: 30, entitlement: 200 },
            },
          },
        }
        return { type: "success", name: "alice", entry: store.accounts.alice }
      },
    }),
    (error) => error?.name === "StatusCommandHandledError",
  )

  assert.equal(refreshCount, 1)
  assert.equal(calls.length, 2)
  assert.equal(calls[1]?.body?.variant, "success")
  const successMessage = calls[1]?.body?.message ?? ""
  assert.doesNotMatch(successMessage, /current active/i)
  assert.doesNotMatch(successMessage, /\bchat\b/i)
  assert.doesNotMatch(successMessage, /\bcompletions\b/i)
  assert.match(successMessage, /\[default\]/)
  assert.match(successMessage, /\[(?:claude-3\.7|gpt-4\.1)\]/)
  assert.equal(writes.length, 1)
  assert.equal(writes[0]?.store?.accounts?.alice?.quota?.snapshots?.premium?.remaining, 10)
})

test("status command success shows none when routing group is not configured", async () => {
  const calls = []
  const { handleStatusCommand } = await import("../dist/status-command.js")

  await assert.rejects(
    handleStatusCommand({
      client: {
        tui: {
          showToast: async (options) => calls.push(options),
        },
      },
      loadStore: async () => ({
        active: "alice",
        activeAccountNames: ["alice"],
        accounts: {
          alice: { name: "alice", refresh: "ghu_x", access: "ghu_x", expires: 0 },
        },
      }),
      writeStore: async () => {},
      refreshQuota: async (store) => {
        store.accounts.alice = {
          ...store.accounts.alice,
          quota: {
            updatedAt: 123,
            snapshots: {
              premium: { remaining: 10, entitlement: 50 },
            },
          },
        }
        return { type: "success", name: "alice", entry: store.accounts.alice }
      },
    }),
    (error) => error?.name === "StatusCommandHandledError",
  )

  assert.equal(calls.length, 2)
  const successMessage = calls[1]?.body?.message ?? ""
  const messageLines = successMessage.split("\n")
  assert.equal(messageLines.length, 3)
  assert.match(messageLines[1] ?? "", /^活跃组: alice$/)
  assert.match(messageLines[2] ?? "", /^路由组: none$/)
})

test("status command success shows active group none when activeAccountNames is absent", async () => {
  const calls = []
  const { handleStatusCommand } = await import("../dist/status-command.js")

  await assert.rejects(
    handleStatusCommand({
      client: {
        tui: {
          showToast: async (options) => calls.push(options),
        },
      },
      loadStore: async () => ({
        active: "alice",
        accounts: {
          alice: { name: "alice", refresh: "ghu_x", access: "ghu_x", expires: 0 },
        },
      }),
      writeStore: async () => {},
      refreshQuota: async (store) => {
        store.accounts.alice = {
          ...store.accounts.alice,
          quota: {
            updatedAt: 123,
            snapshots: {
              premium: { remaining: 10, entitlement: 50 },
            },
          },
        }
        return { type: "success", name: "alice", entry: store.accounts.alice }
      },
    }),
    (error) => error?.name === "StatusCommandHandledError",
  )

  assert.equal(calls.length, 2)
  const successMessage = calls[1]?.body?.message ?? ""
  const messageLines = successMessage.split("\n")
  assert.equal(messageLines.length, 3)
  assert.match(messageLines[1] ?? "", /^活跃组: none$/)
})

test("status command success renders routing assignment names directly from modelAccountAssignments", async () => {
  const calls = []
  const { handleStatusCommand } = await import("../dist/status-command.js")

  await assert.rejects(
    handleStatusCommand({
      client: {
        tui: {
          showToast: async (options) => calls.push(options),
        },
      },
      loadStore: async () => ({
        active: "alice",
        activeAccountNames: ["alice"],
        modelAccountAssignments: {
          "gpt-4.1": ["ghost", "alice"],
        },
        accounts: {
          alice: { name: "alice", refresh: "ghu_x", access: "ghu_x", expires: 0 },
        },
      }),
      writeStore: async () => {},
      refreshQuota: async (store) => {
        store.accounts.alice = {
          ...store.accounts.alice,
          quota: {
            updatedAt: 123,
            snapshots: {
              premium: { remaining: 10, entitlement: 50 },
            },
          },
        }
        return { type: "success", name: "alice", entry: store.accounts.alice }
      },
    }),
    (error) => error?.name === "StatusCommandHandledError",
  )

  assert.equal(calls.length, 2)
  const successMessage = calls[1]?.body?.message ?? ""
  const messageLines = successMessage.split("\n")
  assert.equal(messageLines.length, 3)
  assert.match(messageLines[2] ?? "", /^路由组: gpt-4\.1 -> ghost, alice$/)
})

test("status command continues refresh and persistence when showToast rejects", async () => {
  const calls = []
  const writes = []
  let refreshCount = 0
  const { handleStatusCommand } = await import("../dist/status-command.js")

  await assert.rejects(
    handleStatusCommand({
      client: {
        tui: {
          showToast: async (options) => {
            calls.push(options)
            throw new Error("toast failed")
          },
        },
      },
      loadStore: async () => ({
        active: "alice",
        accounts: {
          alice: { name: "alice", refresh: "ghu_x", access: "ghu_x", expires: 0 },
        },
      }),
      writeStore: async (store, meta) => writes.push({ store, meta }),
      refreshQuota: async (store) => {
        refreshCount += 1
        store.accounts.alice = {
          ...store.accounts.alice,
          quota: { updatedAt: 123, snapshots: { premium: { remaining: 10, entitlement: 50 } } },
        }
        return { type: "success", name: "alice", entry: store.accounts.alice }
      },
    }),
    (error) => error?.name === "StatusCommandHandledError",
  )

  assert.equal(refreshCount, 1)
  assert.equal(calls.length, 2)
  assert.equal(writes.length, 1)
})

test("status command continues refresh and persistence when showToast is unavailable", async () => {
  const writes = []
  let refreshCount = 0
  const { handleStatusCommand } = await import("../dist/status-command.js")

  await assert.rejects(
    handleStatusCommand({
      client: {},
      loadStore: async () => ({
        active: "alice",
        accounts: {
          alice: { name: "alice", refresh: "ghu_x", access: "ghu_x", expires: 0 },
        },
      }),
      writeStore: async (store, meta) => writes.push({ store, meta }),
      refreshQuota: async (store) => {
        refreshCount += 1
        store.accounts.alice = {
          ...store.accounts.alice,
          quota: { updatedAt: 123, snapshots: { premium: { remaining: 10, entitlement: 50 } } },
        }
        return { type: "success", name: "alice", entry: store.accounts.alice }
      },
    }),
    (error) => error?.name === "StatusCommandHandledError",
  )

  assert.equal(refreshCount, 1)
  assert.equal(writes.length, 1)
})

test("status command keeps real refresh failure in toast while throwing controlled interrupt", async () => {
  const calls = []
  const { handleStatusCommand } = await import("../dist/status-command.js")

  await assert.rejects(
    handleStatusCommand({
      client: {
        tui: {
          showToast: async (options) => calls.push(options),
        },
      },
      loadStore: async () => ({
        active: "alice",
        accounts: {
          alice: {
            name: "alice",
            refresh: "ghu_x",
            access: "ghu_x",
            expires: 0,
            quota: { snapshots: { premium: { remaining: 5, entitlement: 50 } } },
          },
        },
      }),
      writeStore: async () => {
        throw new Error("should not run")
      },
      refreshQuota: async () => ({
        type: "refresh-failed",
        name: "alice",
        error: "quota failed",
        previousQuota: { snapshots: { premium: { remaining: 5, entitlement: 50 } } },
      }),
    }),
    (error) => error?.name === "StatusCommandHandledError",
  )

  assert.equal(calls.length, 2)
  assert.equal(calls[1]?.body?.variant, "error")
  assert.match(calls[1]?.body?.message ?? "", /quota failed/i)
  assert.match(calls[1]?.body?.message ?? "", /5\/50/)
  assert.doesNotMatch(calls[1]?.body?.message ?? "", /StatusCommandHandledError|status-command-handled|handled/i)
})

test("status command converts thrown refresh errors into error toast plus controlled interrupt", async () => {
  const calls = []
  const { handleStatusCommand } = await import("../dist/status-command.js")

  await assert.rejects(
    handleStatusCommand({
      client: {
        tui: {
          showToast: async (options) => calls.push(options),
        },
      },
      loadStore: async () => ({
        active: "alice",
        accounts: {
          alice: { name: "alice", refresh: "ghu_x", access: "ghu_x", expires: 0 },
        },
      }),
      writeStore: async () => {
        throw new Error("should not run")
      },
      refreshQuota: async () => {
        throw new Error("quota crashed")
      },
    }),
    (error) => error?.name === "StatusCommandHandledError",
  )

  assert.equal(calls.length, 2)
  assert.equal(calls[1]?.body?.variant, "error")
  assert.match(calls[1]?.body?.message ?? "", /quota crashed/i)
  assert.doesNotMatch(calls[1]?.body?.message ?? "", /StatusCommandHandledError|status-command-handled|handled/i)
})

test("status command reports store persistence failure separately from controlled interrupt", async () => {
  const calls = []
  const { handleStatusCommand } = await import("../dist/status-command.js")

  await assert.rejects(
    handleStatusCommand({
      client: {
        tui: {
          showToast: async (options) => calls.push(options),
        },
      },
      loadStore: async () => ({
        active: "alice",
        accounts: {
          alice: { name: "alice", refresh: "ghu_x", access: "ghu_x", expires: 0 },
        },
      }),
      writeStore: async () => {
        throw new Error("persist failed")
      },
      refreshQuota: async (store) => {
        store.accounts.alice = {
          ...store.accounts.alice,
          quota: { updatedAt: 123, snapshots: { premium: { remaining: 10, entitlement: 50 } } },
        }
        return { type: "success", name: "alice", entry: store.accounts.alice }
      },
    }),
    (error) => error?.name === "StatusCommandHandledError",
  )

  assert.equal(calls.length, 2)
  assert.equal(calls[1]?.body?.variant, "error")
  assert.match(calls[1]?.body?.message ?? "", /persist failed|保存失败/i)
  assert.match(calls[1]?.body?.message ?? "", /已刷新|刷新成功|latest quota/i)
  assert.match(calls[1]?.body?.message ?? "", /10\/50|更新时间|更新于/i)
  assert.doesNotMatch(calls[1]?.body?.message ?? "", /StatusCommandHandledError|status-command-handled|handled/i)
})
