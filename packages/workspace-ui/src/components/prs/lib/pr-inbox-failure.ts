/**
 * What the "All projects" scope must say when a project fails to load.
 *
 * The inbox keeps every project's last-safe rows, so a failure never blanks
 * the list — which also means a failure is invisible unless it is stated. An
 * unannounced miss reads as "that project has no pull requests", so the rule
 * is: any failure is always shown, as a banner over the rows that did load, or
 * as the page's own empty surface when nothing loaded at all. A GitHub
 * authorization failure outranks a generic one; it is the cause a person can
 * act on.
 */
import type { PrSurfaceError } from './pr-surface-error'

export interface InboxProjectFailure {
  serverId: string
  label: string
  error: PrSurfaceError | null
}

export type PrInboxFailure =
  | { kind: 'none'; placement: 'none' }
  | { kind: 'github-auth'; placement: 'page' | 'banner'; serverId: string }
  | { kind: 'generic'; placement: 'page' | 'banner'; summary: string; detail: string }

export function prInboxFailure(projects: InboxProjectFailure[], hasItems: boolean): PrInboxFailure {
  const failed = projects.filter((project) => project.error !== null)
  if (failed.length === 0) return { kind: 'none', placement: 'none' }
  const placement = hasItems ? 'banner' : 'page'
  const unauthorized = failed.find((project) => project.error?.kind === 'github-auth')
  if (unauthorized) return { kind: 'github-auth', placement, serverId: unauthorized.serverId }
  return {
    kind: 'generic',
    placement,
    summary:
      failed.length === 1
        ? `Couldn’t load pull requests from ${failed[0].label}.`
        : `Couldn’t load pull requests from ${failed.length} projects.`,
    detail: failed[0].error?.message ?? 'Every project failed to load.',
  }
}
