import { createRequire } from "node:module"
import { createJiti } from "jiti"

export type PublicWeixinPersistGetUpdatesBuf = (params: {
  accountId: string
  getUpdatesBuf: string
}) => Promise<void>

const OPENCLAW_SYNC_BUF_MODULE = "@tencent-weixin/openclaw-weixin/src/storage/sync-buf.ts"

let syncBufJitiLoader: ReturnType<typeof createJiti> | null = null

function getSyncBufJiti() {
  if (syncBufJitiLoader) {
    return syncBufJitiLoader
  }
  syncBufJitiLoader = createJiti(import.meta.url, {
    interopDefault: true,
    extensions: [".ts", ".tsx", ".mts", ".cts", ".js", ".mjs", ".cjs", ".json"],
  })
  return syncBufJitiLoader
}

export function createOpenClawSyncBufHelper(input: {
  getSyncBufFilePath: (accountId: string) => string
  saveGetUpdatesBuf: (filePath: string, getUpdatesBuf: string) => void
}): {
  persistGetUpdatesBuf: PublicWeixinPersistGetUpdatesBuf
} {
  return {
    async persistGetUpdatesBuf({ accountId, getUpdatesBuf }) {
      const filePath = input.getSyncBufFilePath(accountId)
      input.saveGetUpdatesBuf(filePath, getUpdatesBuf)
    },
  }
}

export async function loadOpenClawSyncBufHelper(options: {
  syncBufModulePath?: string
} = {}): Promise<{
  persistGetUpdatesBuf?: PublicWeixinPersistGetUpdatesBuf
}> {
  const require = createRequire(import.meta.url)
  const syncBufModulePath = require.resolve(options.syncBufModulePath ?? OPENCLAW_SYNC_BUF_MODULE)
  const syncBufModule = getSyncBufJiti()(syncBufModulePath) as {
    getSyncBufFilePath?: (accountId: string) => string
    saveGetUpdatesBuf?: (filePath: string, getUpdatesBuf: string) => void
  }

  if (typeof syncBufModule.getSyncBufFilePath !== "function" || typeof syncBufModule.saveGetUpdatesBuf !== "function") {
    return {}
  }

  return createOpenClawSyncBufHelper({
    getSyncBufFilePath: syncBufModule.getSyncBufFilePath,
    saveGetUpdatesBuf: syncBufModule.saveGetUpdatesBuf,
  })
}
