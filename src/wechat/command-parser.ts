export type WechatSlashCommand = {
  type: "status"
} | {
  type: "unimplemented"
  command: string
}

export function parseWechatSlashCommand(input: string): WechatSlashCommand | null {
  if (typeof input !== "string") {
    return null
  }

  const normalized = input.trim()
  if (normalized === "/status") {
    return { type: "status" }
  }

  if (normalized.startsWith("/")) {
    const command = normalized.slice(1).split(/\s+/, 1)[0]
    if (command === "reply" || command === "allow") {
      return { type: "unimplemented", command }
    }
  }

  return null
}
