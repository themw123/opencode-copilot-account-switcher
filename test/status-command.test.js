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
  const messageLines = successMessage.split("\n")
  assert.equal(messageLines[0] ?? "", "[default]")
  assert.equal((messageLines[1] ?? "").length, 50)
  assert.equal(messageLines[2] ?? "", "[claude-3.7]")
  assert.equal((messageLines[3] ?? "").length, 50)
  assert.equal(messageLines[4] ?? "", "[gpt-4.1]")
  assert.equal((messageLines[5] ?? "").length, 50)
  assert.doesNotMatch(successMessage, /current active/i)
  assert.doesNotMatch(successMessage, /\bchat\b/i)
  assert.doesNotMatch(successMessage, /\bcompletions\b/i)
  assert.equal(messageLines.at(-2) ?? "", "活跃组: alice, bob")
  assert.equal(messageLines.at(-1) ?? "", "路由组: claude-3.7 -> alice; gpt-4.1 -> bob, alice")
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
  assert.equal(messageLines[0] ?? "", "[default]")
  assert.equal((messageLines[1] ?? "").length, 50)
  assert.match(messageLines.at(-2) ?? "", /^活跃组: alice$/)
  assert.match(messageLines.at(-1) ?? "", /^路由组: none$/)
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
  assert.equal(messageLines[0] ?? "", "[default]")
  assert.equal((messageLines[1] ?? "").length, 50)
  assert.match(messageLines.at(-2) ?? "", /^活跃组: none$/)
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
  assert.equal(messageLines[0] ?? "", "[default]")
  assert.equal((messageLines[1] ?? "").length, 50)
  assert.equal(messageLines[2] ?? "", "[gpt-4.1]")
  assert.equal((messageLines[3] ?? "").length, 50)
  assert.match(messageLines.at(-1) ?? "", /^路由组: gpt-4\.1 -> ghost, alice$/)
})

test("status command success skips empty model groups instead of rendering blank 50-char row", async () => {
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
          "gpt-4.1": [],
          "claude-3.7": ["alice"],
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

  const successMessage = calls.at(-1)?.body?.message ?? ""
  const messageLines = successMessage.split("\n")

  assert.doesNotMatch(successMessage, /\[gpt-4\.1\]/)
  assert.equal(messageLines.includes("[claude-3.7]"), true)
  assert.doesNotMatch(successMessage, /\n\s{50}\n/)
})

test("status command success renders grouped premium rows with fixed 50-width, 3-column cells", async () => {
  const calls = []
  const { handleStatusCommand } = await import("../dist/status-command.js")

  const longQuotaDisplay = "ultra-very-long-quota-token-XYZ/999999"
  const longQuotaTail = longQuotaDisplay.slice(-16)

  await assert.rejects(
    handleStatusCommand({
      client: {
        tui: {
          showToast: async (options) => calls.push(options),
        },
      },
      loadStore: async () => ({
        active: "alpha.super.long.username",
        activeAccountNames: [
          "alpha.super.long.username",
          "bravo",
          "charlie",
          "delta",
        ],
        modelAccountAssignments: {
          "gpt-4.1": ["charlie", "echo"],
        },
        accounts: {
          "alpha.super.long.username": { name: "alpha.super.long.username", refresh: "r1", access: "a1", expires: 0 },
          bravo: { name: "bravo", refresh: "r2", access: "a2", expires: 0 },
          charlie: {
            name: "charlie",
            refresh: "r3",
            access: "a3",
            expires: 0,
            quota: { snapshots: { premium: { remaining: "ultra-very-long-quota-token-XYZ", entitlement: 999999 } } },
          },
          delta: {
            name: "delta",
            refresh: "r4",
            access: "a4",
            expires: 0,
            quota: { snapshots: { premium: { remaining: 2000, entitlement: 2000 } } },
          },
          echo: {
            name: "echo",
            refresh: "r5",
            access: "a5",
            expires: 0,
            quota: { snapshots: { premium: { remaining: 7, entitlement: 9 } } },
          },
        },
      }),
      writeStore: async () => {},
      refreshQuota: async (store) => {
        store.accounts["alpha.super.long.username"] = {
          ...store.accounts["alpha.super.long.username"],
          quota: { snapshots: { premium: { remaining: 1234, entitlement: 5678 } } },
        }
        store.accounts.bravo = {
          ...store.accounts.bravo,
          quota: undefined,
        }
        return { type: "success", name: "alpha.super.long.username", entry: store.accounts["alpha.super.long.username"] }
      },
    }),
    (error) => error?.name === "StatusCommandHandledError",
  )

  const message = calls.at(-1)?.body?.message ?? ""
  const lines = message.split("\n")
  const defaultIndex = lines.indexOf("[default]")
  const routeIndex = lines.indexOf("[gpt-4.1]")

  assert.equal(defaultIndex >= 0, true)
  assert.equal(routeIndex > defaultIndex, true)

  const defaultRow1 = lines[defaultIndex + 1] ?? ""
  const defaultRow2 = lines[defaultIndex + 2] ?? ""
  const routeRow1 = lines[routeIndex + 1] ?? ""

  assert.equal(defaultRow1.length, 50)
  assert.equal(defaultRow2.length, 50)
  assert.equal(routeRow1.length, 50)

  assert.match(defaultRow1, /\.{3}/)
  assert.match(defaultRow1, /n\/a/)

  const defaultCellsRow1 = [
    defaultRow1.slice(0, 16),
    defaultRow1.slice(17, 33),
    defaultRow1.slice(34, 50),
  ]
  assert.equal(defaultCellsRow1.length, 3)
  assert.equal(defaultCellsRow1[2], longQuotaTail)

  const defaultCellsRow2 = [
    defaultRow2.slice(0, 16),
    defaultRow2.slice(17, 33),
    defaultRow2.slice(34, 50),
  ]
  assert.equal(defaultCellsRow2.length, 3)
  assert.match(defaultCellsRow2[0], /2000\/2000/)

  const routeCells = [
    routeRow1.slice(0, 16),
    routeRow1.slice(17, 33),
    routeRow1.slice(34, 50),
  ]
  assert.equal(routeCells.length, 3)
  assert.equal(routeCells[2]?.trim(), "")
})

test("status command success truncates overflow username with middle ellipsis inside 16-char cell", async () => {
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
        active: "verylongusername_tail",
        activeAccountNames: ["verylongusername_tail"],
        modelAccountAssignments: {
          "gpt-4.1": ["verylongusername_tail"],
        },
        accounts: {
          verylongusername_tail: { name: "verylongusername_tail", refresh: "r", access: "a", expires: 0 },
        },
      }),
      writeStore: async () => {},
      refreshQuota: async (store) => {
        store.accounts.verylongusername_tail = {
          ...store.accounts.verylongusername_tail,
          quota: { snapshots: { premium: { remaining: 9, entitlement: 9 } } },
        }
        return { type: "success", name: "verylongusername_tail", entry: store.accounts.verylongusername_tail }
      },
    }),
    (error) => error?.name === "StatusCommandHandledError",
  )

  const message = calls.at(-1)?.body?.message ?? ""
  const lines = message.split("\n")
  const defaultIndex = lines.indexOf("[default]")
  assert.equal(defaultIndex >= 0, true)

  const row = lines[defaultIndex + 1] ?? ""
  assert.equal(row.length, 50)

  const firstCell = row.slice(0, 16)
  assert.equal(firstCell.length, 16)
  assert.match(firstCell, /\.{3}/)
  assert.match(firstCell, /^very/)
  assert.match(firstCell, /tail 9\/9$/)
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
