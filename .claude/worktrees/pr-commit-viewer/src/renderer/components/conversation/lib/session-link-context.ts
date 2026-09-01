import { getContext, setContext } from 'svelte'

const SESSION_LINK_CONTEXT = Symbol('session-link-context')

interface SessionLinkContext {
  serverId: () => string | undefined
}

export function setSessionLinkContext(serverId: () => string | undefined): void {
  setContext(SESSION_LINK_CONTEXT, { serverId } satisfies SessionLinkContext)
}

export function getSessionLinkContext(): SessionLinkContext | undefined {
  return getContext<SessionLinkContext | undefined>(SESSION_LINK_CONTEXT)
}
