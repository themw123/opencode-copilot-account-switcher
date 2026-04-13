import path from "node:path"
import { mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { zipSync } from "fflate"
import { collectWechatDebugBundle, type CollectWechatDebugBundleOptions } from "./debug-bundle-collector.js"
import type { WechatDebugBundleMode } from "./debug-bundle-redaction.js"

const EXPORT_SUCCESS_PREFIX = "微信调试包已生成："
const EXPORT_FAILURE_MESSAGE = "导出微信调试包失败"
const MISSING_DIAGNOSTICS_MESSAGE = "没有可导出的微信诊断文件"
const MISSING_STATE_ROOT_MESSAGE = "微信状态目录不存在，无法导出调试包"
const ZIP_WRITE_FAILURE_MESSAGE = "创建压缩包失败"

export type RunWechatDebugBundleFlowInput = CollectWechatDebugBundleOptions & {
  outputRootDir?: string
}

export type WechatDebugBundleFlowResult = {
  mode: WechatDebugBundleMode
  bundlePath: string
  message: string
}

export type WechatDebugBundleFailureCode =
  | "missing-state-root"
  | "missing-diagnostics"
  | "zip-write-failed"
  | "zip-cleanup-failed"
  | "export-failed"

export type WechatDebugBundleFailureResult = {
  ok: false
  mode: WechatDebugBundleMode
  code: WechatDebugBundleFailureCode
  message: string
  archivePath?: string
  details?: {
    archivePath?: string
    cause?: string
    writeCause?: string
    cleanupCause?: string
  }
}

type RunWechatDebugBundleFlowDeps = {
  writeArchiveFile?: typeof writeFile
  removeArchiveFile?: typeof rm
}

class WechatDebugBundleFlowError extends Error {
  readonly failure: WechatDebugBundleFailureResult

  constructor(failure: WechatDebugBundleFailureResult) {
    super(failure.message)
    this.name = "WechatDebugBundleFlowError"
    this.failure = failure
  }
}

export async function runWechatDebugBundleFlow(
  input: RunWechatDebugBundleFlowInput,
  deps: RunWechatDebugBundleFlowDeps = {},
): Promise<WechatDebugBundleFlowResult> {
  const now = input.now ?? new Date()
  const outputRootDir = input.outputRootDir ?? path.join(
    tmpdir(),
    "opencode-copilot-account-switcher",
    "wechat-debug-bundles",
  )
  const bundle = await collectWechatDebugBundleOrThrow(input)
  if (!bundle.entries.some((entry) => entry.category === "diagnostics")) {
    throw new WechatDebugBundleFlowError({
      ok: false,
      mode: input.mode,
      code: "missing-diagnostics",
      message: MISSING_DIAGNOSTICS_MESSAGE,
    })
  }

  let archive: Uint8Array
  try {
    archive = zipSync(Object.fromEntries(bundle.entries.map((entry) => [entry.bundlePath, entry.content])))
  } catch (error) {
    throw new WechatDebugBundleFlowError(createZipWriteFailureResult(input.mode, error))
  }

  let finalBundlePath: string
  try {
    await mkdir(outputRootDir, { recursive: true })
    finalBundlePath = await writeBundleArchiveCollisionSafe({
      archive,
      mode: input.mode,
      now,
      outputRootDir,
      writeArchiveFile: deps.writeArchiveFile ?? writeFile,
      removeArchiveFile: deps.removeArchiveFile ?? rm,
    })
  } catch (error) {
    throw toFlowError(error, createZipWriteFailureResult(input.mode, error))
  }

  return {
    mode: input.mode,
    bundlePath: finalBundlePath,
    message: `${EXPORT_SUCCESS_PREFIX}${finalBundlePath}`,
  }
}

export function toWechatDebugBundleFailureResult(
  error: unknown,
  input?: { mode?: WechatDebugBundleMode },
): WechatDebugBundleFailureResult {
  if (error instanceof WechatDebugBundleFlowError) {
    return error.failure
  }
  return {
    ok: false,
    mode: input?.mode ?? "sanitized",
    code: "export-failed",
    message: EXPORT_FAILURE_MESSAGE,
    details: {
      cause: toErrorMessage(error),
    },
  }
}

export function toWechatDebugBundleFailureMessage(error: unknown, input?: { mode?: WechatDebugBundleMode }) {
  return toWechatDebugBundleFailureResult(error, input).message
}

function buildWechatDebugBundleFileName(mode: WechatDebugBundleMode, now: Date) {
  const modeLabel = mode === "sanitized" ? "sanitized" : "full"
  const timestamp = now.toISOString().replace(/\.\d{3}Z$/, "").replaceAll(":", "-")
  return `wechat-debug-bundle-${modeLabel}-${timestamp}.zip`
}

async function writeBundleArchiveCollisionSafe(input: {
  archive: Uint8Array
  mode: WechatDebugBundleMode
  now: Date
  outputRootDir: string
  writeArchiveFile: typeof writeFile
  removeArchiveFile: typeof rm
}) {
  const preferredName = buildWechatDebugBundleFileName(input.mode, input.now)
  const extension = path.extname(preferredName)
  const nameWithoutExtension = preferredName.slice(0, -extension.length)

  for (let attempt = 0; attempt < 10_000; attempt += 1) {
    const suffix = attempt === 0 ? "" : `-${attempt + 1}`
    const candidatePath = path.join(input.outputRootDir, `${nameWithoutExtension}${suffix}${extension}`)
    try {
      await input.writeArchiveFile(candidatePath, input.archive, { flag: "wx" })
      return candidatePath
    } catch (error) {
      if (isAlreadyExistsError(error)) {
        continue
      }
      const cleanupError = await tryRemovePartialArchive(candidatePath, input.removeArchiveFile)
      if (cleanupError) {
        throw new WechatDebugBundleFlowError(createZipCleanupFailureResult(input.mode, candidatePath, error, cleanupError))
      }
      throw new WechatDebugBundleFlowError(createZipWriteFailureResult(input.mode, error, candidatePath))
    }
  }

  throw new WechatDebugBundleFlowError(createZipWriteFailureResult(input.mode, "unique-name-exhausted"))
}

async function collectWechatDebugBundleOrThrow(input: CollectWechatDebugBundleOptions) {
  try {
    return await collectWechatDebugBundle(input)
  } catch (error) {
    const message = toErrorMessage(error)
    if (message === MISSING_STATE_ROOT_MESSAGE) {
      throw new WechatDebugBundleFlowError({
        ok: false,
        mode: input.mode,
        code: "missing-state-root",
        message,
      })
    }
    throw new WechatDebugBundleFlowError({
      ok: false,
      mode: input.mode,
      code: "export-failed",
      message: EXPORT_FAILURE_MESSAGE,
      details: {
        cause: message,
      },
    })
  }
}

function isAlreadyExistsError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === "EEXIST"
}

function toFlowError(error: unknown, fallbackFailure: WechatDebugBundleFailureResult) {
  if (error instanceof WechatDebugBundleFlowError) {
    return error
  }
  return new WechatDebugBundleFlowError(fallbackFailure)
}

function createZipWriteFailureResult(
  mode: WechatDebugBundleMode,
  error: unknown,
  archivePath?: string,
): WechatDebugBundleFailureResult {
  const details = {
    ...(archivePath ? { archivePath } : {}),
    writeCause: toErrorMessage(error),
  }
  return {
    ok: false,
    mode,
    code: "zip-write-failed",
    message: ZIP_WRITE_FAILURE_MESSAGE,
    details,
  }
}

function createZipCleanupFailureResult(
  mode: WechatDebugBundleMode,
  archivePath: string,
  writeError: unknown,
  cleanupError: unknown,
): WechatDebugBundleFailureResult {
  return {
    ok: false,
    mode,
    code: "zip-cleanup-failed",
    message: `创建压缩包失败，请手动删除残留压缩包：${archivePath}`,
    archivePath,
    details: {
      archivePath,
      writeCause: toErrorMessage(writeError),
      cleanupCause: toErrorMessage(cleanupError),
    },
  }
}

async function tryRemovePartialArchive(filePath: string, removeArchiveFile: typeof rm) {
  try {
    await removeArchiveFile(filePath, { force: true })
    return undefined
  } catch (error) {
    return error
  }
}

function toErrorMessage(error: unknown) {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message
  }
  return String(error)
}
