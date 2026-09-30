import type { AgentId } from '@solus/contracts/types'
import type { Attribution } from '@solus/contracts/user'
import { ANY_ORGANIZATION } from '../../../admission/principal'
import { getSessionRecord } from '../../../data/sessions/session-records'
import { agentAttribution } from '../../../data/stored-attribution'
import { hostUser, isHostUserKey } from '../../../host/host-user'

/**
 * The agent behind a tool call, as the doer of what the tool writes
 * (plans/012-user-actor-and-activity.md §2): its session and provider, and the
 * person it worked for when Solus can name them. A tool call has no actor yet
 * (P7 decides whose turn an agent's is), so `for` is the host's user when the
 * host's user owns the session, and absent otherwise.
 */
export async function toolAgentAttribution(ctx: { sessionId?: string; agentProvider?: AgentId } | undefined, title?: string): Promise<Attribution> {
  const agent = agentAttribution(ctx?.sessionId, ctx?.agentProvider)
  if (agent.kind !== 'agent') return agent
  if (title) agent.title = title
  const record = ctx?.sessionId ? await getSessionRecord(ANY_ORGANIZATION, ctx.sessionId) : null
  // A record nobody claimed belongs to the host's user (U4).
  const user = record && (record.ownerUserId === null || isHostUserKey(record.ownerUserId)) ? hostUser() : null
  if (user) agent.for = user
  return agent
}
