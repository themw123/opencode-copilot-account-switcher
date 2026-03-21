import test from "node:test"
import assert from "node:assert/strict"

async function loadCodexAuthSourceOrFail() {
  try {
    return await import("../dist/codex-auth-source.js")
  } catch (error) {
    if (error?.code === "ERR_MODULE_NOT_FOUND") {
      assert.fail("codex auth source module is missing: ../dist/codex-auth-source.js")
    }
    throw error
  }
}

function createUnsignedJwt(payload) {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url")
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url")
  return `${header}.${body}.`
}

test("reads openai oauth auth with accountId directly", async () => {
  const { resolveCodexAuthSource } = await loadCodexAuthSourceOrFail()
  const auth = {
    openai: {
      type: "oauth",
      refresh: "refresh-token",
      access: "access-token",
      expires: 123,
      accountId: "acct_direct",
    },
    "github-copilot": {
      type: "oauth",
      refresh: "gh-refresh",
    },
  }

  const result = resolveCodexAuthSource(auth)

  assert.deepEqual(result, {
    providerId: "openai",
    oauth: auth.openai,
    accountId: "acct_direct",
  })
})

test("extracts accountId from token claims when auth body misses it", async () => {
  const { resolveCodexAuthSource } = await loadCodexAuthSourceOrFail()
  const access = createUnsignedJwt({ account_id: "acct_from_claims" })
  const auth = {
    openai: {
      type: "oauth",
      refresh: "refresh-token",
      access,
      expires: 123,
    },
  }

  const result = resolveCodexAuthSource(auth)

  assert.deepEqual(result, {
    providerId: "openai",
    oauth: auth.openai,
    accountId: "acct_from_claims",
    suggestedWriteBack: {
      accountId: "acct_from_claims",
    },
  })
})
