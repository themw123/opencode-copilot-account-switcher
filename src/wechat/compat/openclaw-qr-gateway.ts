export type WeixinQrGateway = {
  loginWithQrStart: (input?: unknown) => unknown
  loginWithQrWait: (input?: unknown) => unknown
}

type OpenClawQrGatewayPayload = {
  plugin?: unknown
}

function toObjectInput(input: unknown): Record<string, unknown> {
  return input && typeof input === "object" ? (input as Record<string, unknown>) : {}
}

function hasQrLoginMethods(value: unknown): value is WeixinQrGateway {
  if (!value || typeof value !== "object") {
    return false
  }
  const candidate = value as {
    loginWithQrStart?: unknown
    loginWithQrWait?: unknown
  }
  return typeof candidate.loginWithQrStart === "function" && typeof candidate.loginWithQrWait === "function"
}

export function createOpenClawQrGateway(source: WeixinQrGateway): WeixinQrGateway {
  return {
    async loginWithQrStart(input?: unknown) {
      return source.loginWithQrStart(toObjectInput(input))
    },
    async loginWithQrWait(input?: unknown) {
      return source.loginWithQrWait(toObjectInput(input))
    },
  }
}

export async function loadOpenClawQrGateway(
  payloads: OpenClawQrGatewayPayload[],
  options: { pluginId?: string } = {},
): Promise<{ gateway: WeixinQrGateway; pluginId: string }> {
  for (const payload of payloads) {
    const payloadPlugin = payload?.plugin
    const resolvedPluginId =
      typeof options.pluginId === "string" && options.pluginId.trim().length > 0
        ? options.pluginId
        : typeof (payloadPlugin as { id?: unknown } | null | undefined)?.id === "string" &&
            String((payloadPlugin as { id?: unknown }).id).trim().length > 0
          ? String((payloadPlugin as { id?: unknown }).id)
          : "unknown"
    const gateway = payloadPlugin && typeof payloadPlugin === "object" ? (payloadPlugin as { gateway?: unknown }).gateway : null
    if (hasQrLoginMethods(gateway)) {
      return {
        gateway: createOpenClawQrGateway(gateway),
        pluginId: resolvedPluginId,
      }
    }
    if (hasQrLoginMethods(payloadPlugin)) {
      return {
        gateway: createOpenClawQrGateway(payloadPlugin),
        pluginId: resolvedPluginId,
      }
    }
  }

  throw new Error("registerChannel did not expose weixin gateway loginWithQrStart/loginWithQrWait")
}
