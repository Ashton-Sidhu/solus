import { z } from 'zod'
import { setTypeSafeApiKey } from '../../typesafe/credentials'
import {
  getHostConfig,
  resolveSourceControlWriterModel,
  resolveTextGenerationModel,
  setHostConfig,
} from '../../host/settings'
import { hostConfigPatchSchema } from '@solus/contracts/host-config'
import { DEFAULT_EXECUTION_PREFERENCES } from '@solus/contracts/settings'
import { configureOtel, otelActiveSignals, otelManagedByEnvironment } from '../../otel'
import type { SolusServer } from '../server'
import type { OtelSettingsSnapshot, TextGenerationSettingsSnapshot } from '@solus/contracts/types'
import type { HostConfigSnapshot } from '@solus/contracts/host-config'
import type { SessionRuntime } from '../../execution/session-runtime'
import { enrichAgentMetadata } from './session-handlers'

export function registerSettingsHandlers(
  server: SolusServer,
  deps: { sessionRuntime: SessionRuntime; onHostConfigChanged: (snapshot: HostConfigSnapshot) => void },
): void {
  server.register('configGet', () => getHostConfig())

  server.register('typeSafeKeySet', ([apiKey]) => {
    const parsed = z.string().trim().min(1).max(4096).nullable().safeParse(apiKey)
    if (!parsed.success) throw new Error('Enter a TypeSafe API key, or remove the saved key.')
    setTypeSafeApiKey(parsed.data)
    const snapshot = getHostConfig()
    deps.onHostConfigChanged(snapshot)
    return snapshot
  })

  server.register('configUpdate', async (args) => {
    // SAFETY: The RPC method contract supplies the config patch in slot zero.
    const [update] = args
    // Strict: a personal or device key has no place on a host (plans/018), so a
    // patch that carries one is refused whole rather than partly applied.
    const parsed = hostConfigPatchSchema.safeParse(update ?? {})
    if (!parsed.success) throw new Error(`Host config refused: ${z.prettifyError(parsed.error)}`)
    const patch = parsed.data
    const snapshot = Object.keys(patch).length ? setHostConfig(patch) : getHostConfig()
    // Applied to the running process, not just persisted: an operator who turns
    // export on should see data arrive without restarting the host.
    if (patch.otel) await configureOtel(snapshot.config.otel)
    // Broadcast so a second window or a second device converges rather than
    // holding a settings panel that disagrees with the one just edited.
    deps.onHostConfigChanged(snapshot)
    return snapshot
  })

  const textGenerationSnapshot = async (): Promise<TextGenerationSettingsSnapshot> => {
    const agents = await Promise.all(
      deps.sessionRuntime
        .getBackendIds()
        .map((id) => deps.sessionRuntime.getMetadataFor(id))
        .filter((metadata) => metadata !== undefined)
        .map(enrichAgentMetadata),
    )
    // The host holds no person's writing models (plans/018): this reports the
    // built-in values and what a requester with no preferences gets on this host.
    return {
      textGenerationModel: DEFAULT_EXECUTION_PREFERENCES.textGenerationModel,
      sourceControlWriterModel: DEFAULT_EXECUTION_PREFERENCES.sourceControlWriterModel,
      sourceControlWriting: DEFAULT_EXECUTION_PREFERENCES.sourceControlWriting,
      effectiveTextGenerationModel: resolveTextGenerationModel(undefined),
      effectiveSourceControlWriterModel: resolveSourceControlWriterModel(undefined),
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
