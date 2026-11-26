import { z } from 'zod'
import {
  DEFAULT_LINK_LIFETIME_MS,
  LINK_LIFETIMES_MS,
  cloudShareUrl,
  type ShareList,
  type ShareResource,
  type ShareSetLinkRequest,
  type ShareSetRequest,
} from '@solus/contracts/sharing'
import type { AgentTool, AgentToolContext, AgentToolResult } from './agent-tool'
import { asPerson } from './person-rpc'

/**
 * The sharing tools (plans/035-cloud-machine-tools.md §11): who may open a session or
 * a work, and its share link. Each call is the RPC that the Share dialog sends, as the
 * person of the turn (`asPerson`), so the gate of a client's call applies: a guest or a
 * viewer cannot share. A person who is signed out can share too, so these tools are
 * not in the signed-in-only group.
 */

const resourceField = z.object({
  kind: z.enum(['session', 'work']),
  id: z.string().min(1).max(200),
}).optional().describe('This session when absent.')

/** Roles an agent may give: never `custom`, which only the Share dialog makes. */
const roleField = z.enum(['viewer', 'commenter', 'editor'])

const SHARING_NOTE = 'Documents, decks, and artifacts are works (ids from list_works). People and team ids come from list_organization_members.'

/** One subject; `shareSet` checks it against the contract. A flat object keeps the schema the model reads small. */
const subjectField = z.object({ kind: z.enum(['user', 'team', 'organization']), id: z.string().min(1).max(200) })

/** The resource a call names, or the session of the turn; null when there is neither. */
function resourceOf(named: ShareResource | undefined, context: AgentToolContext): ShareResource | null {
  if (named) return named
  const sessionId = context.sessionId()
  return sessionId ? { kind: 'session', id: sessionId } : null
}

const NO_RESOURCE: AgentToolResult = { ok: false, text: 'Name the resource: this call has no session of its own.' }

const json = <T>(value: T): AgentToolResult => ({ ok: true, text: JSON.stringify(value) })

const endOf = (expiresAt: number | null): string => expiresAt === null ? 'never' : new Date(expiresAt).toISOString()

/** The list as an agent reads it. The link's secret is never in it. */
function sharingFacts(list: ShareList) {
  return {
    resource: list.resource,
    owner: list.ownerKey,
    yourRole: list.callerRole,
    entries: list.entries.map(({ subject, role, actions }) => (actions ? { subject, role, actions } : { subject, role })),
    link: list.link ? { on: true, role: list.link.role, ends: endOf(list.link.expiresAt) } : { on: false },
  }
}

export const readSharingAgentTool: AgentTool<{ resource: typeof resourceField }> = {
  name: 'read_sharing',
  description: `Who may open a session or a work, their roles, and whether its share link is on. ${SHARING_NOTE}`,
  inputFields: { resource: resourceField },
  requiresApproval: false,
  execute(input, context) {
    const resource = resourceOf(input.resource, context)
    if (!resource) return Promise.resolve(NO_RESOURCE)
    return asPerson('read_sharing', context, async (call) => json(sharingFacts(await call('shareGet', { resource }))))
  },
}

const shareFields = {
  resource: resourceField,
  add: z.array(z.object({ subject: subjectField, role: roleField })).max(50).optional().describe('Give or change a role.'),
  remove: z.array(subjectField).max(50).optional(),
}

const subjectKey = (subject: { kind: string; id: string }): string => `${subject.kind}:${subject.id}`

export const shareAgentTool: AgentTool<typeof shareFields> = {
  name: 'share',
  description: `Share a session or a work with a person, a team, or the organization, or take one off. Only the named entries change. commenter is for works; on a session it is viewer. ${SHARING_NOTE}`,
  inputFields: shareFields,
  requiresApproval: false,
  execute(input, context) {
    const resource = resourceOf(input.resource, context)
    if (!resource) return Promise.resolve(NO_RESOURCE)
    if (!input.add?.length && !input.remove?.length) return Promise.resolve({ ok: false, text: 'Give add or remove.' })
    return asPerson('share', context, async (call) => {
      const current = await call('shareGet', { resource })
      // `shareSet` replaces the whole list: every entry not named is written back as it is, custom actions included.
      const entries = new Map<string, ShareSetRequest['entries'][number]>(current.entries.map(({ subject, role, actions }) => [subjectKey(subject), actions ? { subject, role, actions } : { subject, role }]))
      for (const subject of input.remove ?? []) entries.delete(subjectKey(subject))
      for (const { subject, role } of input.add ?? []) entries.set(subjectKey(subject), { subject, role })
      // No `link`: the link stays as it is.
      const written = await call('shareSet', { resource, entries: [...entries.values()] })
      const answer: ReturnType<typeof sharingFacts> & { note?: string } = sharingFacts(written)
      if (resource.kind === 'session' && input.add?.some((entry) => entry.role === 'commenter')) answer.note = 'On a session, commenter acts as viewer.'
      return json(answer)
    })
  },
}

const LIFETIMES = { '1h': LINK_LIFETIMES_MS[0], '24h': DEFAULT_LINK_LIFETIME_MS, '7d': LINK_LIFETIMES_MS[2], never: null } as const

const linkFields = {
  resource: resourceField,
  role: roleField.default('viewer'),
  expires_in: z.enum(['1h', '24h', '7d', 'never']).default('24h'),
  regenerate: z.boolean().optional().describe('The old URL stops working.'),
}

export const createShareLinkAgentTool: AgentTool<typeof linkFields> = {
  name: 'create_share_link',
  description: 'Turn on, or change, the share link of a session or a work, and return its URL. Anyone with the URL opens it until it ends.',
  inputFields: linkFields,
  requiresApproval: false,
  execute(input, context) {
    const resource = resourceOf(input.resource, context)
    if (!resource) return Promise.resolve(NO_RESOURCE)
    return asPerson('create_share_link', context, async (call) => {
      const request: ShareSetLinkRequest = { resource, role: input.role, expiresInMs: LIFETIMES[input.expires_in] }
      if (input.regenerate) request.regenerate = true
      const link = await call('shareSetLink', request)
      if (!link) return { ok: false, text: 'The host did not turn the link on.' }
      const facts = { resource, role: link.role, ends: endOf(link.expiresAt) }
      const { origin } = await call('shareLinkOrigin', resource)
      if (!origin) {
        return json({ ...facts, url: null, note: 'The link is on, but nobody off this machine can open it: this host has no address that others reach. remove_share_link turns it off.' })
      }
      return json({
        ...facts,
        url: cloudShareUrl(origin, resource, link.secret),
        note: `Anyone who can read this conversation can open this ${resource.kind} with this URL until the link ends, or until remove_share_link turns it off.`,
      })
    })
  },
}

export const removeShareLinkAgentTool: AgentTool<{ resource: typeof resourceField }> = {
  name: 'remove_share_link',
  description: 'Turn off the share link of a session or a work. Its URL stops working.',
  inputFields: { resource: resourceField },
  requiresApproval: false,
  execute(input, context) {
    const resource = resourceOf(input.resource, context)
    if (!resource) return Promise.resolve(NO_RESOURCE)
    return asPerson('remove_share_link', context, async (call) => {
      await call('shareSetLink', { resource, role: null })
      return json({ resource, link: { on: false } })
    })
  },
}
