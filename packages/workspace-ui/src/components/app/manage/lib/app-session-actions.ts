import { serverConnections } from '@solus/client-core/server-connections'
import type { AppSummary } from '@solus/contracts/apps'
import { NEW_CHAT_DIRECTORY } from '@solus/contracts/chat'
import type { AgentId, HeadlessPromptRequest, HeadlessSessionRequest, ModelConfig } from '@solus/contracts/types'
import { appsStore } from '../../../../contexts/apps/apps.store.svelte'

/**
 * What the Sessions section's card sends (docs/plans/apps.md §9.2): a reply
 * into a linked session, and the first prompt of a new session for the app.
 * Both go through the host's headless session RPCs — the ones a card uses to
 * drive a session that no tab shows — so the session runs as any other, and a
 * tab that shows it sees the turn.
 */

/** The agent and model a new session runs with: the person's defaults, as a new tab's. */
export interface AppSessionRun {
  provider: AgentId
  modelConfig: ModelConfig
}

/** The person's default agent, as a new tab takes it: a name this client does not know is Claude Code. */
export function appSessionRun(activeAgent: string, defaultModelConfigFor: (provider: AgentId) => ModelConfig): AppSessionRun {
  const provider: AgentId = activeAgent === 'codex' || activeAgent === 'opencode' || activeAgent === 'replay' ? activeAgent : 'claude-code'
  return { provider, modelConfig: defaultModelConfigFor(provider) }
}

/** A reply into a session. A session that is working takes it after its turn ends. */
export function appSessionReply(sessionId: string, prompt: string, promptId: string): HeadlessPromptRequest {
  return { sessionId, prompt: prompt.trim(), delivery: 'queue', promptId }
}

/** A new session in the app's project: the folder it was saved from, or a new chat folder when the host does not know one. */
export function appSessionStart(app: Pick<AppSummary, 'name' | 'project'>, prompt: string, run: AppSessionRun): HeadlessSessionRequest {
  return {
    prompt: prompt.trim(),
    provider: run.provider,
    modelId: run.modelConfig.modelId,
    reasoningEffort: run.modelConfig.reasoningEffort,
    contextWindow: run.modelConfig.contextWindow,
    cwd: app.project ?? NEW_CHAT_DIRECTORY,
  }
}

/** Sends the reply. Answers how the session took it. */
export async function replyToAppSession(serverId: string, sessionId: string, prompt: string): Promise<'started' | 'steered' | 'queued'> {
  const result = await serverConnections.apiFor(serverId).promptHeadlessSession(appSessionReply(sessionId, prompt, crypto.randomUUID()))
  return result.disposition
}

/** Starts a session for the app and links it to the app. Answers the new session's id. */
export async function startAppSession(serverId: string, app: AppSummary, prompt: string, run: AppSessionRun): Promise<string> {
  const { sessionId } = await serverConnections.apiFor(serverId).createHeadlessSession(appSessionStart(app, prompt, run))
  await appsStore.linkSession(serverId, app.id, sessionId)
  return sessionId
}
