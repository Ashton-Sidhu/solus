import { untrack } from 'svelte'
import type { OrganizationPeople } from '../../users/lib/organization-people'
import type { PersonMention } from '@solus/contracts/mentions'
import { sharesStore } from '../../../contexts/sharing/shares.store.svelte'
import { hasOrganization, personCanOpen, scopeDirectory, type MentionScope } from './mentions'
import { NO_MENTIONS, setMentionContext } from './mention-context'

/**
 * Gives the surface's composers and readers their record and its people, and
 * asks the host for them while the surface is mounted: a reader needs them
 * too, to show a mention's current name.
 */
export function provideMentionScope(read: () => MentionScope | null): void {
  setMentionContext({ scope: read, directory: () => mentionDirectory(read()) })
  $effect(() => {
    const scope = read()
    untrack(() => warmMentionSources(scope))
  })
}

/** A composer under a work surface that writes somewhere else (a Google Docs
 *  reply) must not store a Solus mention. */
export function clearMentionScope(): void {
  setMentionContext(NO_MENTIONS)
}

/** The record organization's people, as `sharesStore` last loaded them. */
export function mentionDirectory(scope: MentionScope | null): OrganizationPeople | null {
  return hasOrganization(scope) ? scopeDirectory(scope, sharesStore.directories.get(scope.serverId)) : null
}

/** Asks the host, through `sharesStore`, for what mentions read: the people and the share lists. */
export function warmMentionSources(scope: MentionScope | null): void {
  if (!hasOrganization(scope)) return
  void sharesStore.directoryFor(scope.serverId)
  void sharesStore.load(scope.serverId, scope.resource).then((list) => {
    for (const task of list?.inheritedFrom ?? []) void sharesStore.load(scope.serverId, { kind: 'task', id: task.taskId })
  })
}

/** Whether the person can open the record; null while that is not known. */
export function mentionAccess(scope: MentionScope, userId: string): boolean | null {
  const list = sharesStore.listFor(scope.serverId, scope.resource)
  if (!list) return null
  const inherited = (list.inheritedFrom ?? []).map((task) => sharesStore.listFor(scope.serverId, { kind: 'task', id: task.taskId }))
  return personCanOpen(userId, [list, ...inherited], mentionDirectory(scope))
}

/** The mentioned people who cannot open the record: the composer warns about them. */
export function mentionsWithoutAccess(scope: MentionScope | null, people: readonly PersonMention[]): PersonMention[] {
  if (!hasOrganization(scope)) return []
  return people.filter((person) => mentionAccess(scope, person.userId) === false)
}
