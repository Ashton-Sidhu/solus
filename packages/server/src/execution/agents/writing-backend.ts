import { AGENT_BIN, type TextGenerationModelSelection } from '@solus/contracts/types'
import { DEFAULT_TEXT_GENERATION_MODELS } from '@solus/contracts/settings'
import { findOnPath, getCliPath } from '../../cli-env'
import { createLogger } from '../../logger'
import { hostPolicies } from '../../host/policy/host-policy-store'
import { providerLoginConnected } from '../seats/seat-login'
import { SeatRequiredError, type SeatResolver, type TurnSeat } from '../seats/seat-manager'
import { codexWritingModel } from './codex/listed-models'

const log = createLogger('main', 'writing-backend')

/** The backends that have a cheap writing model. */
export type WritingProvider = keyof typeof DEFAULT_TEXT_GENERATION_MODELS

export interface WritingBackend {
  provider: WritingProvider
  model: string
  /** Absent for the host login. */
  seat?: TurnSeat
  /** The organization the text is for; its policies govern the run (plans/030 §6.5). */
  organizationId: string
}

/**
 * The backend a background writing run (a name, a commit message, a pull
 * request) uses for one caller: the host's chosen model, else the other
 * backend's writing model. A backend counts only when it is installed and the
 * caller can run it and the policies of `organizationId` allow it. A cloud host
 * installs both CLIs, but a member may be signed in to only one. A signed-out
 * host login gives way to the next backend, and is used only when no other
 * counts: the CLI can hold a credential the login check does not see. Null when
 * no backend counts.
 */
export async function writingBackendFor(
  selection: TextGenerationModelSelection,
  seatFor: SeatResolver | undefined,
  organizationId: string,
): Promise<WritingBackend | null> {
  const work = hostPolicies().forWork(organizationId)
  const providers = Object.keys(DEFAULT_TEXT_GENERATION_MODELS) as WritingProvider[]
  const selected = providers.find((provider) => provider === selection.provider)
  const candidates: { provider: WritingProvider; model: string }[] = [
    ...(selected ? [{ provider: selected, model: selection.model }] : []),
    ...providers
      .filter((provider) => provider !== selected)
      .map((provider) => ({ provider, model: DEFAULT_TEXT_GENERATION_MODELS[provider] })),
  ]
  let signedOut: WritingBackend | null = null
  for (const { provider, model } of candidates) {
    if (work.modelDenial(provider, model)) continue
    const bin = AGENT_BIN[provider]
    if (!bin || !findOnPath(bin, getCliPath())) continue
    let seat: TurnSeat | null | undefined
    try {
      seat = await seatFor?.(provider)
    } catch (error) {
      if (error instanceof SeatRequiredError) continue
      throw error
    }
    if (seat && seat.seat.kind !== 'host-login') return { provider, model, seat, organizationId }
    // The host's Codex lists the models of the host login, not of a member's.
    const hostModel = provider === 'codex' ? codexWritingModel(model) : model
    const hostBackend: WritingBackend = seat ? { provider, model: hostModel, seat, organizationId } : { provider, model: hostModel, organizationId }
    if (seat?.envToken || await providerLoginConnected(provider, null)) return hostBackend
    signedOut ??= hostBackend
  }
  if (signedOut) return signedOut
  log.warn('writing_backend_unavailable', { provider: selection.provider })
  return null
}
