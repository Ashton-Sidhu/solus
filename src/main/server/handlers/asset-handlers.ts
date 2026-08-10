import type { AssetCreateUrlRequest } from '../../../shared/rpc'
import type { IpcContext } from '../../../shared/types'
import { createAssetUrl } from '../assets'
import type { SolusServer } from '../server'

export function registerAssetHandlers(server: SolusServer): void {
  server.register('assetCreateUrl', async (args) => {
    const [ctx, request] = args as [IpcContext, AssetCreateUrlRequest]
    return createAssetUrl(ctx, request?.path)
  })
}
