import { hostReadinessCopy, lastSeenText, type HostReadinessState } from './host-readiness'

/** How the last dial to a host failed, as the transport saw it. */
export interface DialError {
  message: string
  /** The host's code on a refusal (`UNAUTHORIZED`); null for a network failure. */
  code: string | null
  at: number
}

/**
 * Everything a person needs to see why a host is not ready, or to send to
 * support (docs/plans/host-readiness.md). Each client fills it from its own
 * connection layer; the rows and the copied text are the same everywhere.
 */
export interface HostDiagnostics {
  hostId: string
  label: string
  installationId: string | null
  state: HostReadinessState
  /** The address the last dial went to. */
  dialedUrl: string | null
  /** Every address this client knows for the host, in the order it tries them. */
  routes: readonly { kind: string; url: string }[]
  /** Failed dials since the host was last ready or the last retry. */
  attempt: number
  lastDialError: DialError | null
  /** The host's Solus version when this client last read it. */
  hostVersion: string | null
  clientVersion: string
}

export interface HostDiagnosticRow {
  label: string
  value: string
  /** An address or an id: set in mono, as the transcript sets code. */
  isCode?: boolean
}

function clockTime(at: number): string {
  return new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

/** The details under a host's state. The host and its state are the card's
 *  title, so they are not repeated here; the copied text carries them. */
export function hostDiagnosticRows(diagnostics: HostDiagnostics, now = Date.now()): HostDiagnosticRow[] {
  const { state } = diagnostics
  const rows: HostDiagnosticRow[] = [
    {
      label: 'Last seen',
      value: state.lastSeenAt === null
        ? 'Not connected from this device yet'
        : `${lastSeenText(state.lastSeenAt, now)} (${clockTime(state.lastSeenAt)})`,
    },
    { label: 'Address', value: diagnostics.dialedUrl || 'No address', isCode: !!diagnostics.dialedUrl },
  ]
  const otherRoutes = diagnostics.routes.filter((route) => route.url !== diagnostics.dialedUrl)
  if (otherRoutes.length > 0) {
    rows.push({ label: 'Other addresses', value: otherRoutes.map((route) => `${route.url} (${route.kind})`).join(', '), isCode: true })
  }
  rows.push({ label: 'Failed dials', value: String(diagnostics.attempt) })
  if (diagnostics.lastDialError) {
    const { message, code, at } = diagnostics.lastDialError
    rows.push({ label: 'Last error', value: `${code ? `${code}: ` : ''}${message} (${clockTime(at)})` })
  }
  rows.push(
    { label: 'Host version', value: diagnostics.hostVersion ?? 'Unknown' },
    { label: 'This device', value: `Solus ${diagnostics.clientVersion}` },
    { label: 'Host ID', value: diagnostics.hostId, isCode: true },
  )
  if (diagnostics.installationId) rows.push({ label: 'Installation ID', value: diagnostics.installationId, isCode: true })
  return rows
}

/** The rows as plain text, for a support message. */
export function hostDiagnosticsText(diagnostics: HostDiagnostics, now = Date.now()): string {
  const rows = [
    { label: 'Host', value: diagnostics.label },
    { label: 'Status', value: hostReadinessCopy(diagnostics.state, diagnostics.label, now).label },
    ...hostDiagnosticRows(diagnostics, now),
  ].map((row) => `${row.label}: ${row.value}`)
  return [`Solus host diagnostics, ${new Date(now).toISOString()}`, ...rows].join('\n')
}
