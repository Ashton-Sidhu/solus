import type { EditorId, HostCapabilities } from '@solus/contracts/types'
import { hostDisplayName } from '../../platform/host-display-name'
import { appVersion } from '../../platform/paths'
import { INTERNAL_HANDLER_CTX, type SolusServer } from '../server'
import { browserRecordingEncoderHost } from '../../browser/surface-driver'
import type { Principal } from '../../admission/principal'
import type { ProbedHostCapabilities } from './setup-handlers'

/** Advertise only handlers this host actually registered, plus what `probe`
 * learns about the machine for this caller. The editor probe is cached because
 * it can search the host PATH and capabilities are otherwise a cheap record
 * assembly. A guest learns nothing that names the machine. */
export function registerCapabilityHandlers(
  server: SolusServer,
  probe: (principal: Principal) => Promise<ProbedHostCapabilities>,
): void {
  let editorIdsPromise: Promise<EditorId[]> | null = null

  server.register('serverGetCapabilities', async (_args, ctx): Promise<HostCapabilities> => {
    const probing = probe(ctx.principal)
    const supportsEditors = server.hasHandler('detectEditors')
    if (supportsEditors && !editorIdsPromise) {
      editorIdsPromise = server.handle('detectEditors', [], INTERNAL_HANDLER_CTX)
        .then((result) => result.editors.map((editor) => editor.id))
        .catch(() => [])
    }
    const editors = supportsEditors && editorIdsPromise ? await editorIdsPromise : undefined
    const probed = await probing

    const capabilities: HostCapabilities = {
      ...probed,
      // The running build's version, for the client's per-host skew notice.
      version: appVersion(),
      // The machine's own name. A client saved this host under whatever it could
      // derive at pairing time; this is the host correcting that record.
      name: hostDisplayName(),
      attachUpload: server.hasHandler('attachUpload'),
      attachStreamUpload: server.hasHandler('attachUploadToken'),
      // Not a handler: this build reads image refs off a prompt. An older host
      // omits the field, and its clients keep sending the bytes inline.
      promptImageRefs: server.hasHandler('attachUpload'),
      assetUrls: server.hasHandler('assetCreateUrl'),
      skillsInstall: server.hasHandler('skillsInstall'),
      skillsSearch: server.hasHandler('skillsSearch'),
      skillsManage: server.hasHandler('skillsList') && server.hasHandler('skillsRemove'),
      voiceModel: server.hasHandler('voiceModelStatus'),
      automations: server.hasHandler('automationList'),
      githubProvider: server.hasHandler('providerStatus'),
      browser: server.hasHandler('browserListPages'),
      // An encoder host exists only where a Chromium can record. Whether it
      // records H.264 is known when the encoder page opens, and says so there.
      browserRecording: server.hasHandler('browserRecordingStart') && browserRecordingEncoderHost() !== null,
      hostUpdates: server.hasHandler('hostUpdateStatus'),
      modelProfiles: server.hasHandler('modelProfilesStatus'),
      atlassianProvider: server.hasHandler('atlassianStatus'),
    }
    if (editors) capabilities.editors = editors
    if (ctx.principal.kind === 'guest') {
      delete capabilities.name
      delete capabilities.editors
    }
    return capabilities
  })
}
