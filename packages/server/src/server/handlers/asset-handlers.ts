import { createAssetUrl, writeAssetUpload } from '../assets'
import type { SolusServer } from '../server'

export function registerAssetHandlers(server: SolusServer): void {
  server.register('assetUpload', async (args) => writeAssetUpload(args[0]))
  server.register('assetCreateUrl', async (args) => {
    const [ctx, request] = args
    return createAssetUrl(ctx, request)
  })
}
