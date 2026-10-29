import { z } from 'zod'
import type { AgentTool, AgentToolContext } from './agent-tool'
import { createLogger } from '../../../logger'
import { importDocFromUrl, publishWork, pullWorkUpstream } from '../../../data/works/work-sync'
import { loadWork } from '../../../data/works/works'
import { ANY_ORGANIZATION, LOCAL_ORGANIZATION_ID } from '../../../admission/principal'
import { actorFor, ownerKeyOf } from '../../../admission/actor'
import { randomUUID } from 'node:crypto'
import { workspaceToolContext } from '../../../data/workspace/tool-context'
import { docProviderAdapter, docProviderIds, docProviderStatuses } from '../../../docs/registry'
import type { DocProviderAdapter } from '../../../docs/types'
import { resolveHomePath } from '../../../platform/paths'

const log = createLogger('works', 'work-sync-tools.ts')
const PROVIDER_ARG = `Which document provider to use: ${docProviderIds().join(' or ')}.`

async function connectedProvidersHint(): Promise<string> {
  const statuses = await docProviderStatuses()
  const connected = statuses.filter((status) => status.connected).map((status) => status.provider)
  if (connected.length === 0) {
    // The reasons state the situation; the agent needs the route as well, since
    // only the user can complete a sign-in.
    const reasons = statuses.map((status) => status.reason).filter(Boolean).join(' ')
    return `No document provider is connected. ${reasons} The user connects one in Settings → Integrations.`
  }
  // A failure a narrower grant explains — a Drive doc Solus did not create
  // answers 404 — is unreadable without this.
  const limitations = statuses.map((status) => status.limitation).filter(Boolean).join(' ')
  return `Connected document providers: ${connected.join(', ')}.${limitations ? ` ${limitations}` : ''}`
}

/** Refuse publishing to a provider whose connection is not available. */
async function requireAdapter(provider: string): Promise<DocProviderAdapter> {
  const adapter = docProviderAdapter(provider)
  const status = await adapter.status()
  if (!status.connected) {
    throw new Error(status.reason ?? `${provider} is not connected.`)
  }
  return adapter
}

function workSyncTool<Fields extends NonNullable<AgentTool['inputFields']>>(
  name: string,
  description: string,
  inputFields: Fields,
  requiresApproval: boolean,
  run: (args: z.output<z.ZodObject<Fields>>, context: AgentToolContext) => Promise<string>,
): AgentTool {
  const schema = z.object(inputFields)
  return {
    name, description, inputFields, requiresApproval,
    execute: async (args, context) => {
      const parsed = schema.safeParse(args)
      if (!parsed.success) return { ok: false, text: `Invalid arguments for ${name}: ${z.prettifyError(parsed.error)}` }
      try {
        return { ok: true, text: await run(parsed.data, context) }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        log.warn('work_sync_tool_failed', { tool: name, error: message })
        const hint = await connectedProvidersHint().catch(() => null)
        return { ok: false, text: hint ? `${message}\n\n${hint}` : message }
      }
    },
  }
}

export const publishWorkAgentTool = workSyncTool(
  'publish_work',
  'Publish a Solus work upstream as a Confluence page or Google Doc, and keep it linked so later publishes update that same page instead of creating copies. On the first publish, pass `provider` and `scope`; after that neither is needed. If the upstream page changed since Solus last saw it, this reports a conflict instead of overwriting — tell the user and offer pull_work_upstream.',
  {
    work_id: z.string().describe('The id of the work to publish (from find_works).'),
    provider: z.string().optional().describe(`${PROVIDER_ARG} Required only on the first publish.`),
    scope: z.string().optional().describe('Where to create it on the first publish: a Confluence space key, or a Drive folder id.'),
    overwrite: z.boolean().optional().describe('Publish over an upstream change the user has decided to discard. Ask them first.'),
  },
  true,
  async (args, context) => {
    if (!args.work_id) throw new Error('publish_work requires a work_id.')
    // An organization session's works live in its Solus API, which publishes with the run's person's own connection.
    const { operations, context: home, remote } = await workspaceToolContext(context.sessionId())
    if (remote) {
      const published = await operations.publishWork(home, args.work_id, { provider: args.provider, scope: args.scope, overwrite: args.overwrite })
      if (published.outcome === 'conflict') {
        return `"${published.title}" was not published: the upstream document changed since Solus last saw it (${published.url}). Ask the user whether to pull_work_upstream first, or to publish over it with overwrite.`
      }
      return `Published "${published.title}" to ${published.url}.${published.lossyParts.length ? ` The published page could not carry: ${published.lossyParts.join(', ')}.` : ''}`
    }
    const work = await loadWork(ANY_ORGANIZATION, args.work_id)
    if (!work) throw new Error(`No work found with id "${args.work_id}".`)

    const options: Parameters<typeof publishWork>[2] = {}
    if (args.overwrite) options.force = true
    if (!work.mirroredDoc) {
      if (!args.provider || !args.scope) {
        throw new Error('This work has never been published. Pass `provider` and `scope` (a Confluence space key or a Drive folder id) the first time.')
      }
      const adapter = await requireAdapter(args.provider)
      options.destination = { provider: adapter.id, scope: args.scope, label: args.scope }
    }

    const result = await publishWork(ANY_ORGANIZATION, args.work_id, options)
    if (result.ok) {
      const lossy = result.lossyParts?.length
        ? ` The published page could not carry: ${result.lossyParts.join(', ')}.`
        : ''
      return `Published "${work.title}" to ${result.link.url}.${lossy}`
    }
    if (result.conflict) {
      return `"${work.title}" was not published: the upstream document changed since Solus last saw it (${result.link.url}). Ask the user whether to pull_work_upstream first, or to publish over it with overwrite.`
    }
    throw new Error(result.error)
  },
)

export const pullWorkUpstreamAgentTool = workSyncTool(
  'pull_work_upstream',
  'Pull a Confluence page or Google Doc into Solus as a work. Pass url to import a document, or work_id to refresh an existing linked work; pass exactly one. The work stays linked to its source for publish_work. Refresh replaces its content and keeps the previous version.',
  {
    work_id: z.string().min(1).optional().describe('The id of the linked work to refresh. Pass this or url, not both.'),
    url: z.string().url().optional().describe('The Confluence page or Google Doc URL to pull into Solus. Pass this or work_id, not both.'),
  },
  false,
  async (args, context) => {
    if (!!args.work_id === !!args.url) throw new Error('pull_work_upstream requires exactly one of work_id or url.')
    if (args.url) {
      // An imported work is the session's own record: it lands where the session's records live.
      const { operations, context: home, remote } = await workspaceToolContext(context.sessionId())
      if (remote) {
        // An organization session's work lives in its Solus API, which reads the link with the run's person's own connection.
        const work = await operations.importWork(home, { url: args.url, projectKey: resolveHomePath(context.cwd), originSessionId: home.actingAgent?.sessionId }, randomUUID())
        return `Imported "${work.title}" as work ${work.id} in the organization's Solus API, linked to ${args.url}.`
      }
      const imported = await importDocFromUrl(home.actingAgent?.organizationId ?? LOCAL_ORGANIZATION_ID, args.url, {
        cwd: resolveHomePath(context.cwd),
        sessionId: context.sessionId(),
        agentProvider: context.provider,
        ownerKey: ownerKeyOf(actorFor(home.principal)) ?? undefined,
      })
      const lossy = imported.lossyParts?.length
        ? ` Parts of the page could not be converted to markdown: ${imported.lossyParts.join(', ')}.`
        : ''
      return `Imported "${imported.work.title}" as work ${imported.work.id}, linked to ${imported.link.url}.${lossy}`
    }
    if (!args.work_id) throw new Error('pull_work_upstream requires a work_id or url.')
    const { operations, context: home, remote } = await workspaceToolContext(context.sessionId())
    if (remote) {
      const pulled = await operations.pullWorkUpstream(home, args.work_id)
      return `Refreshed "${pulled.title}" from ${pulled.url}.${pulled.lossyParts.length ? ` Parts of the page could not be converted to markdown: ${pulled.lossyParts.join(', ')}.` : ''}`
    }
    const result = await pullWorkUpstream(ANY_ORGANIZATION, args.work_id)
    if (!result.ok) throw new Error(result.error)
    const lossy = result.lossyParts?.length
      ? ` Parts of the page could not be converted to markdown: ${result.lossyParts.join(', ')}.`
      : ''
    return `Refreshed "${result.title}" from ${result.link.url}.${lossy}`
  },
)
