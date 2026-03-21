export type SharedRetryNotifier = {
  started: (state: { remaining: number }) => Promise<void>
  progress: (state: { remaining: number }) => Promise<void>
  repairWarning: (state: { remaining: number }) => Promise<void>
  completed: (state: { remaining: number }) => Promise<void>
  stopped: (state: { remaining: number }) => Promise<void>
}

export const noopSharedRetryNotifier: SharedRetryNotifier = {
  started: async () => {},
  progress: async () => {},
  repairWarning: async () => {},
  completed: async () => {},
  stopped: async () => {},
}

export async function notifySharedRetryEvent(
  notifier: SharedRetryNotifier,
  event: keyof SharedRetryNotifier,
  remaining: number,
) {
  try {
    await notifier[event]({ remaining })
  } catch (error) {
    console.warn(`[copilot-network-retry] notifier ${event} failed`, error)
  }
}

export type SharedRetryErrorContainer = {
  retryableMessages: string[]
  isAbortError?: (error: unknown) => boolean
}

export function getSharedErrorMessage(error: unknown) {
  return String(error instanceof Error ? error.message : error).toLowerCase()
}

export function isRetryableErrorByContainer(error: unknown, container: SharedRetryErrorContainer) {
  if (!error) return false
  if (container.isAbortError?.(error)) return false
  const message = getSharedErrorMessage(error)
  return container.retryableMessages.some((part) => message.includes(part))
}

export type SharedFailOpenResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: unknown }

export async function runSharedFailOpenBoundary<T>(options: {
  action: () => Promise<T>
  isFailOpenError: (error: unknown) => boolean
  onFailOpen?: (error: unknown) => void
}): Promise<SharedFailOpenResult<T>> {
  try {
    return {
      ok: true,
      value: await options.action(),
    }
  } catch (error) {
    if (!options.isFailOpenError(error)) throw error
    options.onFailOpen?.(error)
    return {
      ok: false,
      error,
    }
  }
}

export type SharedRetryIterationResult = {
  handled: boolean
  stop: boolean
  shouldContinue: boolean
}

export async function runSharedRetryScheduler(options: {
  initialShouldContinue: boolean
  runIteration: (input: { attempts: number }) => Promise<SharedRetryIterationResult>
}) {
  let attempts = 0
  let shouldContinue = options.initialShouldContinue

  while (shouldContinue) {
    shouldContinue = false
    const result = await options.runIteration({ attempts })
    if (!result.handled || result.stop) break
    attempts += 1
    shouldContinue = result.shouldContinue
  }

  return { attempts }
}
