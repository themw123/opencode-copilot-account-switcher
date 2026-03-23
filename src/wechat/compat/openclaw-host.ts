import { mkdir, readFile, stat, writeFile } from "node:fs/promises"
import { createRequire, stripTypeScriptTypes } from "node:module"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

type OpenClawWeixinPlugin = {
  id?: string
  register(api: WechatCompatHostApi): void
}

type WechatCompatHostApi = {
  runtime?: {
    channelRuntime?: unknown
    gateway?: {
      startAccount?: unknown
    }
  }
  registerChannel?: (input: unknown) => void
  registerCli?: (handler: unknown, options?: unknown) => void
}

type OpenClawWeixinPublicEntry = {
  packageJsonPath: string
  packageRoot: string
  extensions: string[]
  entryRelativePath: string
  entryAbsolutePath: string
}

const COMPAT_COMPILED_DIR = ".openclaw-compat-stage-a"
const MIN_NODE_MAJOR = 24

let compiledEntryImportHrefPromise: Promise<string> | null = null

function requireField(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(`[wechat-compat] ${message}`)
  }
}

function assertNodeVersionSupportsCompatCompilation(): void {
  const [majorText = "0"] = process.versions.node.split(".")
  const major = Number.parseInt(majorText, 10)
  requireField(
    Number.isInteger(major) && major >= MIN_NODE_MAJOR,
    `Node ${MIN_NODE_MAJOR}+ is required for stage-a compat host compilation; current=${process.versions.node}`,
  )
}

function isNonEmptyObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value) && Object.keys(value as Record<string, unknown>).length > 0
}

function replaceTsSuffixToJs(relativePath: string): string {
  return relativePath.replace(/\.(cts|mts|ts|tsx)$/i, ".js")
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath)
    return true
  } catch (error) {
    if (error && typeof error === "object" && "code" in error) {
      const code = String((error as { code?: unknown }).code ?? "")
      if (code === "ENOENT" || code === "ENOTDIR") {
        return false
      }
    }
    throw error
  }
}

function getCompatCompiledRoot(entry: OpenClawWeixinPublicEntry): string {
  const hostModuleDirectory = path.dirname(fileURLToPath(import.meta.url))
  const workspaceRoot = path.resolve(hostModuleDirectory, "../../..")
  const safePackageRootKey = entry.packageRoot.replace(/[:\\/]+/g, "_").replace(/_+/g, "_").replace(/^_+|_+$/g, "")
  return path.join(workspaceRoot, COMPAT_COMPILED_DIR, safePackageRootKey)
}

function candidateSourcePaths(resolved: string): string[] {
  const candidates = [
    `${resolved}.ts`,
    `${resolved}.mts`,
    `${resolved}.cts`,
    `${resolved}.tsx`,
    path.join(resolved, "index.ts"),
    path.join(resolved, "index.mts"),
    path.join(resolved, "index.cts"),
    path.join(resolved, "index.tsx"),
  ]
  return candidates
}

function replaceJsSuffixToTsCandidates(resolved: string): string[] {
  const extension = path.extname(resolved).toLowerCase()
  const base = resolved.slice(0, -extension.length)
  switch (extension) {
    case ".js":
      return [`${base}.ts`, `${base}.mts`, `${base}.cts`, `${base}.tsx`]
    case ".mjs":
      return [`${base}.mts`, `${base}.ts`]
    case ".cjs":
      return [`${base}.cts`, `${base}.ts`]
    default:
      return [resolved]
  }
}

async function firstExistingPath(candidates: string[]): Promise<string | null> {
  for (const candidate of candidates) {
    if (await pathExists(candidate)) {
      return candidate
    }
  }
  return null
}

function ensureWithinPackageRoot(entry: OpenClawWeixinPublicEntry, sourceFile: string): void {
  const relativePath = path.relative(entry.packageRoot, sourceFile)
  requireField(
    relativePath.length > 0 && !relativePath.startsWith("..") && !path.isAbsolute(relativePath),
    `public entry dependency escapes package root: ${sourceFile}`,
  )
}

async function writeCompiledModule(sourceCode: string, outputPath: string, sourceFile: string): Promise<void> {
  const transformed = stripTypeScriptTypes(sourceCode, {
    mode: "transform",
    sourceUrl: sourceFile,
  })

  await mkdir(path.dirname(outputPath), { recursive: true })
  await writeFile(outputPath, transformed, "utf8")
}

async function compileDependencyGraph(entry: OpenClawWeixinPublicEntry, compiledRoot: string, sourceFile: string, visited: Set<string>): Promise<void> {
  ensureWithinPackageRoot(entry, sourceFile)
  if (visited.has(sourceFile)) {
    return
  }
  visited.add(sourceFile)

  const sourceCode = await readFile(sourceFile, "utf8")
  const relativeFromPackageRoot = path.relative(entry.packageRoot, sourceFile)
  const outputRelative = replaceTsSuffixToJs(relativeFromPackageRoot)
  const outputPath = path.join(compiledRoot, outputRelative)

  await writeCompiledModule(sourceCode, outputPath, sourceFile)

  for (const specifier of parseLocalSpecifiers(sourceCode)) {
    const sourceImportPath = await resolveSourceImportPath(sourceFile, specifier)
    if (sourceImportPath) {
      await compileDependencyGraph(entry, compiledRoot, sourceImportPath, visited)
    }
  }
}

function parseLocalSpecifiers(sourceCode: string): string[] {
  const specifiers = new Set<string>()
  const importLike =
    /(?:import|export)\s+(?:type\s+)?(?:[^"'`]*?\sfrom\s*)?["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g
  let match: RegExpExecArray | null = importLike.exec(sourceCode)
  while (match) {
    const specifier = match[1] ?? match[2]
    if (specifier && (specifier.startsWith("./") || specifier.startsWith("../"))) {
      specifiers.add(specifier)
    }
    match = importLike.exec(sourceCode)
  }
  return [...specifiers]
}

async function resolveSourceImportPath(fromSourceFile: string, specifier: string): Promise<string | null> {
  const fromDir = path.dirname(fromSourceFile)
  const resolved = path.resolve(fromDir, specifier)
  const hasExtension = path.extname(resolved).length > 0

  if (hasExtension) {
    return firstExistingPath(replaceJsSuffixToTsCandidates(resolved))
  }

  return firstExistingPath(candidateSourcePaths(resolved))
}

async function compileOpenClawWeixinPublicEntry(entry: OpenClawWeixinPublicEntry): Promise<string> {
  const compiledRoot = getCompatCompiledRoot(entry)
  const visited = new Set<string>()

  await mkdir(compiledRoot, { recursive: true })
  await writeFile(path.join(compiledRoot, "package.json"), JSON.stringify({ type: "module" }), "utf8")

  await compileDependencyGraph(entry, compiledRoot, entry.entryAbsolutePath, visited)
  const relativeEntry = path.relative(entry.packageRoot, entry.entryAbsolutePath)
  return path.join(compiledRoot, replaceTsSuffixToJs(relativeEntry))
}

export function assertMinimalWechatHostContract(api: WechatCompatHostApi): void {
  requireField(Boolean(api && typeof api === "object"), "api is required")
  requireField(Boolean(api.runtime), "api.runtime is required")
  requireField(typeof api.registerChannel === "function", "api.registerChannel() is required")
  requireField(Boolean(api.runtime?.gateway?.startAccount), "api.runtime.gateway.startAccount is required")
  requireField(isNonEmptyObject(api.runtime?.channelRuntime), "api.runtime.channelRuntime must be a non-empty object")
}

export async function resolveOpenClawWeixinPublicEntry(): Promise<OpenClawWeixinPublicEntry> {
  const require = createRequire(import.meta.url)
  const packageName = "@tencent-weixin/openclaw-weixin"
  const packageJsonPath = require.resolve(`${packageName}/package.json`)
  const packageJsonRaw = await readFile(packageJsonPath, "utf8")
  const packageJson = JSON.parse(packageJsonRaw) as {
    openclaw?: { extensions?: unknown }
  }

  const extensions = Array.isArray(packageJson.openclaw?.extensions)
    ? packageJson.openclaw?.extensions.filter((it): it is string => typeof it === "string")
    : []

  requireField(extensions.length > 0, `${packageName} openclaw.extensions[0] is required`)

  const entryRelativePath = extensions[0]
  requireField(Boolean(entryRelativePath?.startsWith("./")), `${packageName} openclaw.extensions[0] must start with ./`)

  const packageRoot = path.dirname(packageJsonPath)
  const entryAbsolutePath = path.resolve(packageRoot, entryRelativePath)

  return {
    packageJsonPath,
    packageRoot,
    extensions,
    entryRelativePath,
    entryAbsolutePath,
  }
}

function createStageABlockerError(cause: unknown): Error {
  const details =
    cause && typeof cause === "object" && "message" in cause
      ? String((cause as { message?: unknown }).message ?? "")
      : String(cause ?? "")
  const category = cause instanceof Error ? cause.name : typeof cause
  const error = new Error(
    `[wechat-compat] stage-a go/no-go blocker while loading public entry ./index.ts. ` +
      `category=${category} details=${details}`,
  )
  ;(error as Error & { cause?: unknown }).cause = cause
  return error
}

async function resolveCompiledEntryImportHref(): Promise<string> {
  if (!compiledEntryImportHrefPromise) {
    compiledEntryImportHrefPromise = (async () => {
      assertNodeVersionSupportsCompatCompilation()
      const entry = await resolveOpenClawWeixinPublicEntry()
      const compiledEntryPath = await compileOpenClawWeixinPublicEntry(entry)
      return pathToFileURL(compiledEntryPath).href
    })()
    compiledEntryImportHrefPromise.catch(() => {
      compiledEntryImportHrefPromise = null
    })
  }
  return compiledEntryImportHrefPromise
}

export async function resolveOpenClawWeixinCompatImportPath(): Promise<string> {
  const compiledEntryHref = await resolveCompiledEntryImportHref()
  return fileURLToPath(compiledEntryHref)
}

export async function loadOpenClawWeixinDefaultExport(): Promise<OpenClawWeixinPlugin> {
  try {
    const compiledEntryHref = await resolveCompiledEntryImportHref()
    const moduleNamespace = await import(compiledEntryHref)
    if (typeof moduleNamespace.default?.register === "function") {
      return moduleNamespace.default as OpenClawWeixinPlugin
    }
    throw new Error("[wechat-compat] @tencent-weixin/openclaw-weixin public entry default export is missing register(api)")
  } catch (error) {
    throw createStageABlockerError(error)
  }
}

export async function loadAndRegisterOpenClawWeixin(api: WechatCompatHostApi): Promise<OpenClawWeixinPlugin> {
  assertMinimalWechatHostContract(api)
  const plugin = await loadOpenClawWeixinDefaultExport()
  plugin.register(api)
  return plugin
}
