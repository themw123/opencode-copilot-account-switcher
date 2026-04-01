import { createRequire } from "node:module"

type QrCodeTerminal = {
  generate(input: string, opts: { small?: boolean }, cb?: (output: string) => void): void
}

type QrCodeTerminalNamespace = {
  default?: unknown
  generate?: unknown
}

function isQrCodeTerminal(value: unknown): value is QrCodeTerminal {
  return Boolean(value && typeof value === "object" && typeof (value as QrCodeTerminal).generate === "function")
}

export function resolveQrCodeTerminal(namespace: QrCodeTerminalNamespace): QrCodeTerminal {
  if (isQrCodeTerminal(namespace)) {
    return namespace
  }
  if (isQrCodeTerminal(namespace.default)) {
    return namespace.default
  }
  throw new Error("[wechat-compat] qrcode-terminal export unavailable")
}

export function loadQrCodeTerminal(requireImpl: NodeRequire = createRequire(import.meta.url)): QrCodeTerminal {
  return resolveQrCodeTerminal(requireImpl("qrcode-terminal") as QrCodeTerminalNamespace)
}
