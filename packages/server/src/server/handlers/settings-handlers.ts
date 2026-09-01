import {
  getHostConfig,
  resolveSourceControlWriterModel,
  resolveTextGenerationModel,
  setHostConfig,
} from '../settings'
import { hostConfigPatchSchema } from '@solus/contracts/host-config'
import { configureOtel, otelActiveSignals, otelManagedByEnvironment } from '../../otel'
import type { SolusServer } from '../server'
import type { OtelSettingsSnapshot, TextGenerationSettingsSnapshot } from '@solus/contracts/types'
import type { HostConfigSnapshot } from '@solus/contracts/host-config'
import type { ControlPlane } from '../../control-plane'
import { enrichAgentMetadata } from './session-handlers'

export function registerSettingsHandlers(
  server: SolusServer,
  deps: { controlPlane: ControlPlane; onHostConfigChanged: (snapshot: HostConfigSnapshot) => void },
): void {
  server.register('configGet', () => getHostConfig())

  server.register('configUpdate', async (args) => {
    // SAFETY: The RPC method contract supplies the config patch in slot zero.
    const [patch] = args
    const parsed = hostConfigPatchSchema.parse(patch ?? {})
    const snapshot = setHostConfig(parsed)
    // Applied to the running process, not just persisted: an operator who turns
    // export on should see data arrive without restarting the host.
    if (parsed.otel) await configureOtel(snapshot.config.otel)
    // Broadcast so a second window or a second device converges rather than
    // holding a settings panel that disagrees with the one just edited.
    deps.onHostConfigChanged(snapshot)
    return snapshot
  })

  // Predates host config and is kept because clients on older builds still call
  // it. Analytics consent now lives in host config, so it writes there.
  server.register('setAnalyticsConsent', (args) => {
    const [enabled] = args
    deps.onHostConfigChanged(setHostConfig({ analyticsEnabled: enabled === true }))
  })

  const textGenerationSnapshot = async (): Promise<TextGenerationSettingsSnapshot> => {
    const agents = await Promise.all(
      deps.controlPlane
        .getBackendIds()
        .map((id) => deps.controlPlane.getMetadataFor(id))
        .filter((metadata) => metadata !== undefined)
        .map(enrichAgentMetadata),
    )
    const { config } = getHostConfig()
    return {
      textGenerationModel: config.textGenerationModel,
      backupTextGenerationModel: config.backupTextGenerationModel,
      sourceControlWriterModel: config.sourceControlWriterModel,
      sourceControlWriting: config.sourceControlWriting,
      effectiveTextGenerationModel: resolveTextGenerationModel(),
      effectiveSourceControlWriterModel: resolveSourceControlWriterModel(),
      agents,
    }
  }

  // The two reads survive the move to `configUpdate` because neither returns
  // stored config: they resolve which model is actually available on this host
  // and which signals are actually exporting. A config read cannot say that.
  server.register('textGenerationSettingsGet', () => textGenerationSnapshot())

  server.register('otelSettingsGet', () => ({
    settings: getHostConfig().config.otel,
    managedByEnvironment: otelManagedByEnvironment(),
    active: otelActiveSignals(),
  } satisfies OtelSettingsSnapshot))
}
