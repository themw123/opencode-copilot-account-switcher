import test from "node:test"
import assert from "node:assert/strict"

import {
  listAssignableAccountsForModel,
  listKnownCopilotModels,
  resolveCopilotModelAccount,
  rewriteModelAccountAssignments,
} from "../dist/model-account-map.js"

test("listKnownCopilotModels returns unique sorted model ids", () => {
  const models = listKnownCopilotModels({
    active: "main",
    accounts: {
      main: {
        name: "main",
        refresh: "r1",
        access: "a1",
        expires: 0,
        models: { available: ["gpt-5", "claude-4"], disabled: [] },
      },
      alt: {
        name: "alt",
        refresh: "r2",
        access: "a2",
        expires: 0,
        models: { available: ["gpt-5", "o3"], disabled: [] },
      },
    },
  })

  assert.deepEqual(models, ["claude-4", "gpt-5", "o3"])
})

test("listAssignableAccountsForModel returns accounts exposing the target model", () => {
  const accounts = listAssignableAccountsForModel({
    active: "main",
    accounts: {
      main: {
        name: "main",
        refresh: "r1",
        access: "a1",
        expires: 0,
        models: { available: ["gpt-5"], disabled: [] },
      },
      alt: {
        name: "alt",
        refresh: "r2",
        access: "a2",
        expires: 0,
        models: { available: ["gpt-5", "o3"], disabled: [] },
      },
    },
  }, "gpt-5")

  assert.deepEqual(accounts.map((item) => item.name), ["alt", "main"])
})

test("resolveCopilotModelAccount prefers mapped account and falls back to active", () => {
  const store = {
    active: "main",
    modelAccountAssignments: {
      "gpt-5": "alt",
    },
    accounts: {
      main: { name: "main", refresh: "r1", access: "a1", expires: 0 },
      alt: { name: "alt", refresh: "r2", access: "a2", expires: 0 },
    },
  }

  assert.deepEqual(resolveCopilotModelAccount(store, "gpt-5"), {
    name: "alt",
    entry: store.accounts.alt,
    source: "model",
  })
  assert.deepEqual(resolveCopilotModelAccount(store, "o3"), {
    name: "main",
    entry: store.accounts.main,
    source: "active",
  })
})

test("rewriteModelAccountAssignments renames and drops stale account mappings", () => {
  const store = {
    active: "main",
    accounts: {
      main: { name: "main", refresh: "r1", access: "a1", expires: 0 },
      renamed: { name: "renamed", refresh: "r2", access: "a2", expires: 0 },
    },
    modelAccountAssignments: {
      "gpt-5": "alt",
      "o3": "missing",
    },
  }

  rewriteModelAccountAssignments(store, {
    alt: "renamed",
    missing: undefined,
  })

  assert.deepEqual(store.modelAccountAssignments, {
    "gpt-5": "renamed",
  })
})
