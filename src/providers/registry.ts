import { CODEX_PROVIDER_DESCRIPTOR, COPILOT_PROVIDER_DESCRIPTOR, type ProviderDescriptor } from "./descriptor.js"
import { createCodexProviderDescriptor, createCopilotProviderDescriptor } from "./descriptor.js"
import type { buildPluginHooks as buildPluginHooksFn } from "../plugin-hooks.js"

const PROVIDER_DESCRIPTORS: ProviderDescriptor[] = [
  COPILOT_PROVIDER_DESCRIPTOR,
  CODEX_PROVIDER_DESCRIPTOR,
]

export function listProviderDescriptors(): ProviderDescriptor[] {
  return [...PROVIDER_DESCRIPTORS]
}

export function getProviderDescriptorByKey(key: string): ProviderDescriptor | undefined {
  return PROVIDER_DESCRIPTORS.find((descriptor) => descriptor.key === key)
}

export function getProviderDescriptorByProviderID(providerID: string): ProviderDescriptor | undefined {
  return PROVIDER_DESCRIPTORS.find((descriptor) => descriptor.providerIDs.includes(providerID))
}

export function isProviderIDSupportedByAnyDescriptor(providerID: string): boolean {
  return getProviderDescriptorByProviderID(providerID) !== undefined
}

type BuildPluginHooks = typeof buildPluginHooksFn

export function createProviderRegistry(input: {
  buildPluginHooks: BuildPluginHooks
}) {
  return {
    copilot: {
      descriptor: createCopilotProviderDescriptor({ buildPluginHooks: input.buildPluginHooks }),
    },
    codex: {
      descriptor: createCodexProviderDescriptor({ enabled: true }),
    },
  }
}
