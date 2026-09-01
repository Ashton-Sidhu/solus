import { toasts } from '@solus/workspace-ui/lib/toasts'

/**
 * A long-lived web tab holds one build's entry chunk. When its host rebuilds,
 * the content-hashed chunks that entry names are gone, so the next lazily
 * imported surface (tasks, settings, a diff) fails to load. The browser reports
 * that as a module-loading error whose text varies per engine, and — before the
 * server learned to 404 a missing chunk — as an HTML MIME type rejection.
 *
 * None of those messages tell the user what to do, and the failure surfaces as
 * an unhandled rejection, leaving the surface silently empty. Recognise the
 * class and offer the only cure: reload onto the current build.
 */
const STALE_MODULE_ERROR = /is not a valid (javascript|js) mime type|failed to fetch dynamically imported module|error loading dynamically imported module|importing a module script failed|expected a javascript(-or-wasm)? module script/i

export function isStaleBuildError(error: Error): boolean {
  return STALE_MODULE_ERROR.test(error.message)
}

let notified = false

/**
 * The workspace may hold an unsent prompt, so this never reloads on its own:
 * it states what happened and leaves the reload to the user.
 */
export function reportStaleBuild(): void {
  if (notified) return
  notified = true
  toasts.error('This host updated Solus', {
    description: 'Part of the app could not load because this tab is running an older build. Reload to continue.',
    duration: Number.POSITIVE_INFINITY,
    action: { label: 'Reload', onAction: () => location.reload() },
  })
}
