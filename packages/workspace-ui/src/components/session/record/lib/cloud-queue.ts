import type { CloudQueuedPrompt } from '@solus/contracts/types'

/**
 * A cloud session's durable prompt queue as the record page shows it
 * (docs/plans/cloud-service-model.md, P2). The host owns every row; the client
 * draws one bubble ahead of the host's answer so a send lands at once, and
 * folds the answer back over it. Pure, so the rules test without Svelte.
 */

/** A bubble drawn before the host answered. Its id is the client's own. */
const LOCAL_QUEUE_ID_PREFIX = 'local:'

export function isLocalQueuedPrompt(prompt: Pick<CloudQueuedPrompt, 'queueId'>): boolean {
  return prompt.queueId.startsWith(LOCAL_QUEUE_ID_PREFIX)
}

/** What the bubble's caption says about where the prompt is. */
export function queuedPromptStateLabel(prompt: Pick<CloudQueuedPrompt, 'state' | 'error'>): string {
  switch (prompt.state) {
    case 'waiting': return 'Waiting for the runner'
    case 'claimed': return 'Picked up by the runner'
    case 'dispatched': return 'Sent to the agent'
    case 'failed': return prompt.error ? `Failed: ${prompt.error}` : 'Failed'
    case 'cancelled': return 'Cancelled'
  }
}

export interface OptimisticQueuedPromptInput {
  sessionId: string
  text: string
  clientPromptId: string
  author: CloudQueuedPrompt['author']
  now: number
}

export function optimisticQueuedPrompt(input: OptimisticQueuedPromptInput): CloudQueuedPrompt {
  return {
    queueId: `${LOCAL_QUEUE_ID_PREFIX}${input.clientPromptId}`,
    sessionId: input.sessionId,
    text: input.text,
    author: input.author,
    state: 'waiting',
    createdAt: input.now,
    claimedByHostId: null,
    settledAt: null,
    error: null,
  }
}

/** The host's answer takes the local bubble's place. A reload that raced the
 *  answer already lists the row under its real id; then the local bubble goes. */
export function settleQueuedPrompt(queue: readonly CloudQueuedPrompt[], clientPromptId: string, answer: CloudQueuedPrompt): CloudQueuedPrompt[] {
  const localId = `${LOCAL_QUEUE_ID_PREFIX}${clientPromptId}`
  if (queue.some((prompt) => prompt.queueId === answer.queueId)) {
    return queue.filter((prompt) => prompt.queueId !== localId)
  }
  return queue.map((prompt) => prompt.queueId === localId ? answer : prompt)
}

/** The host's list is the truth; local bubbles still waiting for their answer stay at the end. */
export function reconcileQueuedPrompts(queue: readonly CloudQueuedPrompt[], loaded: readonly CloudQueuedPrompt[]): CloudQueuedPrompt[] {
  return [...loaded, ...queue.filter(isLocalQueuedPrompt)]
}

export function withoutQueuedPrompt(queue: readonly CloudQueuedPrompt[], queueId: string): CloudQueuedPrompt[] {
  return queue.filter((prompt) => prompt.queueId !== queueId)
}

export function withQueuedPromptState(queue: readonly CloudQueuedPrompt[], queueId: string, state: CloudQueuedPrompt['state']): CloudQueuedPrompt[] {
  return queue.map((prompt) => prompt.queueId === queueId ? { ...prompt, state } : prompt)
}

/** Only a prompt the runner has not claimed can be withdrawn, and only by its author. */
export function canCancelQueuedPrompt(prompt: CloudQueuedPrompt, userId: string | null): boolean {
  return prompt.state === 'waiting' && !isLocalQueuedPrompt(prompt) && userId !== null && prompt.author.userId === userId
}
