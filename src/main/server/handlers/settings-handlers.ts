import {
  getServerSettings,
  resolveSourceControlWriterModel,
  resolveTextGenerationModel,
  setAgentTaskLifecyclePolicy,
  setAnalyticsConsent,
  setTextGenerationSettings,
} from '../settings'
import type { SolusServer } from '../server'
import type { TextGenerationSettingsSnapshot } from '../../../shared/types'
import type { ControlPlane } from '../../control-plane'
import { enrichAgentMetadata } from './session-handlers'

export function registerSettingsHandlers(
  server: SolusServer,
  deps: { controlPlane: ControlPlane },
): void {
  server.register('setAnalyticsConsent', (args) => {
    const [enabled] = args
    setAnalyticsConsent(enabled === true)
  })

  server.register('setAgentTaskLifecyclePolicy', (args) => {
    const [policy] = args
    if (policy !== 'none' && policy !== 'moderate' && policy !== 'autonomous') {
      throw new Error('Invalid agent task lifecycle policy.')
    }
    return {
      agentTaskLifecyclePolicy: setAgentTaskLifecyclePolicy(policy).agentTaskLifecyclePolicy,
    }
  })

  const textGenerationSnapshot = async (): Promise<TextGenerationSettingsSnapshot> => {
    const agents = await Promise.all(
      deps.controlPlane
        .getBackendIds()
        .map((id) => deps.controlPlane.getMetadataFor(id))
        .filter((metadata) => metadata !== undefined)
        .map(enrichAgentMetadata),
    )
    const settings = getServerSettings()
    return {
      textGenerationModel: settings.textGenerationModel,
      sourceControlWriterModel: settings.sourceControlWriterModel,
      sourceControlWriting: settings.sourceControlWriting,
      effectiveTextGenerationModel: resolveTextGenerationModel(),
      effectiveSourceControlWriterModel: resolveSourceControlWriterModel(),
      agents,
    }
  }

  server.register('textGenerationSettingsGet', () => textGenerationSnapshot())

  server.register('textGenerationSettingsUpdate', async (args) => {
    // SAFETY: The RPC method contract supplies the settings patch in slot zero.
    const [patch] = args
    setTextGenerationSettings(patch ?? {})
    return textGenerationSnapshot()
  })
}
