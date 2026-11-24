import { assertRpcAccess, authorize, type ResourceAccess } from '../../admission/access-policy'
import { assertPathInScope, pathScopeOf } from '../../data/sessions/guest-path-scope'
import { projectRootForRequest } from '../../files/file-preview'
import { createAssetUrl, createFileDownloadUrl, findAssetUrl, writeAssetUpload } from '../../data/assets/assets'
import type { SolusServer } from '../server'

export function registerAssetHandlers(server: SolusServer, resources?: ResourceAccess): void {
  server.register('assetUpload', async (args) => writeAssetUpload(args[0]))
  server.register('assetCreateUrl', async (args, { principal }) => {
    const [ctx, request] = args
    if (!request.download) return createAssetUrl(ctx, request)
    if (!server.servesExecution()) throw new Error('This host does not serve checkout files.')
    await assertRpcAccess('readProjectFile', principal, [], resources)
    const sessionId = ctx?.session.sessionId
    if (sessionId) {
      const refusal = await authorize(principal, 'read.files', { kind: 'session', id: sessionId }, { name: 'assetCreateUrl', resources })
      if (refusal) throw new Error(refusal.detail)
    }
    assertPathInScope('readProjectFile', principal, ctx ? projectRootForRequest(ctx) : null)
    if (request.assetId) throw new Error('The download needs a session file path.')
    return createFileDownloadUrl(ctx, request, { scope: pathScopeOf(principal) })
  })
  server.register('assetFindUrl', async (args) => {
    const [ctx, request] = args
    return findAssetUrl(ctx, request)
  })
}
