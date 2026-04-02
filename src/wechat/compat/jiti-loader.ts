import { createRequire } from "node:module"
import path from "node:path"
import { pathToFileURL } from "node:url"

export type JitiLoader = (path: string) => unknown
type CreateJiti = (id: string | URL, options?: Record<string, unknown>) => JitiLoader
type InternalCreateJiti = (
  id: string | URL,
  options?: Record<string, unknown>,
  runtime?: {
    onError: (error: unknown) => never
    nativeImport: (id: string) => Promise<unknown>
    createRequire: typeof createRequire
  },
) => JitiLoader
type JitiImport = (specifier: string) => Promise<unknown> | unknown
type JitiResolve = (specifier: string) => string
type ModuleImport = (specifier: string) => Promise<unknown>

type JitiNamespace = {
  createJiti?: unknown
  default?: unknown
  "module.exports"?: unknown
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
  if (isCreateJiti(namespace["module.exports"])) {
    return namespace["module.exports"] as CreateJiti
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

export function resolveJitiEsmEntry(resolveImpl: JitiResolve = createRequire(import.meta.url).resolve): string {
  const packageJsonPath = resolveImpl("jiti/package.json")
  return pathToFileURL(path.join(path.dirname(packageJsonPath), "dist", "jiti.cjs")).href
}

function onJitiError(error: unknown): never {
  throw error
}

const nativeImport = (id: string) => import(id)

const DEFAULT_JITI_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".mjs", ".cjs", ".json"]

export function hasBunRuntime(bunVersion: string | undefined = process.versions?.bun): boolean {
  return typeof bunVersion === "string" && bunVersion.length > 0
}

export function wrapCreateJiti(createJiti: CreateJiti): CreateJiti {
  const requireFromJiti = createRequire(resolveJitiEsmEntry())
  let transformImpl: ((...args: unknown[]) => unknown) | undefined

  const lazyTransform = (...args: unknown[]) => {
    if (!transformImpl) {
      transformImpl = requireFromJiti("../dist/babel.cjs") as (...args: unknown[]) => unknown
    }
    return transformImpl(...args)
  }

  return (id, options = {}) => {
    const nextOptions = typeof options.transform === "function"
      ? options
      : { ...options, transform: lazyTransform }

    return (createJiti as InternalCreateJiti)(id, nextOptions, {
      onError: onJitiError,
      nativeImport,
      createRequire,
    })
  }
}

export async function loadJiti(
  importImpl: JitiImport = (specifier) => import(specifier),
  resolveImpl: JitiResolve = createRequire(import.meta.url).resolve,
): Promise<{ createJiti: CreateJiti }> {
  const namespace = await Promise.resolve(importImpl(resolveJitiEsmEntry(resolveImpl))) as JitiNamespace
  return {
    createJiti: wrapCreateJiti(resolveCreateJiti(namespace)),
  }
}

export async function loadModuleWithTsFallback(
  modulePath: string,
  options: {
    bunVersion?: string | undefined
    importImpl?: ModuleImport
    loadJitiImpl?: typeof loadJiti
    parentURL?: string | URL
    jitiOptions?: Record<string, unknown>
  } = {},
): Promise<unknown> {
  const moduleUrl = pathToFileURL(modulePath).href
  const importImpl = options.importImpl ?? nativeImport

  if (hasBunRuntime(options.bunVersion)) {
    return await importImpl(moduleUrl)
  }

  const { createJiti } = await (options.loadJitiImpl ?? loadJiti)()
  const loader = createJiti(options.parentURL ?? import.meta.url, {
    interopDefault: true,
    extensions: DEFAULT_JITI_EXTENSIONS,
    ...(options.jitiOptions ?? {}),
  })
  return loader(modulePath)
}
