import { hostPolicies } from '../../host/policy/host-policy-store'
import { resolveProjectRoot } from '../../project-config/project-config'
import { resolveHomePath } from '../../platform/paths'
import { privateProviderInstances } from '../../execution/seats/provider-instances'
import { requirePersonKey } from '../../vault/acting-scope'
import { z } from 'zod'
import { setTypeSafeApiKey, typeSafeKeyStatus } from '../../typesafe/credentials'
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
import { SOLUS_TOOL_AGENT_IDS, type OtelSettingsSnapshot, type TextGenerationSettingsSnapshot } from '@solus/contracts/types'
import type { HostConfigSnapshot } from '@solus/contracts/host-config'
import type { SessionRuntime } from '../../execution/session-runtime'
import { enrichAgentMetadata } from './session-handlers'
import { actingPersonalSettings, patchActingPersonalSettings, pullActingPersonalSettings, setActingSettingsSync } from '../../execution/person-settings'

export function registerSettingsHandlers(
  server: SolusServer,
  deps: { sessionRuntime: SessionRuntime; onHostConfigChanged: (snapshot: HostConfigSnapshot) => void; onProviderInstancesChanged: () => void },
): void {
  server.register('providerInstancesGet', () => privateProviderInstances().snapshot(requirePersonKey()))
  server.register('providerInstancesWrite', ([request]) => {
    const normalized = request.change.kind === 'project' ? { ...request, change: { ...request.change, override: { ...request.change.override, projectRoot: resolveProjectRoot(resolveHomePath(request.change.override.projectRoot)) } } } : request
    const snapshot = privateProviderInstances().write(requirePersonKey(), normalized)
    deps.onProviderInstancesChanged()
    return snapshot
  })

  server.register('configGet', () => getHostConfig())

  // The caller's own settings: this host's copy of them, which their work reads (docs/plans/personal-settings-source.md).
  server.register('personalSettingsGet', () => actingPersonalSettings())
  server.register('personalSettingsPatch', ([change]) => patchActingPersonalSettings(change))
  server.register('personalSettingsChanged', () => pullActingPersonalSettings())
  server.register('personalSettingsSyncSet', ([syncSettings]) => setActingSettingsSync(syncSettings))

  // The caller's own key (docs/plans/access-model.md §2.6), read and changed in their acting scope.
  server.register('typeSafeKeyStatus', () => typeSafeKeyStatus())

  server.register('typeSafeKeySet', async ([apiKey]) => {
    const parsed = z.string().trim().min(1).max(4096).nullable().safeParse(apiKey)
    if (!parsed.success) throw new Error('Enter a TypeSafe API key, or remove the saved key.')
    setTypeSafeApiKey(parsed.data)
    // The status is per person, so the event carries none: each client of this host reads its own again.
    deps.onHostConfigChanged(getHostConfig())
    return typeSafeKeyStatus()
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
    // Publish and revoke any disabled access as soon as the setting is stored.
    deps.onHostConfigChanged(snapshot)
    // A telemetry change also applies to the running process.
    if (patch.otel) await configureOtel(snapshot.config.otel, hostPolicies().hostSetting('otel') !== null)
    return snapshot
  })

  const textGenerationSnapshot = async (): Promise<TextGenerationSettingsSnapshot> => {
    const agents = await Promise.all(
      deps.sessionRuntime
        .getBackendIds()
        // Only an agent that answers through Solus's capture tools can write titles and commit text.
        .filter((id) => SOLUS_TOOL_AGENT_IDS.some((agent) => agent === id))
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
