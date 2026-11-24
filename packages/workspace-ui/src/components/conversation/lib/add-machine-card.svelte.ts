import { addMachineOutcomeAnswers, PAIR_APPROVAL_TTL_MS, type AddMachineWay } from '@solus/contracts/add-machine'
import type { HostListing } from '@solus/contracts/host-list'
import type { HostPairRequest } from '@solus/contracts/host-pairing'
import type { SshAddProgress, SshAddRequest, SshAddResult } from '@solus/contracts/remote-machines'
import type { AddMachineCandidate } from '@solus/client-core/add-machine-candidates'
import { addMachineStatusCard } from '@solus/client-core/add-machine-progress'
import type { StatusCardState } from '@solus/contracts/types'
import {
  addressAttempt,
  ANOTHER_ADDRESS_KEY,
  attemptField,
  candidateAttempt,
  nextIndex,
  outcomeWay,
  pairRequest,
  sshCardOutcome,
  targetName,
  type CardAttempt,
  type CardField,
} from './add-machine-card'
import { newCheckCode } from '../../../lib/check-code'

/** What the card needs from the hosts. The SSH add and the pairing run on the session host. */
export interface AddMachineCardDeps {
  candidates: () => readonly AddMachineCandidate[]
  addOverSsh: (request: SshAddRequest) => Promise<SshAddResult>
  pair: (request: HostPairRequest) => Promise<HostListing>
  watchSshProgress: (requestId: string, onProgress: (progress: SshAddProgress) => void) => () => void
  /** A pairing code made on a host this client reaches as its owner. */
  mint: (serverId: string) => Promise<string>
  /** Answers the card with `respondQuestion`. False when the card is no longer open. */
  answer: (answers: Record<string, string>) => Promise<boolean>
  /** Why a password must not go to the session host now; empty when it can. */
  passwordIssue: () => string
  /** After an SSH add: this client keeps the host when it can dial it. */
  afterSshAdd: (result: SshAddResult) => Promise<void>
  deviceLabel: () => string
  /** The card leaves once it is answered, so the person hears of the new machine elsewhere. */
  noticeAdded: (label: string) => void
}

export type AddMachineCardPhase = 'choose' | 'sending' | 'added' | 'closed'

type Added = { installationId: string; label: string; attempt: CardAttempt }

/** The add that runs, or the last one sent: what its setup card shows. */
interface SentAttempt {
  id: string
  way: AddMachineWay
  name: string
  sshTarget?: string
  /** SSH refused the key: the card asks for a password. */
  needsPassword: boolean
}

/**
 * One Add machine card (docs/plans/add-machine-card.md). The typed values live
 * only here, are cleared after each send, and go to the session host only in
 * the call of the chosen way. The card answers `respondQuestion` with the
 * outcome only, never with a code or a password.
 */
export class AddMachineCardState {
  address = $state('')
  code = $state('')
  password = $state('')
  /** The person chose to type a code for the selected machine. */
  useCode = $state(false)
  /** SSH refused the key: the password field shows. */
  isPasswordAsked = $state(false)
  phase = $state<AddMachineCardPhase>('choose')
  failure = $state<{ field: CardField; message: string } | null>(null)
  /** An approval request waits on the target's owner. */
  approval = $state<{ checkCode: string; expiresAt: number } | null>(null)
  /** The steps the host reported for the SSH add of the sent attempt. */
  sshSteps = $state<SshAddProgress[]>([])
  addedLabel = $state('')
  #pickedKey = $state<string | null>(null)
  #sent = $state<SentAttempt | null>(null)

  constructor(private readonly deps: AddMachineCardDeps) {}

  get rowKeys(): string[] {
    return [...this.deps.candidates().map((candidate) => candidate.key), ANOTHER_ADDRESS_KEY]
  }

  /** The person's pick, or the best match until they pick. */
  get selectedKey(): string {
    const keys = this.rowKeys
    return this.#pickedKey && keys.includes(this.#pickedKey) ? this.#pickedKey : keys[0]
  }

  /** The selected candidate; null on "Another address…". */
  get selected(): AddMachineCandidate | null {
    return this.deps.candidates().find((candidate) => candidate.key === this.selectedKey) ?? null
  }

  /**
   * The sent attempt as a setup card, the card a run's setup draws: its steps
   * while it runs and where it stopped when it failed. Null before a send, and
   * after the person changes the machine or the way.
   */
  get statusCard(): StatusCardState | null {
    const sent = this.#sent
    if (!sent) return null
    const standing = this.phase === 'sending' ? 'running'
      : this.phase === 'added' ? 'done'
      : this.failure ? (sent.needsPassword ? 'needs-auth' : 'failed')
      : null
    if (!standing) return null
    return addMachineStatusCard({
      attemptId: sent.id,
      way: sent.way,
      name: sent.name,
      sshTarget: sent.sshTarget,
      sshSteps: this.sshSteps,
      standing,
      error: this.failure?.message ?? '',
    })
  }

  get showsCodeField(): boolean {
    const selected = this.selected
    return this.useCode || (!!selected && selected.way === 'code' && !selected.minted)
  }

  select(key: string): void {
    if (this.phase !== 'choose' || key === this.selectedKey) return
    this.#pickedKey = key
    this.useCode = false
    this.isPasswordAsked = false
    this.failure = null
    this.code = ''
    this.password = ''
  }

  move(key: 'ArrowUp' | 'ArrowDown'): void {
    const keys = this.rowKeys
    this.select(keys[nextIndex(keys.indexOf(this.selectedKey), keys.length, key)])
  }

  enterCode(): void {
    this.useCode = true
    this.failure = null
  }

  async add(): Promise<void> {
    if (this.phase !== 'choose') return
    const selected = this.selected
    const build = selected ? candidateAttempt(selected, this.code, this.useCode) : addressAttempt(this.address, this.code, this.useCode)
    if ('error' in build) {
      // Nothing was sent, so no setup card shows: the message is at its field.
      this.#sent = null
      this.failure = { field: build.field, message: build.error }
      return
    }
    const hasPassword = build.attempt.way === 'ssh' && !!this.password
    const issue = hasPassword ? this.deps.passwordIssue() : ''
    if (issue) {
      this.#sent = null
      this.password = ''
      this.failure = { field: 'password', message: issue }
      return
    }
    this.#sent = {
      id: crypto.randomUUID(),
      way: outcomeWay(build.attempt),
      name: targetName(selected, this.address),
      sshTarget: build.attempt.way === 'ssh' ? build.attempt.sshTarget : undefined,
      needsPassword: false,
    }
    this.sshSteps = []
    this.phase = 'sending'
    this.failure = null
    try {
      const added = await this.#run(build.attempt)
      if (!added) return
      this.addedLabel = added.label
      this.phase = 'added'
      this.deps.noticeAdded(added.label)
      await this.deps.answer(addMachineOutcomeAnswers({ status: 'added', installationId: added.installationId, way: outcomeWay(added.attempt) }))
    } catch (error) {
      this.failure = { field: attemptField(build.attempt, !selected, hasPassword), message: error instanceof Error ? error.message : String(error) }
    } finally {
      // No typed secret is kept after a send, also after a failed send.
      this.code = ''
      this.password = ''
      this.approval = null
      if (this.phase === 'sending') this.phase = 'choose'
    }
  }

  async decline(): Promise<void> {
    if (this.phase !== 'choose') return
    this.code = ''
    this.password = ''
    this.phase = 'sending'
    const answered = await this.deps.answer(addMachineOutcomeAnswers({ status: 'declined' })).catch(() => false)
    this.phase = answered ? 'closed' : 'choose'
  }

  /** Runs one way. Null when the card must ask the person again (an SSH password). */
  async #run(attempt: CardAttempt): Promise<Added | null> {
    switch (attempt.way) {
      case 'ssh':
        return this.#addOverSsh(attempt)
      case 'minted': {
        let code: string
        try {
          code = await this.deps.mint(attempt.serverId)
        } catch {
          // This client may not make a code there after all: ask the owner to approve instead.
          return this.#pair({ way: 'approve', url: attempt.url })
        }
        const listing = await this.deps.pair({ url: attempt.url, code })
        return { installationId: listing.installationId, label: listing.label, attempt }
      }
      default:
        return this.#pair(attempt)
    }
  }

  async #pair(attempt: Extract<CardAttempt, { way: 'approve' | 'code' }>): Promise<Added> {
    const checkCode = attempt.way === 'approve' ? newCheckCode() : ''
    // A code this client could not make falls back to an approval request.
    if (this.#sent) this.#sent.way = outcomeWay(attempt)
    // The check code shows before the request goes, so the person can compare it on the target.
    if (checkCode) this.approval = { checkCode, expiresAt: Date.now() + PAIR_APPROVAL_TTL_MS }
    const listing = await this.deps.pair(pairRequest(attempt, checkCode))
    return { installationId: listing.installationId, label: listing.label, attempt }
  }

  async #addOverSsh(attempt: Extract<CardAttempt, { way: 'ssh' }>): Promise<Added | null> {
    const requestId = crypto.randomUUID()
    const stop = this.deps.watchSshProgress(requestId, (progress) => { this.sshSteps.push(progress) })
    try {
      const request: SshAddRequest = { sshTarget: attempt.sshTarget, deviceLabel: this.deps.deviceLabel(), requestId }
      if (this.password) request.authSecret = this.password
      this.password = ''
      const result = await this.deps.addOverSsh(request)
      const outcome = sshCardOutcome(result)
      if (outcome.kind === 'ask-password') {
        this.isPasswordAsked = true
        if (this.#sent) this.#sent.needsPassword = true
        this.failure = { field: 'password', message: outcome.message }
        return null
      }
      if (outcome.kind === 'failed') throw new Error(outcome.message)
      await this.deps.afterSshAdd(result)
      return { installationId: outcome.installationId, label: outcome.label, attempt }
    } finally {
      stop()
    }
  }
}
