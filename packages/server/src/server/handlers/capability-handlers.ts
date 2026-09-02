import type { EditorId, HostCapabilities } from '@solus/contracts/types'
import { appVersion } from '../../platform/paths'
import { INTERNAL_HANDLER_CTX, type SolusServer } from '../server'

/** Advertise only handlers this host actually registered. The editor probe is
 * cached because it can search the host PATH and capabilities are otherwise a
 * cheap record assembly. */
export function registerCapabilityHandlers(server: SolusServer): void {
  let editorIdsPromise: Promise<EditorId[]> | null = null

  server.register('serverGetCapabilities', async (): Promise<HostCapabilities> => {
    const supportsEditors = server.hasHandler('detectEditors')
    if (supportsEditors && !editorIdsPromise) {
      editorIdsPromise = server.handle('detectEditors', [], INTERNAL_HANDLER_CTX)
        .then((result) => result.editors.map((editor) => editor.id))
        .catch(() => [])
    }
    const editors = supportsEditors && editorIdsPromise ? await editorIdsPromise : undefined

    const capabilities: HostCapabilities = {
      // The running build's version, for the client's per-host skew notice.
      version: appVersion(),
      attachUpload: server.hasHandler('attachUpload'),
      // Not a handler: this build reads image refs off a prompt. An older host
      // omits the field, and its clients keep sending the bytes inline.
      promptImageRefs: server.hasHandler('attachUpload'),
      assetUrls: server.hasHandler('assetCreateUrl'),
      skillsInstall: server.hasHandler('skillsInstall'),
      skillsSearch: server.hasHandler('skillsSearch'),
      voiceModel: server.hasHandler('voiceModelStatus'),
      automations: server.hasHandler('automationList'),
      githubProvider: server.hasHandler('providerStatus'),
      browser: server.hasHandler('browserListPages'),
      atlassianProvider: server.hasHandler('atlassianStatus'),
    }
    if (editors) capabilities.editors = editors
    return capabilities
  })
}
