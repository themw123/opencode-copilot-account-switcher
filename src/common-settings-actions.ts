import type { CommonSettingsStore } from "./common-settings-store.js"

export type CommonSettingsActionType =
  | "toggle-loop-safety"
  | "toggle-loop-safety-provider-scope"
  | "toggle-experimental-slash-commands"
  | "toggle-network-retry"
  | "toggle-wechat-notifications"
  | "toggle-wechat-question-notify"
  | "toggle-wechat-permission-notify"
  | "toggle-wechat-session-error-notify"

type WriteMeta = {
  reason?: string
  source?: string
  actionType?: string
}

export async function applyCommonSettingsAction(input: {
  action: { type: CommonSettingsActionType }
  readSettings: () => Promise<CommonSettingsStore>
  writeSettings: (settings: CommonSettingsStore, meta?: WriteMeta) => Promise<void>
}): Promise<boolean> {
  const settings = await input.readSettings()

  if (input.action.type === "toggle-loop-safety") {
    settings.loopSafetyEnabled = settings.loopSafetyEnabled !== true
    await input.writeSettings(settings, {
      reason: "toggle-loop-safety",
      source: "applyCommonSettingsAction",
      actionType: "toggle-loop-safety",
    })
    return true
  }

  if (input.action.type === "toggle-loop-safety-provider-scope") {
    settings.loopSafetyProviderScope = settings.loopSafetyProviderScope === "all-models"
      ? "copilot-only"
      : "all-models"
    await input.writeSettings(settings, {
      reason: "toggle-loop-safety-provider-scope",
      source: "applyCommonSettingsAction",
      actionType: "toggle-loop-safety-provider-scope",
    })
    return true
  }

  if (input.action.type === "toggle-experimental-slash-commands") {
    settings.experimentalSlashCommandsEnabled = settings.experimentalSlashCommandsEnabled !== true
    await input.writeSettings(settings, {
      reason: "toggle-experimental-slash-commands",
      source: "applyCommonSettingsAction",
      actionType: "toggle-experimental-slash-commands",
    })
    return true
  }

  if (input.action.type === "toggle-network-retry") {
    settings.networkRetryEnabled = settings.networkRetryEnabled !== true
    await input.writeSettings(settings, {
      reason: "toggle-network-retry",
      source: "applyCommonSettingsAction",
      actionType: "toggle-network-retry",
    })
    return true
  }

  if (input.action.type === "toggle-wechat-notifications") {
    settings.wechatNotificationsEnabled = settings.wechatNotificationsEnabled !== true
    await input.writeSettings(settings, {
      reason: "toggle-wechat-notifications",
      source: "applyCommonSettingsAction",
      actionType: "toggle-wechat-notifications",
    })
    return true
  }

  if (input.action.type === "toggle-wechat-question-notify") {
    settings.wechatQuestionNotifyEnabled = settings.wechatQuestionNotifyEnabled !== true
    await input.writeSettings(settings, {
      reason: "toggle-wechat-question-notify",
      source: "applyCommonSettingsAction",
      actionType: "toggle-wechat-question-notify",
    })
    return true
  }

  if (input.action.type === "toggle-wechat-permission-notify") {
    settings.wechatPermissionNotifyEnabled = settings.wechatPermissionNotifyEnabled !== true
    await input.writeSettings(settings, {
      reason: "toggle-wechat-permission-notify",
      source: "applyCommonSettingsAction",
      actionType: "toggle-wechat-permission-notify",
    })
    return true
  }

  if (input.action.type === "toggle-wechat-session-error-notify") {
    settings.wechatSessionErrorNotifyEnabled = settings.wechatSessionErrorNotifyEnabled !== true
    await input.writeSettings(settings, {
      reason: "toggle-wechat-session-error-notify",
      source: "applyCommonSettingsAction",
      actionType: "toggle-wechat-session-error-notify",
    })
    return true
  }

  return false
}
