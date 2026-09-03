import type { AgentId } from '@solus/contracts/types'
import { createReferenceNode } from './lib/reference-node'
import { isAgentId } from './reference-tokens'
import { TOKEN_ICONS } from './tokenStyle'

export interface SessionRefAttrs {
  sessionId: string
  provider: AgentId
  title: string
  cwd: string
  /** The host the session came from. Insert callers leave it unset when the
   *  session is on the primary host. */
  serverId?: string | null
}

function agentId(value: string | null): AgentId {
  return value && isAgentId(value) ? value : 'claude-code'
}

export const SessionRefExtension = createReferenceNode<SessionRefAttrs>({
  name: 'sessionReference',
  scheme: 'session',
  dataAttr: 'data-session-ref',
  attrs: {
    sessionId: { default: null },
    provider: { default: null },
    serverId: { default: null },
    title: { default: '' },
    cwd: { default: '' },
  },
  fromUrl: (url, label) => ({
    sessionId: url.searchParams.get('sessionId') ?? '',
    provider: agentId(url.searchParams.get('provider')),
    serverId: url.searchParams.get('serverId'),
    cwd: url.searchParams.get('cwd') || '',
    title: label,
  }),
  toToken: (attrs) => ({
    kind: 'session',
    sessionId: attrs.sessionId ?? '',
    provider: attrs.provider ?? 'claude-code',
    serverId: attrs.serverId ?? undefined,
    cwd: attrs.cwd ?? '',
    title: attrs.title ?? '',
  }),
  idOf: (attrs) => attrs.sessionId,
  label: (attrs) => attrs.title,
  variant: () => 'session',
  icon: () => TOKEN_ICONS.session,
})
