import type { AddMachineAsk, HostProvidersAsk } from '@solus/contracts/add-machine'
import type { CloudMachineAsk } from '@solus/contracts/cloud-machine-card'
import type { PermissionOption, QuestionItem, QuestionRequest, RequestExpiry } from '@solus/contracts/types'

/** The requests a conversation holds open for the person, as the native client shows them. */

export interface PendingPermission {
  questionId: string
  toolName: string
  description: string | null
  options: PermissionOption[]
  /** A link guest sent the turn, so it runs in Ask mode whatever the session's mode is. */
  guestTurn?: true
  /** A denial can carry the user's text to the agent that asked (Claude only). */
  supportsFeedback?: true
  /** Set when the request can no longer be answered. */
  expired?: RequestExpiry
}

export interface PendingQuestion {
  questionId: string
  questions: QuestionItem[]
  responseMode?: 'message'
  /** `secret`: a `request_secret` card, answered with `secretRequestAnswer`, never `respondQuestion`.
   *  `host-link`: the Add machine card of `add_host` (docs/plans/add-machine-card.md).
   *  `cloud-machine`: the machine card of a cloud machine tool (plans/035-cloud-machine-tools.md §6).
   *  `host-providers`: the Sign in card of `add_host` (docs/host-provider-sign-in.md). */
  kind?: QuestionRequest['kind']
  /** `host-link` only: what the agent asks to add. */
  hostLink?: AddMachineAsk
  /** `host-providers` only: the new host and the provider that the work needs there. */
  hostProviders?: HostProvidersAsk
  /** `cloud-machine` only: the choices the card collects. */
  cloudMachine?: CloudMachineAsk
  /** Set when the question can no longer be answered. */
  expired?: RequestExpiry
}

/** Host requests with their own controls in the transcript. */
export function hasOwnCard(question: Pick<PendingQuestion, 'kind'> | undefined): boolean {
  return question?.kind === 'secret' || question?.kind === 'host-link' || question?.kind === 'cloud-machine' || question?.kind === 'host-providers'
}

export interface QueuedPrompt {
  queueId: string
  text: string
  clientPromptId?: string
}
