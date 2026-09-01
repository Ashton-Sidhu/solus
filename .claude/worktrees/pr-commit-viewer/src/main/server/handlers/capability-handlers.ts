import type { EditorId, HostCapabilities } from '../../../shared/types'
import type { SolusServer } from '../server'

const EDITOR_IDS = new Set<EditorId>(['vscode', 'vim', 'nvim', 'helix'])

function readEditorIds(result: unknown): EditorId[] {
  if (!result || typeof result !== 'object') return []
  const editors = (result as { editors?: unknown }).editors
  if (!Array.isArray(editors)) return []
  return editors.flatMap((editor) => {
    if (!editor || typeof editor !== 'object') return []
    const id = (editor as { id?: unknown }).id
    return typeof id === 'string' && EDITOR_IDS.has(id as EditorId) ? [id as EditorId] : []
  })
}

/** Advertise only handlers this host actually registered. The editor probe is
 * cached because it can search the host PATH and capabilities are otherwise a
 * cheap record assembly. */
export function registerCapabilityHandlers(server: SolusServer): void {
  let editorIdsPromise: Promise<EditorId[]> | null = null

  server.register('serverGetCapabilities', async (): Promise<HostCapabilities> => {
    const supportsEditors = server.hasHandler('detectEditors')
    if (supportsEditors && !editorIdsPromise) {
      editorIdsPromise = server.handle('detectEditors', []).then(readEditorIds).catch(() => [])
    }
    const editors = supportsEditors ? await editorIdsPromise! : undefined

    return {
      attachUpload: server.hasHandler('attachUpload'),
      assetUrls: server.hasHandler('assetCreateUrl'),
      skillsInstall: server.hasHandler('skillsInstall'),
      skillsSearch: server.hasHandler('skillsSearch'),
      voiceModel: server.hasHandler('voiceModelStatus'),
      automations: server.hasHandler('automationList'),
      ...(editors ? { editors } : {}),
      githubProvider: server.hasHandler('providerStatus'),
    }
  })
}
