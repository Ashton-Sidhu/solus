import { z } from 'zod'
import { createLogger } from '../logger'
import type { RunnerDelivery, RunnerGrantInfo } from '../server/uplink/runner-delivery'
import {
  RUNNER_CREDENTIAL_LEASE_PATH,
  RUNNER_CREDENTIAL_LOCK_PATH,
  RUNNER_CREDENTIAL_UNLOCK_PATH,
  RUNNER_CREDENTIAL_WRITEBACK_PATH,
  runnerCredentialErrorSchema,
  runnerCredentialLeaseResponseSchema,
  runnerCredentialLockResponseSchema,
  runnerCredentialWritebackResponseSchema,
  type CredentialMaterial,
  type RunnerCredentialLeaseRequest,
  type RunnerCredentialLeaseResponse,
  type RunnerCredentialLockRequest,
  type RunnerCredentialUnlockRequest,
  type RunnerCredentialWritebackRequest,
  type VaultProvider,
} from '../server/uplink/runner-protocol'

const log = createLogger('main', 'vault-client')

/**
 * The runner's side of the credential vault (docs/plans/cloud-service-model.md
 * §5): four calls under the runner grant. Every answer names why there is none,
 * so the seat manager can tell "the person has no credential" (purge, refuse)
 * from "the service could not be asked" (keep what is materialized).
 */

export type VaultLeaseOutcome =
  | { kind: 'ok'; lease: RunnerCredentialLeaseResponse }
  | { kind: 'no_credential' }
  | { kind: 'unavailable'; reason: string }

export type VaultWriteBackOutcome =
  | { kind: 'ok'; version: number }
  | { kind: 'version_conflict' }
  | { kind: 'unavailable'; reason: string }

/** What the client needs of the delivery; a test hands it a fake. */
export type VaultTransport = Pick<RunnerDelivery, 'call' | 'currentGrant' | 'onGrant'>

const unlockResponseSchema = z.object({})

export class VaultClient {
  constructor(private readonly delivery: VaultTransport) {}

  /** The grant's facts while the runner holds one; null while it does not. */
  currentGrant(): RunnerGrantInfo | null {
    return this.delivery.currentGrant()
  }

  onGrant(listener: (info: RunnerGrantInfo | null) => void): () => void {
    return this.delivery.onGrant(listener)
  }

  async lease(userId: string, provider: VaultProvider): Promise<VaultLeaseOutcome> {
    const hostId = this.currentGrant()?.hostId
    if (!hostId) return { kind: 'unavailable', reason: 'no grant' }
    const body: RunnerCredentialLeaseRequest = { hostId, userId, provider }
    const answered = await this.delivery.call(RUNNER_CREDENTIAL_LEASE_PATH, body, runnerCredentialLeaseResponseSchema)
    if (answered.kind === 'ok') return { kind: 'ok', lease: answered.body }
    if (answered.kind === 'refused' && refusal(answered.error) === 'no_credential') return { kind: 'no_credential' }
    const reason = describe(answered)
    log.warn('vault_lease_unavailable', { userId, provider, reason })
    return { kind: 'unavailable', reason }
  }

  /** Null when the service could not be asked: the caller proceeds without a lock. */
  async lock(userId: string, provider: VaultProvider, ttlMs: number): Promise<{ acquired: boolean; expiresAt: number } | null> {
    const hostId = this.currentGrant()?.hostId
    if (!hostId) return null
    const body: RunnerCredentialLockRequest = { hostId, userId, provider, ttlMs }
    const answered = await this.delivery.call(RUNNER_CREDENTIAL_LOCK_PATH, body, runnerCredentialLockResponseSchema)
    if (answered.kind === 'ok') return answered.body
    log.warn('vault_lock_unavailable', { userId, provider, reason: describe(answered) })
    return null
  }

  async unlock(userId: string, provider: VaultProvider): Promise<void> {
    const hostId = this.currentGrant()?.hostId
    if (!hostId) return
    const body: RunnerCredentialUnlockRequest = { hostId, userId, provider }
    const answered = await this.delivery.call(RUNNER_CREDENTIAL_UNLOCK_PATH, body, unlockResponseSchema)
    // An unreleased lock expires on its own; nothing waits on this answer.
    if (answered.kind !== 'ok') log.warn('vault_unlock_unavailable', { userId, provider, reason: describe(answered) })
  }

  async writeBack(userId: string, provider: VaultProvider, baseVersion: number, material: CredentialMaterial, expiresAt: number | null): Promise<VaultWriteBackOutcome> {
    const hostId = this.currentGrant()?.hostId
    if (!hostId) return { kind: 'unavailable', reason: 'no grant' }
    const body: RunnerCredentialWritebackRequest = { hostId, userId, provider, baseVersion, material, expiresAt }
    const answered = await this.delivery.call(RUNNER_CREDENTIAL_WRITEBACK_PATH, body, runnerCredentialWritebackResponseSchema)
    if (answered.kind === 'ok') return { kind: 'ok', version: answered.body.version }
    if (answered.kind === 'refused' && refusal(answered.error) === 'version_conflict') return { kind: 'version_conflict' }
    const reason = describe(answered)
    log.warn('vault_write_back_unavailable', { userId, provider, reason })
    return { kind: 'unavailable', reason }
  }
}

function refusal(error: string | null): z.infer<typeof runnerCredentialErrorSchema> | null {
  const parsed = runnerCredentialErrorSchema.safeParse(error)
  return parsed.success ? parsed.data : null
}

function describe(answered: Exclude<Awaited<ReturnType<RunnerDelivery['call']>>, { kind: 'ok' }>): string {
  switch (answered.kind) {
    case 'refused':
      return `${answered.status}${answered.error ? ` ${answered.error}` : ''}`
    case 'unreachable':
      return answered.error
    case 'unauthorized':
    case 'no-grant':
      return answered.kind
  }
}
