import { z } from 'zod'
import type { HostOperatingSystem, SetupAgent } from './types'

/**
 * Add a machine from the conversation (docs/plans/add-machine-card.md). The
 * `add_host` tool shows an Add machine card (question kind `host-link`). The
 * client does the work with the host's existing RPCs (`hostsAddOverSsh`,
 * `hostsPair` with a code or a check code), then answers the card with
 * `respondQuestion` and the outcome. A code or an SSH password goes only in
 * those RPC calls, never in the transcript, a draft, or the card's answer.
 */

/** What the agent asks for, as the card shows it. */
export interface AddMachineAsk {
  /** The person's words for the machine, such as "my windows machine". */
  hint?: string
  /** The address the person gave, as an http(s) origin. */
  url?: string
  /** An SSH target the person gave, such as `ubuntu@3.91.20.4` or a config alias. The card fills it in. */
  sshTarget?: string
  /** A private key on the host that runs SSH, as with `ssh -i`. A path only, never the key. */
  identityFile?: string
  /** Why the agent asks, in one sentence. */
  reason: string
}

/** How a machine is added. A code the client makes for a host it reaches is the `code` way. */
export type AddMachineWay = 'ssh' | 'approve' | 'code'

/** What the card tells the tool. `added` names a host the session host now holds. */
export type AddMachineOutcome =
  | { status: 'added'; installationId: string; way: AddMachineWay }
  | { status: 'declined' }

/** The card's `respondQuestion` answers for an outcome. */
export function addMachineOutcomeAnswers(outcome: AddMachineOutcome): Record<string, string> {
  return outcome.status === 'added'
    ? { status: 'added', installationId: outcome.installationId, way: outcome.way }
    : { status: 'declined' }
}

/** The outcome in a card's answers, or null when they are not one. */
export function readAddMachineOutcome(answers: Record<string, string>): AddMachineOutcome | null {
  if (answers.status === 'declined') return { status: 'declined' }
  const way = answers.way
  if (answers.status !== 'added' || !answers.installationId || (way !== 'ssh' && way !== 'approve' && way !== 'code')) return null
  return { status: 'added', installationId: answers.installationId, way }
}

/**
 * The Sign in card of `add_host` (question kind `host-providers`,
 * docs/host-provider-sign-in.md): the machine is added, but the provider that
 * the work needs is not signed in there. The session host closes the card when
 * the new host reports the provider signed in. A client answers it only to
 * skip, with `hostProvidersSkipAnswers`.
 */
export interface HostProvidersAsk {
  /** The new host, by the id that clients know it by. */
  installationId: string
  hostName: string
  /** The provider that the work needs on the new host. */
  provider: SetupAgent
  /** Why the agent needs it, in one sentence. */
  reason: string
}

/** The one answer a client gives the Sign in card: the person does not sign in now. */
export function hostProvidersSkipAnswers() {
  return { status: 'skipped' as const }
}

/** One open approval request, as the owners of the target host see it. */
export interface PairApprovalRequest {
  requestId: string
  checkCode: string
  /** What the requesting device calls itself. */
  deviceLabel: string
  /** The network address the request came from. */
  fromAddress: string
  requestedAt: number
  expiresAt: number
}

export type PairApprovalDecision = 'approve' | 'deny'

/** `POST /pair/request` body. The requester makes the check code and shows it at once. */
export const pairApprovalStartRequestSchema = z.object({
  deviceLabel: z.string().trim().min(1).max(64),
  checkCode: z.string().trim().length(9),
  /** The token this device holds and wants replaced; it is revoked on approval. */
  replacesSessionToken: z.string().min(1).max(512).optional(),
}).strict()
export type PairApprovalStartRequest = z.infer<typeof pairApprovalStartRequestSchema>

/** `POST /pair/request` reply. `waitToken` is known only to the requester. */
export interface PairApprovalStart {
  requestId: string
  expiresAt: number
  waitToken: string
}

/** `POST /pair/request/wait` body. */
export const pairApprovalWaitRequestSchema = z.object({
  requestId: z.string().min(1).max(128),
  waitToken: z.string().min(1).max(256),
}).strict()
export type PairApprovalWaitRequest = z.infer<typeof pairApprovalWaitRequestSchema>

/** `POST /pair/request/wait` reply: a long poll answers `pending` after at most 25 s. */
export type PairApprovalWait =
  | { status: 'pending' }
  | { status: 'denied' }
  | { status: 'expired' }
  | { status: 'approved'; sessionToken: string; installationId: string; os?: HostOperatingSystem; identityKey?: string }

export const PAIR_APPROVAL_TTL_MS = 5 * 60 * 1000
export const PAIR_APPROVAL_WAIT_MS = 25 * 1000
export const PAIR_APPROVAL_MAX_OPEN = 5

/** No 0/O or 1/I, so a check code reads the same aloud and on a small screen. */
export const CHECK_CODE_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ'

/** Eight characters from the alphabet as `XXXX-XXXX`. `pick(n)` returns an integer in [0, n). */
export function formatCheckCode(pick: (n: number) => number): string {
  let code = ''
  for (let i = 0; i < 8; i++) code += CHECK_CODE_ALPHABET[pick(CHECK_CODE_ALPHABET.length)]
  return `${code.slice(0, 4)}-${code.slice(4)}`
}

/** A check code as a person may type it (any case, with or without the dash), or null. */
export function normalizeCheckCode(value: string): string | null {
  const compact = value.trim().toUpperCase().replace(/[\s-]/g, '')
  if (compact.length !== 8 || [...compact].some((char) => !CHECK_CODE_ALPHABET.includes(char))) return null
  return `${compact.slice(0, 4)}-${compact.slice(4)}`
}
