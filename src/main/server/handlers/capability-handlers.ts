import type { EditorId, HostCapabilities } from '../../../shared/types'
import type { SolusServer } from '../server'

/** Advertise only handlers this host actually registered. The editor probe is
 * cached because it can search the host PATH and capabilities are otherwise a
 * cheap record assembly. */
export function registerCapabilityHandlers(server: SolusServer): void {
  let editorIdsPromise: Promise<EditorId[]> | null = null

  server.register('serverGetCapabilities', async (): Promise<HostCapabilities> => {
    const supportsEditors = server.hasHandler('detectEditors')
    if (supportsEditors && !editorIdsPromise) {
      editorIdsPromise = server.handle('detectEditors', [])
        .then((result) => result.editors.map((editor) => editor.id))
        .catch(() => [])
    }
    const editors = supportsEditors && editorIdsPromise ? await editorIdsPromise : undefined

    const capabilities: HostCapabilities = {
      attachUpload: server.hasHandler('attachUpload'),
      assetUrls: server.hasHandler('assetCreateUrl'),
      skillsInstall: server.hasHandler('skillsInstall'),
      skillsSearch: server.hasHandler('skillsSearch'),
      voiceModel: server.hasHandler('voiceModelStatus'),
      automations: server.hasHandler('automationList'),
      githubProvider: server.hasHandler('providerStatus'),
    }
    if (editors) capabilities.editors = editors
    return capabilities
  })
}
