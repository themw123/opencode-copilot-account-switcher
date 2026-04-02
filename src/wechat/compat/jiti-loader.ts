import { createRequire } from "node:module"

export type JitiLoader = (path: string) => unknown
type CreateJiti = (id: string | URL, options?: Record<string, unknown>) => JitiLoader
type JitiImport = (specifier: string) => Promise<unknown> | unknown

type JitiNamespace = {
  createJiti?: unknown
  default?: unknown
}

function isCreateJiti(value: unknown): value is CreateJiti {
  return typeof value === "function"
}

export function resolveCreateJiti(namespace: JitiNamespace): CreateJiti {
  if (isCreateJiti(namespace)) {
    return namespace
  }
  if (isCreateJiti(namespace.createJiti)) {
    return namespace.createJiti
  }
  if (isCreateJiti(namespace.default)) {
    return namespace.default
  }
  if (
    namespace.default &&
    typeof namespace.default === "object" &&
    isCreateJiti((namespace.default as JitiNamespace).createJiti)
  ) {
    return (namespace.default as JitiNamespace).createJiti as CreateJiti
  }
  throw new Error("[wechat-compat] createJiti export unavailable")
}

export async function loadJiti(importImpl: JitiImport = (specifier) => import(specifier)): Promise<{ createJiti: CreateJiti }> {
  const namespace = await Promise.resolve(importImpl("jiti")) as JitiNamespace
  return {
    createJiti: resolveCreateJiti(namespace),
  }
}
