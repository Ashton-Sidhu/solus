import { z } from 'zod'
import type { DocPatch, DocSummary } from '@solus/contracts/docs'
import type { AgentTool, AgentToolContext } from '../agents/tools/agent-tool'
import { createLogger } from '../logger'
import { importDocFromUrl, publishWork, pullWorkUpstream } from '../folio/work-sync'
import { loadWork } from '../folio/works'
import { docProviderAdapter, docProviderIds, docProviderStatuses, resolveDocUrl } from './registry'
import type { DocProviderAdapter } from './types'

const log = createLogger('docs', 'doc-tools.ts')

/**
 * One set of document tools for every provider, routed by a `provider`
 * argument, rather than a tool set per provider. Adding Notion later adds no
 * tool the agent has to learn.
 *
 * `provider` is validated at execution time, not in the schema: tool schemas
 * are built once when a session starts, and a provider can be connected or
 * disconnected while that session is still running. A rejected call answers
 * with what *is* connected, so the agent can recover in one turn.
 */

const PROVIDER_ARG = `Which document provider to use: ${docProviderIds().join(' or ')}.`

async function connectedProvidersHint(): Promise<string> {
  const statuses = await docProviderStatuses()
  const connected = statuses.filter((status) => status.connected).map((status) => status.provider)
  if (connected.length === 0) {
    // The reasons state the situation; the agent needs the route as well, since
    // only the user can complete a sign-in.
    const reasons = statuses.map((status) => status.reason).filter(Boolean).join(' ')
    return `No document provider is connected. ${reasons} The user connects one in Settings → Providers.`
  }
  // A failure a narrower grant explains — a Drive doc Solus did not create
  // answers 404 — is unreadable without this.
  const limitations = statuses.map((status) => status.limitation).filter(Boolean).join(' ')
  return `Connected document providers: ${connected.join(', ')}.${limitations ? ` ${limitations}` : ''}`
}

/** `limitation` is what the connection still cannot do, ready to append to a
 *  tool result: a thin search answer must not be the only evidence of it. */
async function requireAdapter(provider: string): Promise<{ adapter: DocProviderAdapter; limitation: string }> {
  const adapter = docProviderAdapter(provider)
  const status = await adapter.status()
  if (!status.connected) {
    throw new Error(status.reason ?? `${provider} is not connected.`)
  }
  return { adapter, limitation: status.limitation ? `\n\n(${status.limitation})` : '' }
}

/** A URL carries the provider scope as well as the document id. An id alone is
 * not enough for providers such as Confluence, where page ids are site-local. */
async function resolveTarget(url: string | undefined): Promise<{
  adapter: DocProviderAdapter
  ref: DocSummary['ref']
  limitation: string
}> {
  if (!url) throw new Error('Pass the document `url`.')
  const resolved = resolveDocUrl(url)
  if (!resolved) throw new Error(`"${url}" is not a document link Solus recognizes.`)
  const { limitation } = await requireAdapter(resolved.ref.provider)
  return { ...resolved, limitation }
}

function formatSummaries(hits: DocSummary[]): string {
  return hits
    .map((hit) => {
      const when = hit.updatedAt ? `, updated ${hit.updatedAt}` : ''
      const excerpt = hit.excerpt ? `\n  ${hit.excerpt}` : ''
      return `- ${hit.ref.externalId} — "${hit.title}" (${hit.kind ?? 'doc'}${when})\n  ${hit.ref.url}${excerpt}`
    })
    .join('\n')
}

function docTool(
  name: string,
  description: string,
  inputFields: AgentTool['inputFields'],
  requiresApproval: boolean,
  run: (args: DocToolArgs, context: AgentToolContext) => Promise<string>,
): AgentTool {
  return {
    name,
    description,
    inputFields,
    requiresApproval,
    execute: async (args, context) => {
      try {
        // SAFETY: `executeAgentTool` parses the call against `inputFields`
        // before this runs, so the arguments already match this tool's schema.
        return { ok: true, text: await run(args as DocToolArgs, context) }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        log.warn('doc_tool_failed', { tool: name, error: message })
        return { ok: false, text: `${message}\n\n${await connectedProvidersHint()}` }
      }
    },
  }
}

interface DocToolArgs {
  provider?: string
  scope?: string
  query?: string
  url?: string
  title?: string
  content?: string
  work_id?: string
  overwrite?: boolean
}

export const searchDocsAgentTool = docTool(
  'search_docs',
  "Search the user's connected document providers — Confluence pages and Google Docs — by full text. Reach for this whenever the user refers to a document that lives outside Solus (\"the spec in Confluence\", \"that design doc\"). Each result carries a URL; pass it to read_doc to load the full content.",
  {
    provider: z.string().describe(PROVIDER_ARG),
    query: z.string().describe('Full-text query.'),
    scope: z.string().optional().describe(
      'Optional place to search in: a Confluence space key, or a Google Drive folder id. Omit to search everything the connection can reach.',
    ),
  },
  false,
  async (args) => {
    const { adapter, limitation } = await requireAdapter(args.provider ?? '')
    const query = args.query?.trim() ?? ''
    if (!query) throw new Error('search_docs requires a non-empty query.')
    const hits = await adapter.search(args.scope, query)
    if (!hits.length) return `No ${adapter.id} documents match "${query}".${limitation}`
    return `${adapter.id} documents matching "${query}":\n${formatSummaries(hits)}${limitation}`
  },
)

export const readDocAgentTool = docTool(
  'read_doc',
  'Read an upstream document (a Confluence page or a Google Doc) as markdown. Pass the `url` the user gave you, or the URL from a search_docs result. Reading never changes anything upstream.',
  {
    url: z.string().describe('The document URL, exactly as the user pasted it.'),
  },
  false,
  async (args) => {
    const { adapter, ref } = await resolveTarget(args.url)
    const doc = await adapter.read(ref)
    const lossy = doc.lossyParts?.length
      ? `\n\n(Parts of this page could not be converted to markdown: ${doc.lossyParts.join(', ')}.)`
      : ''
    // No limitation note here: a read that returned content proves the
    // connection reached the doc, whatever the grant cannot reach elsewhere.
    return `${adapter.id} document "${doc.title}" (${doc.ref.url}):\n\n${doc.markdown}${lossy}`
  },
)

export const createDocAgentTool = docTool(
  'create_doc',
  'Create a NEW document upstream — a Confluence page or a Google Doc. Use this only when the user asks for a document in that tool; to create something they keep inside Solus, use create_work instead. To publish a Solus work upstream, use publish_work, which keeps the two linked.',
  {
    provider: z.string().describe(PROVIDER_ARG),
    scope: z.string().describe('Where to create it: a Confluence space key (optionally `SPACE/parentPageId`), or a Google Drive folder id (`root` for My Drive).'),
    title: z.string().describe('The document title.'),
    content: z.string().describe('The full document content, in markdown.'),
  },
  true,
  async (args) => {
    const { adapter } = await requireAdapter(args.provider ?? '')
    if (!args.scope) throw new Error('create_doc requires a scope (a Confluence space key or a Drive folder id).')
    if (!args.content?.trim()) throw new Error('create_doc requires non-empty content.')
    const doc = await adapter.create(args.scope, { title: args.title?.trim() || 'Untitled', markdown: args.content })
    return `Created ${adapter.id} document "${doc.title}": ${doc.ref.url}`
  },
)

export const updateDocAgentTool = docTool(
  'update_doc',
  'Replace the content of an existing upstream document. Read it first — this replaces the whole body, and anything the markdown cannot express (Confluence macros, Docs suggestions) is lost when you write it back.',
  {
    url: z.string().describe('The document URL.'),
    content: z.string().describe('The full new content, in markdown. Replaces the existing body entirely.'),
    title: z.string().optional().describe('Optional new title.'),
  },
  true,
  async (args) => {
    const { adapter, ref } = await resolveTarget(args.url)
    if (!args.content?.trim()) throw new Error('update_doc requires non-empty content.')
    const patch: DocPatch = { markdown: args.content }
    if (args.title) patch.title = args.title
    const doc = await adapter.update(ref, patch)
    return `Updated ${adapter.id} document "${doc.title}": ${doc.ref.url}`
  },
)

export const importDocAgentTool = docTool(
  'import_doc',
  'Import an upstream document into Solus as a work, linked to its source so it can be published back later. Use this when the user pastes a Confluence or Google Docs link and wants to work on it here.',
  {
    url: z.string().describe('The Confluence page or Google Doc URL.'),
  },
  false,
  async (args, context) => {
    if (!args.url) throw new Error('import_doc requires a url.')
    const imported = await importDocFromUrl(args.url, {
      cwd: context.cwd,
      sessionId: context.sessionId(),
      agentProvider: context.provider,
    })
    const lossy = imported.lossyParts?.length
      ? ` Parts of the page could not be converted to markdown: ${imported.lossyParts.join(', ')}.`
      : ''
    return `Imported "${imported.work.title}" as work ${imported.work.id}, linked to ${imported.link.url}.${lossy}`
  },
)

export const publishWorkAgentTool = docTool(
  'publish_work',
  'Publish a Solus work upstream as a Confluence page or Google Doc, and keep it linked so later publishes update that same page instead of creating copies. On the first publish, pass `provider` and `scope`; after that neither is needed. If the upstream page changed since Solus last saw it, this reports a conflict instead of overwriting — tell the user and offer pull_work_upstream.',
  {
    work_id: z.string().describe('The id of the work to publish (from list_works).'),
    provider: z.string().optional().describe(`${PROVIDER_ARG} Required only on the first publish.`),
    scope: z.string().optional().describe('Where to create it on the first publish: a Confluence space key, or a Drive folder id.'),
    overwrite: z.boolean().optional().describe('Publish over an upstream change the user has decided to discard. Ask them first.'),
  },
  true,
  async (args, context) => {
    if (!args.work_id) throw new Error('publish_work requires a work_id.')
    const work = await loadWork(args.work_id, context.cwd)
    if (!work) throw new Error(`No work found with id "${args.work_id}".`)

    const options: Parameters<typeof publishWork>[1] = { cwd: context.cwd }
    if (args.overwrite) options.force = true
    if (!work.mirroredDoc) {
      if (!args.provider || !args.scope) {
        throw new Error('This work has never been published. Pass `provider` and `scope` (a Confluence space key or a Drive folder id) the first time.')
      }
      const { adapter } = await requireAdapter(args.provider)
      options.destination = { provider: adapter.id, scope: args.scope, label: args.scope }
    }

    const result = await publishWork(args.work_id, options)
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

export const pullWorkUpstreamAgentTool = docTool(
  'pull_work_upstream',
  'Refresh a linked work from its upstream document, replacing the local content with what the Confluence page or Google Doc says now. The previous content is kept as the work\'s previous version, so this is revertable.',
  {
    work_id: z.string().describe('The id of the linked work to refresh (from list_works).'),
  },
  false,
  async (args, context) => {
    if (!args.work_id) throw new Error('pull_work_upstream requires a work_id.')
    const result = await pullWorkUpstream(args.work_id, context.cwd)
    if (!result.ok) throw new Error(result.error)
    const lossy = result.lossyParts?.length
      ? ` Parts of the page could not be converted to markdown: ${result.lossyParts.join(', ')}.`
      : ''
    return `Refreshed "${result.title}" from ${result.link.url}.${lossy}`
  },
)
