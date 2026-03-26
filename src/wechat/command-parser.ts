export type WechatSlashCommand = {
  type: "status"
} | {
  type: "reply"
  text: string
} | {
  type: "allow"
  reply: "once" | "always" | "reject"
  message?: string
}

export function parseWechatSlashCommand(input: string): WechatSlashCommand | null {
  if (typeof input !== "string") {
    return null
  }

  const normalized = input.trim()
  if (normalized === "/status") {
    return { type: "status" }
  }

  if (normalized.startsWith("/reply")) {
    const text = normalized.slice("/reply".length).trim()
    if (!text) {
      return null
    }
    return { type: "reply", text }
  }

  if (normalized.startsWith("/allow")) {
    const rest = normalized.slice("/allow".length).trim()
    if (!rest) {
      return null
    }
    const [rawReply, ...messageParts] = rest.split(/\s+/)
    if (rawReply !== "once" && rawReply !== "always" && rawReply !== "reject") {
      return null
    }
    const message = messageParts.join(" ").trim()
    return message.length > 0
      ? { type: "allow", reply: rawReply, message }
      : { type: "allow", reply: rawReply }
  }

  return null
}
