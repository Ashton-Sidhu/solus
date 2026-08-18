// One colour per span kind, drawn from the brand art ramp.
//
// Kinds are a small closed categorical set, so they get fixed hues rather than
// a scale: the same kind must read identically in the waterfall, the share bar,
// and the legend, across every turn and both themes. The art ramp already
// self-inverts in dark mode, so nothing is restated per theme.

/** Time inside the turn that no blocking child span claimed. It is a coverage
 *  remainder, not a claim about model work or agent activity. */
export const UNATTRIBUTED_KIND = 'unattributed'

const KIND_COLORS: Record<string, string> = {
  turn: 'var(--muted-foreground)',
  [UNATTRIBUTED_KIND]: 'var(--solus-art-5)',
  thinking: 'var(--solus-art-1)',
  response_stream: 'var(--solus-art-2)',
  tool_call: 'var(--solus-art-4)',
  setup: 'var(--solus-art-3)',
  permission_wait: 'var(--solus-art-2)',
  queue_wait: 'var(--solus-art-6)',
  rate_limit_wait: 'var(--solus-art-6)',
  turn_settlement: 'var(--solus-art-3)',
  agent_run: 'var(--solus-art-1)',
  background_task: 'var(--muted-foreground)',
}

const KIND_LABELS: Record<string, string> = {
  turn: 'Turn',
  [UNATTRIBUTED_KIND]: 'Unattributed turn time',
  thinking: 'Thinking',
  response_stream: 'Response streaming',
  tool_call: 'Tool calls',
  setup: 'Setup',
  permission_wait: 'Permission waits',
  queue_wait: 'Queue waits',
  rate_limit_wait: 'Rate-limit waits',
  turn_settlement: 'Solus settlement',
  agent_run: 'Agent runs',
  background_task: 'Background tasks',
}

/**
 * The order chart series take hues in — a fixed sequence, never cycled, so the
 * ramp's six hues are spent from the most distinguishable pair outwards.
 *
 * The order is computed, not chosen by eye: it is the arrangement of the brand
 * art ramp whose every adjacent pair clears both the colour-blind separation
 * floor and the normal-vision floor in light and dark (the dataviz skill's
 * `validate_palette.js`). The ramp's own muted chroma still trips that script's
 * chroma floor — a brand fact, not an ordering one — so a legend is always
 * drawn and the table below carries the same values in ink.
 */
const SERIES_COLORS = [
  'var(--solus-art-1)', // terracotta
  'var(--solus-art-5)', // dusty blue
  'var(--solus-art-2)', // amber
  'var(--solus-art-4)', // teal
  'var(--solus-art-6)', // plum
  'var(--solus-art-3)', // sage
]

export const SERIES_COLOR_COUNT = SERIES_COLORS.length

export function colorForSeries(index: number): string {
  return SERIES_COLORS[index] ?? 'var(--muted-foreground)'
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
