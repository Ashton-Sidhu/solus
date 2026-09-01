import type { InboxPullRequest, InboxScopeProject, InboxUpstreamScope } from '@solus/contracts/inbox-types'
import type { Task } from '@solus/contracts/task-types'

export interface InboxRowLocation extends InboxScopeProject {
  serverId: string
}

export interface InboxHostScope extends InboxUpstreamScope {
  serverId: string
}

export interface MergedInboxTicket {
  key: string
  task: Task
  externalKey: string
  locations: InboxRowLocation[]
}

export interface MergedInboxPullRequest {
  key: string
  pullRequest: InboxPullRequest
  locations: InboxRowLocation[]
}

function addLocations(current: InboxRowLocation[], scope: InboxHostScope): InboxRowLocation[] {
  const merged = new Map(current.map((location) => [
    `${location.serverId}\0${location.projectKey}`, location,
  ]))
  for (const project of scope.projects) {
    merged.set(`${scope.serverId}\0${project.projectKey}`, { ...project, serverId: scope.serverId })
  }
  return [...merged.values()]
}

export function mergeInboxTickets(scopes: InboxHostScope[]): MergedInboxTicket[] {
  const merged = new Map<string, MergedInboxTicket>()
  for (const scope of scopes) {
    for (const task of scope.tickets) {
      const key = `${task.providerId}:${scope.externalKey}#${task.id}`
      const existing = merged.get(key)
      if (existing) existing.locations = addLocations(existing.locations, scope)
      else merged.set(key, {
        key,
        externalKey: scope.externalKey,
        task: { ...task, projectKey: scope.projects[0]?.projectKey },
        locations: addLocations([], scope),
      })
    }
  }
  return [...merged.values()]
}

export function mergeInboxPullRequests(scopes: InboxHostScope[]): MergedInboxPullRequest[] {
  const merged = new Map<string, MergedInboxPullRequest>()
  for (const scope of scopes) {
    for (const pullRequest of scope.pullRequests) {
      const key = `github:${scope.externalKey}#${pullRequest.number}`
      const existing = merged.get(key)
      if (existing) existing.locations = addLocations(existing.locations, scope)
      else merged.set(key, { key, pullRequest, locations: addLocations([], scope) })
    }
  }
  return [...merged.values()]
}
