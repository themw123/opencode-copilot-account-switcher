import { randomBytes, createHash } from "node:crypto"
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import { spawn } from "node:child_process"
import os from "node:os"
import { createInterface } from "node:readline/promises"
import { stdin as input, stdout as output, platform } from "node:process"

const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann"
const ISSUER = "https://auth.openai.com"
const OAUTH_PORT = 1455
const OAUTH_TIMEOUT_MS = 5 * 60 * 1000
const OAUTH_POLLING_SAFETY_MARGIN_MS = 3000
const USER_AGENT = `opencode-copilot-account-switcher (${platform} ${os.release()}; ${os.arch()})`

const HTML_SUCCESS = `<!doctype html>
<html>
  <head>
    <title>Codex Authorization Successful</title>
  </head>
  <body>
    <h1>Authorization Successful</h1>
    <p>You can close this window and return to OpenCode.</p>
    <script>
      setTimeout(() => window.close(), 2000)
    </script>
  </body>
</html>`

const htmlError = (message: string) => `<!doctype html>
<html>
  <head>
    <title>Codex Authorization Failed</title>
  </head>
  <body>
    <h1>Authorization Failed</h1>
    <p>${message}</p>
  </body>
</html>`

type PkceCodes = {
  verifier: string
  challenge: string
}

export type TokenResponse = {
  id_token?: string
  access_token?: string
  refresh_token?: string
  expires_in?: number
}

export type IdTokenClaims = {
  chatgpt_account_id?: string
  organizations?: Array<{
    id?: string
    name?: string
    display_name?: string
    workspace_name?: string
    slug?: string
  }>
  organization?: {
    id?: string
    name?: string
    display_name?: string
    workspace_name?: string
    slug?: string
  }
  workspace?: {
    id?: string
    name?: string
    display_name?: string
    workspace_name?: string
    slug?: string
  }
  workspace_name?: string
  email?: string
  "https://api.openai.com/auth"?: {
    chatgpt_account_id?: string
    workspace_name?: string
    workspace_id?: string
    organization_id?: string
  }
}

export type CodexOAuthAccount = {
  refresh?: string
  access?: string
  expires?: number
  accountId?: string
  email?: string
  workspaceName?: string
}

type DeviceAuthResponse = {
  device_auth_id: string
  user_code: string
  interval: string
}

type DeviceTokenResponse = {
  authorization_code: string
  code_verifier: string
}

type OAuthMode = "browser" | "headless"

type RunCodexOAuthInput = {
  now?: () => number
  timeoutMs?: number
  fetchImpl?: typeof globalThis.fetch
  selectMode?: () => Promise<OAuthMode | undefined>
  runBrowserAuth?: () => Promise<TokenResponse>
  runDeviceAuth?: () => Promise<TokenResponse>
  openUrl?: (url: string) => Promise<void>
  log?: (message: string) => void
}

function base64UrlEncode(input: ArrayBuffer | Uint8Array) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input)
  return Buffer.from(bytes)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "")
}

function generateRandomString(length: number) {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~"
  const bytes = randomBytes(length)
  return Array.from(bytes, (byte) => chars[byte % chars.length]).join("")
}

async function generatePKCE(): Promise<PkceCodes> {
  const verifier = generateRandomString(43)
  const challenge = base64UrlEncode(createHash("sha256").update(verifier).digest())
  return { verifier, challenge }
}

function generateState() {
  return base64UrlEncode(randomBytes(32))
}

export function parseJwtClaims(token: string): IdTokenClaims | undefined {
  const parts = token.split(".")
  if (parts.length !== 3) return undefined
  try {
    return JSON.parse(Buffer.from(parts[1], "base64url").toString())
  } catch {
    return undefined
  }
}

export function extractAccountIdFromClaims(claims: IdTokenClaims): string | undefined {
  return (
    claims.chatgpt_account_id
    || claims["https://api.openai.com/auth"]?.chatgpt_account_id
    || claims.organizations?.[0]?.id
  )
}

export function extractAccountId(tokens: TokenResponse): string | undefined {
  if (tokens.id_token) {
    const claims = parseJwtClaims(tokens.id_token)
    const accountId = claims && extractAccountIdFromClaims(claims)
    if (accountId) return accountId
  }
  if (!tokens.access_token) return undefined
  const claims = parseJwtClaims(tokens.access_token)
  return claims ? extractAccountIdFromClaims(claims) : undefined
}

function pickWorkspaceLikeLabel(input: {
  id?: string
  name?: string
  display_name?: string
  workspace_name?: string
  slug?: string
} | undefined): string | undefined {
  if (!input) return undefined
  return input.workspace_name ?? input.name ?? input.display_name ?? input.slug ?? input.id
}

export function extractWorkspaceNameFromClaims(claims: IdTokenClaims): string | undefined {
  return (
    claims.workspace_name
    || claims["https://api.openai.com/auth"]?.workspace_name
    || claims["https://api.openai.com/auth"]?.workspace_id
    || claims["https://api.openai.com/auth"]?.organization_id
    || pickWorkspaceLikeLabel(claims.workspace)
    || pickWorkspaceLikeLabel(claims.organization)
    || pickWorkspaceLikeLabel(claims.organizations?.[0])
  )
}

export function extractWorkspaceName(tokens: TokenResponse): string | undefined {
  if (tokens.id_token) {
    const claims = parseJwtClaims(tokens.id_token)
    const workspaceName = claims && extractWorkspaceNameFromClaims(claims)
    if (workspaceName) return workspaceName
  }
  if (!tokens.access_token) return undefined
  const claims = parseJwtClaims(tokens.access_token)
  return claims ? extractWorkspaceNameFromClaims(claims) : undefined
}

function extractEmail(tokens: TokenResponse): string | undefined {
  if (tokens.id_token) {
    const claims = parseJwtClaims(tokens.id_token)
    if (claims?.email) return claims.email
  }
  if (!tokens.access_token) return undefined
  return parseJwtClaims(tokens.access_token)?.email
}

function buildAuthorizeUrl(redirectUri: string, pkce: PkceCodes, state: string) {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: CLIENT_ID,
    redirect_uri: redirectUri,
    scope: "openid profile email offline_access",
    code_challenge: pkce.challenge,
    code_challenge_method: "S256",
    id_token_add_organizations: "true",
    codex_cli_simplified_flow: "true",
    state,
    originator: "opencode",
  })
  return `${ISSUER}/oauth/authorize?${params.toString()}`
}

async function promptText(message: string) {
  const rl = createInterface({ input, output })
  try {
    return (await rl.question(message)).trim()
  } finally {
    rl.close()
  }
}

async function selectModeDefault(): Promise<OAuthMode | undefined> {
  const value = (await promptText("OpenAI/Codex login mode ([1] browser, [2] headless, Enter to cancel): ")).toLowerCase()
  if (!value) return undefined
  if (value === "1" || value === "browser" || value === "b") return "browser"
  if (value === "2" || value === "headless" || value === "h" || value === "device") return "headless"
  return undefined
}

async function openUrlDefault(url: string) {
  if (process.platform === "win32") {
    await new Promise<void>((resolve, reject) => {
      const child = spawn("cmd", ["/c", "start", "", url], { stdio: "ignore", windowsHide: true })
      child.on("error", reject)
      child.on("exit", (code) => {
        if (code && code !== 0) reject(new Error(`failed to open browser: ${code}`))
        else resolve()
      })
    })
    return
  }
  const command = process.platform === "darwin" ? "open" : "xdg-open"
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, [url], { stdio: "ignore" })
    child.on("error", reject)
    child.on("exit", (code) => {
      if (code && code !== 0) reject(new Error(`failed to open browser: ${code}`))
      else resolve()
    })
  })
}

async function exchangeCodeForTokens(input: {
  code: string
  redirectUri: string
  verifier: string
  fetchImpl: typeof globalThis.fetch
}): Promise<TokenResponse> {
  const response = await input.fetchImpl(`${ISSUER}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: input.code,
      redirect_uri: input.redirectUri,
      client_id: CLIENT_ID,
      code_verifier: input.verifier,
    }).toString(),
  })
  if (!response.ok) {
    throw new Error(`Token exchange failed: ${response.status}`)
  }
  return response.json() as Promise<TokenResponse>
}

async function runBrowserAuthDefault(input: {
  fetchImpl: typeof globalThis.fetch
  openUrl: (url: string) => Promise<void>
  log: (message: string) => void
  timeoutMs: number
}): Promise<TokenResponse> {
  const pkce = await generatePKCE()
  const state = generateState()
  const redirectUri = `http://localhost:${OAUTH_PORT}/auth/callback`
  const authUrl = buildAuthorizeUrl(redirectUri, pkce, state)

  const tokens = await new Promise<TokenResponse>((resolve, reject) => {
    let closed = false
    const finish = (handler: () => void) => {
      if (closed) return
      closed = true
      clearTimeout(timeout)
      void server.close(() => handler())
    }

    const respond = (res: ServerResponse, status: number, body: string) => {
      res.statusCode = status
      res.setHeader("Content-Type", "text/html")
      res.end(body)
    }

    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const url = new URL(req.url ?? "/", redirectUri)
      if (url.pathname !== "/auth/callback") {
        respond(res, 404, htmlError("Not found"))
        return
      }

      const code = url.searchParams.get("code")
      const returnedState = url.searchParams.get("state")
      const error = url.searchParams.get("error")
      const errorDescription = url.searchParams.get("error_description")

      if (error) {
        const message = errorDescription || error
        respond(res, 400, htmlError(message))
        finish(() => reject(new Error(message)))
        return
      }

      if (!code) {
        respond(res, 400, htmlError("Missing authorization code"))
        finish(() => reject(new Error("Missing authorization code")))
        return
      }

      if (returnedState !== state) {
        respond(res, 400, htmlError("Invalid state - potential CSRF attack"))
        finish(() => reject(new Error("Invalid state - potential CSRF attack")))
        return
      }

      respond(res, 200, HTML_SUCCESS)
      void exchangeCodeForTokens({
        code,
        redirectUri,
        verifier: pkce.verifier,
        fetchImpl: input.fetchImpl,
      }).then(
        (result) => finish(() => resolve(result)),
        (error: unknown) => finish(() => reject(error instanceof Error ? error : new Error(String(error)))),
      )
    })

    server.on("error", reject)
    server.listen(OAUTH_PORT, async () => {
      try {
        input.log("Opening browser for OpenAI/Codex authorization...")
        await input.openUrl(authUrl)
      } catch (error) {
        finish(() => reject(error instanceof Error ? error : new Error(String(error))))
      }
    })

    const timeout = setTimeout(() => {
      finish(() => reject(new Error("OAuth callback timeout - authorization took too long")))
    }, input.timeoutMs)
  })

  return tokens
}

async function runDeviceAuthDefault(input: {
  fetchImpl: typeof globalThis.fetch
  log: (message: string) => void
  timeoutMs: number
}): Promise<TokenResponse> {
  const deadline = Date.now() + input.timeoutMs
  const deviceResponse = await input.fetchImpl(`${ISSUER}/api/accounts/deviceauth/usercode`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "User-Agent": USER_AGENT,
    },
    body: JSON.stringify({ client_id: CLIENT_ID }),
  })

  if (!deviceResponse.ok) throw new Error("Failed to initiate device authorization")

  const deviceData = await deviceResponse.json() as DeviceAuthResponse
  const interval = Math.max(parseInt(deviceData.interval) || 5, 1) * 1000
  input.log(`Open ${ISSUER}/codex/device and enter code: ${deviceData.user_code}`)

  while (true) {
    if (Date.now() >= deadline) {
      throw new Error("Device authorization timeout - authorization took too long")
    }

    const response = await input.fetchImpl(`${ISSUER}/api/accounts/deviceauth/token`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": USER_AGENT,
      },
      body: JSON.stringify({
        device_auth_id: deviceData.device_auth_id,
        user_code: deviceData.user_code,
      }),
    })

    if (response.ok) {
      const data = await response.json() as DeviceTokenResponse
      return exchangeCodeForTokens({
        code: data.authorization_code,
        redirectUri: `${ISSUER}/deviceauth/callback`,
        verifier: data.code_verifier,
        fetchImpl: input.fetchImpl,
      })
    }

    if (response.status !== 403 && response.status !== 404) {
      throw new Error(`Device authorization failed: ${response.status}`)
    }

    if (Date.now() + interval + OAUTH_POLLING_SAFETY_MARGIN_MS >= deadline) {
      throw new Error("Device authorization timeout - authorization took too long")
    }

    await new Promise((resolve) => setTimeout(resolve, interval + OAUTH_POLLING_SAFETY_MARGIN_MS))
  }
}

function normalizeTokens(tokens: TokenResponse, now: () => number): CodexOAuthAccount | undefined {
  const refresh = tokens.refresh_token
  const access = tokens.access_token
  if (!refresh && !access) return undefined
  const workspaceName = extractWorkspaceName(tokens)
  return {
    refresh,
    access,
    expires: now() + (tokens.expires_in ?? 3600) * 1000,
    accountId: extractAccountId(tokens),
    email: extractEmail(tokens),
    ...(workspaceName ? { workspaceName } : {}),
  }
}

export async function runCodexOAuth(input: RunCodexOAuthInput = {}): Promise<CodexOAuthAccount | undefined> {
  const now = input.now ?? Date.now
  const timeoutMs = input.timeoutMs ?? OAUTH_TIMEOUT_MS
  const fetchImpl = input.fetchImpl ?? globalThis.fetch
  const selectMode = input.selectMode ?? selectModeDefault
  const openUrl = input.openUrl ?? openUrlDefault
  const log = input.log ?? console.log
  const mode = await selectMode()
  if (!mode) return undefined

  const runBrowserAuth = input.runBrowserAuth ?? (() => runBrowserAuthDefault({ fetchImpl, openUrl, log, timeoutMs }))
  const runDeviceAuth = input.runDeviceAuth ?? (() => runDeviceAuthDefault({ fetchImpl, log, timeoutMs }))
  const tokens = mode === "headless" ? await runDeviceAuth() : await runBrowserAuth()
  return normalizeTokens(tokens, now)
}
