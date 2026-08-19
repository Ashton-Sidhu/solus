import { createAssetUrl } from '../assets'
import type { SolusServer } from '../server'

export function registerAssetHandlers(server: SolusServer): void {
  server.register('assetCreateUrl', async (args) => {
    const [ctx, request] = args
    return createAssetUrl(ctx, request?.path)
  })
}
