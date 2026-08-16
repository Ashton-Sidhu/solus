// One colour per span kind, drawn from the brand art ramp.
//
// Kinds are a small closed categorical set, so they get fixed hues rather than
// a scale: the same kind must read identically in the waterfall, the share bar,
// and the legend, across every turn and both themes. The art ramp already
// self-inverts in dark mode, so nothing is restated per theme.

/** Time inside the turn that no child span claimed — model generation and any
 *  uninstrumented work. Derived by the server from the turn interval minus the
 *  union of observed children; it is not a stored span, but it is the largest
 *  slice of most turns, so it is coloured like one. */
export const UNINSTRUMENTED_KIND = 'uninstrumented'

const KIND_COLORS: Record<string, string> = {
  turn: 'var(--muted-foreground)',
  [UNINSTRUMENTED_KIND]: 'var(--solus-art-5)',
  tool_call: 'var(--solus-art-4)',
  setup: 'var(--solus-art-3)',
  permission_wait: 'var(--solus-art-2)',
  queue_wait: 'var(--solus-art-6)',
  rate_limit_wait: 'var(--solus-art-6)',
  agent_run: 'var(--solus-art-1)',
  background_task: 'var(--muted-foreground)',
}

const KIND_LABELS: Record<string, string> = {
  turn: 'Turn',
  [UNINSTRUMENTED_KIND]: 'Model & uninstrumented',
  tool_call: 'Tool calls',
  setup: 'Setup',
  permission_wait: 'Permission waits',
  queue_wait: 'Queue waits',
  rate_limit_wait: 'Rate-limit waits',
  agent_run: 'Agent runs',
  background_task: 'Background tasks',
}

export function colorForKind(kind: string): string {
  return KIND_COLORS[kind] ?? 'var(--muted-foreground)'
}

/** Plural, because a legend entry names every span of that kind at once. */
export function labelForKind(kind: string): string {
  return KIND_LABELS[kind] ?? kind.replace(/^internal\./, '').replace(/_/g, ' ')
}

/** Terminal span status → the colour its duration is printed in. `unknown` is
 *  an absence rather than a fault, so it stays neutral. */
export function colorForStatus(status: string | null | undefined): string {
  if (status === 'error') return 'var(--failure)'
  if (status === 'interrupted') return 'var(--warning)'
  return 'var(--foreground)'
}
