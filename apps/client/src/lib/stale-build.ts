import { toasts } from '@solus/workspace-ui/lib/toasts'

const STALE_MODULE_ERROR = /is not a valid (javascript|js) mime type|failed to fetch dynamically imported module|error loading dynamically imported module|importing a module script failed|expected a javascript(-or-wasm)? module script/i

export function isStaleBuildError(error: Error): boolean {
  return STALE_MODULE_ERROR.test(error.message)
}

let notified = false

export function reportStaleBuild(): void {
  if (notified) return
  notified = true
  toasts.error('This host updated Solus', {
    description: 'Part of the app could not load because this tab is running an older build. Reload to continue.',
    duration: Number.POSITIVE_INFINITY,
    action: { label: 'Reload', onAction: () => location.reload() },
  })
}
