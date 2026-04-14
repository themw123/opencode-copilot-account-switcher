import test from "node:test"
import assert from "node:assert/strict"

import {
  listAssignableAccountsForModel,
  listKnownCopilotModels,
  resolveCopilotModelAccount,
  resolveCopilotModelAccounts,
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

test("resolveCopilotModelAccounts prefers mapped account and otherwise uses active account", () => {
  const store = {
    active: "main",
    modelAccountAssignments: {
      "gpt-5": "alt",
    },
    accounts: {
      main: { name: "main", refresh: "r1", access: "a1", expires: 0 },
      fallback: { name: "fallback", refresh: "r2", access: "a2", expires: 0 },
      alt: { name: "alt", refresh: "r3", access: "a3", expires: 0 },
      org: { name: "org", refresh: "r4", access: "a4", expires: 0 },
    },
  }

  assert.deepEqual(resolveCopilotModelAccounts(store, "gpt-5").map((item) => item.name), ["alt"])
  assert.deepEqual(resolveCopilotModelAccounts(store, "o3").map((item) => item.name), ["main"])
})

test("resolveCopilotModelAccounts uses only active account when it can serve the model", () => {
  const store = {
    active: "main",
    accounts: {
      main: {
        name: "main",
        refresh: "r1",
        access: "a1",
        expires: 0,
        models: { available: ["gpt-5"], disabled: [] },
      },
      unknown: { name: "unknown", refresh: "r2", access: "a2", expires: 0 },
      disabled: {
        name: "disabled",
        refresh: "r3",
        access: "a3",
        expires: 0,
        models: { available: [], disabled: ["gpt-5"] },
      },
    },
  }

  assert.deepEqual(resolveCopilotModelAccounts(store, "gpt-5").map((item) => item.name), ["main"])
})

test("resolveCopilotModelAccounts excludes accounts whose available list is present but does not include the model", () => {
  const store = {
    active: "main",
    accounts: {
      main: {
        name: "main",
        refresh: "r1",
        access: "a1",
        expires: 0,
        models: { available: ["gpt-5"], disabled: [] },
      },
      "other-model": {
        name: "other-model",
        refresh: "r2",
        access: "a2",
        expires: 0,
        models: { available: ["o3"], disabled: [] },
      },
    },
  }

  assert.deepEqual(resolveCopilotModelAccounts(store, "gpt-5").map((item) => item.name), ["main"])
})

test("resolveCopilotModelAccounts returns no candidates when mapped account is unusable", () => {
  const store = {
    active: "main",
    modelAccountAssignments: {
      "gpt-5": "missing",
    },
    accounts: {
      main: {
        name: "main",
        refresh: "r1",
        access: "a1",
        expires: 0,
        models: { available: ["gpt-5"], disabled: [] },
      },
      fallback: {
        name: "fallback",
        refresh: "r2",
        access: "a2",
        expires: 0,
      },
      disabled: {
        name: "disabled",
        refresh: "r3",
        access: "a3",
        expires: 0,
        models: { available: [], disabled: ["gpt-5"] },
      },
    },
  }

  assert.deepEqual(resolveCopilotModelAccounts(store, "gpt-5").map((item) => item.name), [])
})

test("resolveCopilotModelAccounts returns no candidates when explicit model mapping is blank", () => {
  const store = {
    active: "main",
    modelAccountAssignments: {
      "gpt-5": "",
    },
    accounts: {
      main: { name: "main", refresh: "r1", access: "a1", expires: 0 },
      fallback: { name: "fallback", refresh: "r2", access: "a2", expires: 0 },
    },
  }

  assert.deepEqual(resolveCopilotModelAccounts(store, "gpt-5").map((item) => item.name), [])
})

test("resolveCopilotModelAccounts uses active even when legacy activeAccountNames would disagree", () => {
  const store = {
    active: "main",
    activeAccountNames: ["disabled", "other-model"],
    accounts: {
      main: {
        name: "main",
        refresh: "r1",
        access: "a1",
        expires: 0,
        models: { available: ["gpt-5"], disabled: [] },
      },
      disabled: {
        name: "disabled",
        refresh: "r2",
        access: "a2",
        expires: 0,
        models: { available: [], disabled: ["gpt-5"] },
      },
      "other-model": {
        name: "other-model",
        refresh: "r3",
        access: "a3",
        expires: 0,
        models: { available: ["o3"], disabled: [] },
      },
    },
  }

  assert.deepEqual(resolveCopilotModelAccounts(store, "gpt-5").map((item) => item.name), ["main"])
})

test("resolveCopilotModelAccount returns the mapped candidate", () => {
  const store = {
    active: "main",
    modelAccountAssignments: {
      "gpt-5": "alt",
    },
    accounts: {
      main: { name: "main", refresh: "r1", access: "a1", expires: 0 },
      fallback: { name: "fallback", refresh: "r2", access: "a2", expires: 0 },
      alt: { name: "alt", refresh: "r3", access: "a3", expires: 0 },
      org: { name: "org", refresh: "r4", access: "a4", expires: 0 },
    },
  }

  assert.deepEqual(resolveCopilotModelAccount(store, "gpt-5"), {
    name: "alt",
    entry: store.accounts.alt,
    source: "model",
  })
})

test("rewriteModelAccountAssignments renames and drops stale account mappings", () => {
  const store = {
    active: "main",
    accounts: {
      main: { name: "main", refresh: "r1", access: "a1", expires: 0 },
      alt: { name: "alt", refresh: "r2", access: "a2", expires: 0 },
      renamed: { name: "renamed", refresh: "r3", access: "a3", expires: 0 },
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
