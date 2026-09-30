import { getContext, setContext } from 'svelte'
import type { OrganizationPeople } from '../../users/lib/organization-people'
import type { MentionScope } from './mentions'

/**
 * The record a surface's composers write on (a work, a task), and its
 * organization's people. A context, like the comment viewer: the composers and
 * the comment bodies sit several components under the surface that knows the
 * record. No context, or a Local record, means no one to mention.
 *
 * The directory comes with the scope, so a reader such as a comment body
 * needs no store of its own.
 */
export interface MentionContext {
  scope: () => MentionScope | null
  directory: () => OrganizationPeople | null
}

const KEY = Symbol('mention-context')

export const NO_MENTIONS: MentionContext = { scope: () => null, directory: () => null }

export function setMentionContext(context: MentionContext): void {
  setContext(KEY, context)
}

export function getMentionContext(): MentionContext {
  return getContext<MentionContext | undefined>(KEY) ?? NO_MENTIONS
}
