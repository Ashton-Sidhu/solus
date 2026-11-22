import {
  integrationPromptCommand,
  type IntegrationPrompt,
  type IntegrationPromptArgument,
  type IntegrationPromptGetRequest,
  type IntegrationPromptList,
  type IntegrationPromptSignIn,
  type IntegrationPromptText,
} from '@solus/contracts/integrations/prompts'
import type { Integration } from '@solus/contracts/integration-types'
import { ownerKeyOf, type Actor } from '../admission/actor'
import { createLogger } from '../logger'
import type { IntegrationGateway, UpstreamPrompt } from './gateway'
import { integrationsForRun } from './integration-tools'
import { promptContentOf } from './prompt-content'
import { ConnectionRequiredError, errorText } from './upstream-session'

const log = createLogger('integrations', 'integration-prompts.ts')

/**
 * MCP prompts as slash commands (docs/plans/mcp-first-class.md §10): the list
 * a client shows in its slash menu, and the expansion of one prompt into the
 * person's message. The agent never lists or calls a prompt.
 */

/** How long a list waits for one server's prompts before it answers without them, as a run waits for tools. */
export const PROMPT_LIST_TIMEOUT_MS = 10_000

/** Commands already reported as taken, so a collision is logged once. */
const reportedCollisions = new Set<string>()

type Listed = { kind: 'prompts'; prompts: UpstreamPrompt[] } | { kind: 'sign-in' } | { kind: 'none' }

async function listedFor(gateway: IntegrationGateway, integration: Integration, personKey: string | null): Promise<Listed> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), PROMPT_LIST_TIMEOUT_MS) })
  try {
    const prompts = await Promise.race([gateway.promptsFor(integration.id, personKey), late])
    if (prompts) return { kind: 'prompts', prompts }
    log.warn('integration_prompts_late', { integrationId: integration.id, personKey })
    return { kind: 'none' }
  } catch (error) {
    if (error instanceof ConnectionRequiredError) return { kind: 'sign-in' }
    log.warn('integration_prompts_unavailable', { integrationId: integration.id, personKey, error: errorText(error) })
    return { kind: 'none' }
  } finally {
    clearTimeout(timer)
  }
}

/** What a missing connection asks for: values (a command's variables, or a server's headers), or a sign-in. */
function needsOf(integration: Integration): IntegrationPromptSignIn['needs'] {
  return integration.auth.kind === 'env' || integration.auth.kind === 'headers' ? 'environment' : 'sign-in'
}

/**
 * The caller's MCP prompts for one project: the integrations that would join a
 * run there (`joinsRun`), each listed with the caller's connection. A server
 * that does not answer in time is left out; a server the caller is not
 * connected to is named in `signIn`. Two prompts with one command: the first
 * wins.
 */
export async function integrationPromptList(gateway: IntegrationGateway, actor: Actor, projectPath?: string): Promise<IntegrationPromptList> {
  const personKey = ownerKeyOf(actor)
  const integrations = integrationsForRun(gateway, actor, projectPath)
  const listed = await Promise.all(integrations.map((integration) => listedFor(gateway, integration, personKey)))
  const prompts: IntegrationPrompt[] = []
  const signIn: IntegrationPromptSignIn[] = []
  const commands = new Set<string>()
  integrations.forEach((integration, index) => {
    const entry = listed[index]
    if (entry.kind === 'sign-in') signIn.push({ integrationId: integration.id, integrationName: integration.name, slug: integration.slug, needs: needsOf(integration) })
    if (entry.kind !== 'prompts') return
    for (const upstream of entry.prompts) {
      const command = integrationPromptCommand(integration.slug, upstream.name)
      if (commands.has(command)) {
        if (!reportedCollisions.has(command)) {
          reportedCollisions.add(command)
          log.warn('integration_prompt_command_taken', { integrationId: integration.id, prompt: upstream.name, command })
        }
        continue
      }
      commands.add(command)
      const prompt: IntegrationPrompt = {
        integrationId: integration.id,
        integrationName: integration.name,
        command,
        name: upstream.name,
        arguments: (upstream.arguments ?? []).map((argument) => {
          const entry: IntegrationPromptArgument = { name: argument.name, required: argument.required === true }
          if (argument.description) entry.description = argument.description
          return entry
        }),
      }
      if (upstream.title) prompt.title = upstream.title
      if (upstream.description) prompt.description = upstream.description
      prompts.push(prompt)
    }
  })
  return { prompts, signIn }
}

/**
 * Expands one MCP prompt as the caller. A required argument that is missing
 * is refused before any request. A missing connection is an answer, not an
 * error: the conversation's connect card shows, and the client offers the
 * sign-in. The prompt never runs a tool: `prompts/get` only returns messages.
 */
export async function integrationPromptText(
  gateway: IntegrationGateway,
  actor: Actor,
  integration: Integration,
  request: IntegrationPromptGetRequest,
  options: { attachmentsDir?: string; assetsDir?: string } = {},
): Promise<IntegrationPromptText> {
  const connectionRequired = (): IntegrationPromptText => {
    if (request.sessionId) gateway.askToConnect(integration, request.sessionId)
    return { kind: 'connection-required', integrationId: integration.id, integrationName: integration.name, needs: needsOf(integration) }
  }
  const values = new Map(request.arguments.map((argument) => [argument.name, argument.value]))
  let listed: UpstreamPrompt | undefined
  try {
    listed = (await gateway.promptsFor(integration.id, ownerKeyOf(actor))).find((prompt) => prompt.name === request.name)
  } catch (error) {
    if (error instanceof ConnectionRequiredError) return connectionRequired()
    throw failed(errorText(error))
  }
  const missing = (listed?.arguments ?? []).filter((argument) => argument.required && !values.get(argument.name)?.trim()).map((argument) => argument.name)
  if (missing.length) throw new Error(`${integrationPromptCommand(integration.slug, request.name)} needs ${missing.join(', ')}.`)
  try {
    const result = await gateway.getPrompt(integration.id, request.name, Object.fromEntries(values), actor.principal)
    const content = await promptContentOf(result, { prompt: request.name, bucketId: request.sessionId ?? request.draftId ?? null, ...options })
    log.info('integration_prompt_expanded', { integrationId: integration.id, prompt: request.name, characters: content.text.length, attachments: content.attachments.length, sessionId: request.sessionId })
    return { kind: 'text', ...content }
  } catch (error) {
    if (error instanceof ConnectionRequiredError) return connectionRequired()
    throw failed(errorText(error))
  }

  function failed(reason: string): Error {
    log.warn('integration_prompt_failed', { integrationId: integration.id, prompt: request.name, error: reason })
    return new Error(`${integration.name} could not give the prompt ${request.name}: ${reason}`)
  }
}
