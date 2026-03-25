export const STAGE_A_SLASH_ONLY_MESSAGE = "当前阶段仅支持命令型交互，请发送 /status、/reply 或 /allow。"

export type SlashOnlyCommand = "status" | "reply" | "allow"

export type SlashGuardResult =
  | {
      accepted: true
      command: SlashOnlyCommand
      argument: string
    }
  | {
      accepted: false
      message: string
    }

const ALLOWED_COMMANDS = new Set<SlashOnlyCommand>(["status", "reply", "allow"])

export function guardSlashOnlyInput(input: string): SlashGuardResult {
  const normalized = input.trim()
  if (!normalized.startsWith("/")) {
    return {
      accepted: false,
      message: STAGE_A_SLASH_ONLY_MESSAGE,
    }
  }

  const [commandSegment = "", ...rest] = normalized.slice(1).trim().split(/\s+/)
  const command = commandSegment.toLowerCase() as SlashOnlyCommand

  if (!ALLOWED_COMMANDS.has(command)) {
    return {
      accepted: false,
      message: STAGE_A_SLASH_ONLY_MESSAGE,
    }
  }

  return {
    accepted: true,
    command,
    argument: rest.join(" "),
  }
}
