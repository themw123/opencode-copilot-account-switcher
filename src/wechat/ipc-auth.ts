import { randomUUID } from "node:crypto"
import type { BrokerMessageType } from "./protocol.js"

type SessionRecord = {
  token: string
  connectionRef: unknown
}

const sessionByInstanceID = new Map<string, SessionRecord>()

const TOKEN_FREE_TYPES: BrokerMessageType[] = ["registerInstance", "ping"]

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0
}

export function createSessionToken(): string {
  return randomUUID()
}

export function registerConnection(instanceID: string, connectionRef: unknown): string {
  if (!isNonEmptyString(instanceID)) {
    throw new Error("invalid instanceID")
  }

  const token = createSessionToken()
  sessionByInstanceID.set(instanceID, { token, connectionRef })
  return token
}

export function validateSessionToken(instanceID: string, token: string): boolean {
  if (!isNonEmptyString(instanceID) || !isNonEmptyString(token)) {
    return false
  }

  const current = sessionByInstanceID.get(instanceID)
  if (!current) {
    return false
  }

  return current.token === token
}

export function revokeSessionToken(instanceID: string): void {
  if (!isNonEmptyString(instanceID)) {
    return
  }

  sessionByInstanceID.delete(instanceID)
}

export function isAuthRequired(type: BrokerMessageType): boolean {
  if (TOKEN_FREE_TYPES.includes(type)) {
    return false
  }
  return true
}
