import { addMachineOutcomeAnswers, PAIR_APPROVAL_TTL_MS, type AddMachineAsk, type AddMachineWay } from '@solus/contracts/add-machine'
import type { HostListing } from '@solus/contracts/host-list'
import type { HostPairRequest } from '@solus/contracts/host-pairing'
import type { SshAddProgress, SshAddRequest, SshAddResult } from '@solus/contracts/remote-machines'
import { otherMachineWay, type AddMachineCandidate } from '@solus/client-core/add-machine-candidates'
import { addMachineStatusCard } from '@solus/client-core/add-machine-progress'
import type { StatusCardState } from '@solus/contracts/types'
import {
  attemptField,
  candidateAttempt,
  nextIndex,
  OTHER_MACHINE_KEY,
  otherMachineAttempt,
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
  /** The agent's ask: an SSH target or a key in it fills the card. */
  ask?: () => AddMachineAsk
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
  /** The card leaves once it is answered, so the person hears of the new machine elsewhere. The id is the new host's. */
  noticeAdded: (label: string, hostId: string) => void
}

export type AddMachineCardPhase = 'choose' | 'sending' | 'added' | 'closed'

type Added = { installationId: string; label: string; attempt: CardAttempt }

/** SSH refuses the key because other users can read it. Fix permissions sends the same add with the fix. */
export interface KeyPermissionsIssue {
  identityFile: string
  message: string
}

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
  /** The text of the "Other machine…" row: an SSH target or an address (`otherMachineWay`). */
  otherMachine = $state('')
  /** A private key on the session host, as with `ssh -i`. Sent only while its field shows. */
  identityFile = $state('')
  /** On a `~/.ssh/config` row, the person chose another key than the config's. */
  isKeyFieldOpen = $state(false)
  /** The key that SSH refuses until its permissions are fixed. */
  keyPermissions = $state<KeyPermissionsIssue | null>(null)
  /** The next SSH add asks the host to fix the key first: the person chose Fix permissions. */
  #isFixingKey = false
  code = $state('')
  password = $state('')
  /** The person chose to type a code for the selected machine. */
  useCode = $state(false)
  /** The person chose to ask the target's owner to approve: the one way that needs somebody there. */
  useApproval = $state(false)
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

  constructor(private readonly deps: AddMachineCardDeps) {
    // The agent's SSH target and key fill the card once; after that the fields are the person's.
    const ask = deps.ask?.()
    this.otherMachine = ask?.sshTarget?.trim() ?? ''
    this.identityFile = ask?.identityFile?.trim() ?? ''
    this.isKeyFieldOpen = !!this.identityFile
  }

  get rowKeys(): string[] {
    return [...this.deps.candidates().map((candidate) => candidate.key), OTHER_MACHINE_KEY]
  }

  /**
   * The person's pick. Until they pick: the agent's SSH target (its config row,
   * else "Other machine…"), or the best match.
   */
  get selectedKey(): string {
    const keys = this.rowKeys
    if (this.#pickedKey && keys.includes(this.#pickedKey)) return this.#pickedKey
    const askedTarget = this.deps.ask?.().sshTarget?.trim()
    if (askedTarget) {
      return this.deps.candidates().find((candidate) => candidate.way === 'ssh' && candidate.sshTarget === askedTarget)?.key ?? OTHER_MACHINE_KEY
    }
    return keys[0]
  }

  get isOtherRow(): boolean {
    return this.selectedKey === OTHER_MACHINE_KEY
  }

  /** "Other machine…" holds an SSH target, or nothing yet. */
  get isSshTargetRow(): boolean {
    return this.isOtherRow && otherMachineWay(this.otherMachine) === 'ssh'
  }

  /** "Other machine…" holds a Solus address or a pair link. */
  get isAddressRow(): boolean {
    return this.isOtherRow && otherMachineWay(this.otherMachine) === 'address'
  }

  /** The SSH target of the selected row, or empty when the row is not an SSH one. */
  get selectedSshTarget(): string {
    if (this.isSshTargetRow) return this.otherMachine.trim()
    return this.selected?.way === 'ssh' ? this.selected.sshTarget ?? '' : ''
  }

  /** The identity file field shows on an SSH row once the person asks for another key. */
  get showsKeyField(): boolean {
    return (this.isSshTargetRow || this.selected?.way === 'ssh') && this.isKeyFieldOpen
  }

  /** The name of the selected machine, as the card says it. */
  get machineName(): string {
    if (this.isSshTargetRow) return this.otherMachine.trim() || 'the other machine'
    return targetName(this.selected, this.otherMachine)
  }

  /** The selected candidate; null on "Other machine…". */
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

  /** The code field shows for a machine that may need a code; left empty, the add tries a join with no code first. */
  get showsCodeField(): boolean {
    if (this.useApproval) return false
    const selected = this.selected
    return this.useCode || this.isAddressRow || (!!selected && selected.way === 'code' && !selected.minted)
  }

  /** The machine has an address the session host can ask to approve. */
  get canAskApproval(): boolean {
    return !this.useApproval && (this.isAddressRow || (!!this.selected?.url && !this.selected.minted))
  }

  select(key: string): void {
    if (this.phase !== 'choose' || key === this.selectedKey) return
    this.#pickedKey = key
    this.useCode = false
    this.useApproval = false
    this.isPasswordAsked = false
    this.keyPermissions = null
    this.failure = null
    this.code = ''
    this.password = ''
  }

  move(key: 'ArrowUp' | 'ArrowDown'): void {
    const keys = this.rowKeys
    this.select(keys[nextIndex(keys.indexOf(this.selectedKey), keys.length, key)])
  }

  /** A config row uses another key than its config's. */
  openKeyField(): void {
    this.isKeyFieldOpen = true
  }

  /** Back to the config's key: no key is sent. */
  closeKeyField(): void {
    this.isKeyFieldOpen = false
    this.identityFile = ''
    if (this.failure?.field === 'identity') this.failure = null
  }

  enterCode(): void {
    this.useCode = true
    this.useApproval = false
    this.failure = null
  }

  /** The person asks the target's owner to approve, instead of a code. */
  askApproval(): void {
    this.useApproval = true
    this.useCode = false
    this.failure = null
  }

  async add(): Promise<void> {
    if (this.phase !== 'choose') return
    const selected = this.selected
    const identityFile = this.showsKeyField ? this.identityFile : ''
    const build = selected ? candidateAttempt(selected, this.code, this.useCode, identityFile, this.useApproval)
      : otherMachineAttempt(this.otherMachine, this.code, this.useCode, identityFile, this.useApproval)
    this.keyPermissions = null
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
      name: this.machineName,
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
      this.deps.noticeAdded(added.label, added.installationId)
      await this.deps.answer(addMachineOutcomeAnswers({ status: 'added', installationId: added.installationId, way: outcomeWay(added.attempt) }))
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const field = attemptField(build.attempt, this.isAddressRow, hasPassword, message)
      // The host checks the key before SSH runs: nothing was sent, so the message is at the key's field.
      if (field === 'identity') this.#sent = null
      this.failure = { field, message }
    } finally {
      // No typed secret is kept after a send, also after a failed send.
      this.code = ''
      this.password = ''
      this.approval = null
      if (this.phase === 'sending') this.phase = 'choose'
    }
  }

  /** The same add again, with the host's fix of the key first: one request, nothing sent until the person chose it. */
  async fixKeyPermissions(): Promise<void> {
    if (!this.keyPermissions || this.phase !== 'choose') return
    this.keyPermissions = null
    this.#isFixingKey = true
    await this.add()
    this.#isFixingKey = false
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
          // This client may not make a code there after all: a join with no code, then the code field.
          return this.#joinWithoutCode({ way: 'network', url: attempt.url })
        }
        const listing = await this.deps.pair({ url: attempt.url, code })
        return { installationId: listing.installationId, label: listing.label, attempt }
      }
      case 'network':
        return this.#joinWithoutCode(attempt)
      default:
        return this.#pair(attempt)
    }
  }

  /** A refused join with no code shows the code field, where its message says a code is needed. */
  async #joinWithoutCode(attempt: Extract<CardAttempt, { way: 'network' }>): Promise<Added> {
    try {
      return await this.#pair(attempt)
    } catch (error) {
      this.useCode = true
      throw error
    }
  }

  async #pair(attempt: Extract<CardAttempt, { way: 'approve' | 'code' | 'network' }>): Promise<Added> {
    const checkCode = attempt.way === 'approve' ? newCheckCode() : ''
    // A code this client could not make falls back to a join with no code.
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
      if (attempt.identityFile) request.identityFile = attempt.identityFile
      if (attempt.identityFile && this.#isFixingKey) request.fixIdentityFilePermissions = true
      this.#isFixingKey = false
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
      if (outcome.kind === 'key-permissions') {
        // Nothing was sent, so no setup card shows: the card offers Fix permissions.
        this.#sent = null
        this.keyPermissions = { identityFile: outcome.identityFile, message: outcome.message }
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
