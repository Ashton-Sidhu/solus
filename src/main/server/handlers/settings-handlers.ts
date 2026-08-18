import {
  getServerSettings,
  resolveSourceControlWriterModel,
  resolveTextGenerationModel,
  setAgentTaskLifecyclePolicy,
  setAnalyticsConsent,
  setOtelSettings,
  setTextGenerationSettings,
} from '../settings'
import { configureOtel, otelActiveSignals, otelManagedByEnvironment } from '../../otel'
import type { SolusServer } from '../server'
import type { OtelSettingsSnapshot, TextGenerationSettingsSnapshot } from '../../../shared/types'
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
      backupTextGenerationModel: settings.backupTextGenerationModel,
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

  const otelSnapshot = (): OtelSettingsSnapshot => ({
    settings: getServerSettings().otel,
    managedByEnvironment: otelManagedByEnvironment(),
    active: otelActiveSignals(),
  })

  server.register('otelSettingsGet', () => otelSnapshot())

  server.register('otelSettingsUpdate', async (args) => {
    // SAFETY: The RPC method contract supplies the settings patch in slot zero.
    const [patch] = args
    const settings = setOtelSettings(patch ?? {})
    // Applied to the running process, not just persisted: an operator who
    // turns export on should see data arrive without restarting the host.
    await configureOtel(settings.otel)
    return otelSnapshot()
  })
}
