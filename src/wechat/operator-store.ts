import path from "node:path"
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises"
import { WECHAT_FILE_MODE, ensureWechatStateLayout, operatorStatePath } from "./state-paths.js"

export type OperatorBinding = {
  wechatAccountId: string
  userId: string
  boundAt: number
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0
}

function isValidBinding(input: Partial<OperatorBinding>): input is OperatorBinding {
  return (
    isNonEmptyString(input.wechatAccountId) &&
    isNonEmptyString(input.userId) &&
    typeof input.boundAt === "number" &&
    Number.isFinite(input.boundAt)
  )
}

function toBinding(input: OperatorBinding): OperatorBinding {
  return {
    wechatAccountId: input.wechatAccountId,
    userId: input.userId,
    boundAt: input.boundAt,
  }
}

export async function readOperatorBinding(): Promise<OperatorBinding | undefined> {
  try {
    const raw = await readFile(operatorStatePath(), "utf8")
    const parsed = JSON.parse(raw) as Partial<OperatorBinding>
    if (!isValidBinding(parsed)) {
      throw new Error("invalid operator binding format")
    }
    return toBinding(parsed)
  } catch (error) {
    const issue = error as NodeJS.ErrnoException
    if (issue.code === "ENOENT") return undefined
    throw error
  }
}

export async function bindOperator(input: OperatorBinding): Promise<OperatorBinding> {
  const next = toBinding(input)
  if (!isValidBinding(next)) {
    throw new Error("invalid operator binding format")
  }
  const existing = await readOperatorBinding()

  if (existing && (existing.userId !== next.userId || existing.wechatAccountId !== next.wechatAccountId)) {
    throw new Error("operator already bound to another user")
  }

  await ensureWechatStateLayout()
  await mkdir(path.dirname(operatorStatePath()), { recursive: true })
  await writeFile(operatorStatePath(), JSON.stringify(next, null, 2), { mode: WECHAT_FILE_MODE })
  return next
}

export async function rebindOperator(input: OperatorBinding): Promise<OperatorBinding> {
  const next = toBinding(input)
  if (!isValidBinding(next)) {
    throw new Error("invalid operator binding format")
  }
  await ensureWechatStateLayout()
  await mkdir(path.dirname(operatorStatePath()), { recursive: true })
  await writeFile(operatorStatePath(), JSON.stringify(next, null, 2), { mode: WECHAT_FILE_MODE })
  return next
}

export async function resetOperatorBinding() {
  try {
    await unlink(operatorStatePath())
  } catch (error) {
    const issue = error as NodeJS.ErrnoException
    if (issue.code !== "ENOENT") throw error
  }
}
