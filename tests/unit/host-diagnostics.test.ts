import { describe, expect, test } from 'bun:test'
import { hostDiagnosticRows, hostDiagnosticsText, type HostDiagnostics } from '@solus/client-core/host-diagnostics'

// A host that is not ready shows what a person needs to debug it, or to send to
// support (docs/plans/host-readiness.md). The same rows on every client.

const NOW = Date.UTC(2026, 9, 23, 21, 40)
const diagnostics: HostDiagnostics = {
  hostId: 'raiders',
  label: 'Raiders',
  installationId: 'inst-1',
  state: { readiness: 'unreachable', away: true, unreachableReason: 'no-answer', refusedReason: null, lastSeenAt: NOW - 4 * 60_000 },
  dialedUrl: 'http://192.168.1.20:4000',
  routes: [{ kind: 'lan', url: 'http://192.168.1.20:4000' }, { kind: 'tunnel', url: 'https://raiders.solus.sh' }],
  attempt: 6,
  lastDialError: { message: 'xhr poll error', code: null, at: NOW - 10_000 },
  hostVersion: '0.42.0',
  clientVersion: '0.43.1',
}

describe('host diagnostics', () => {
  test('names the address, the other routes, the attempts, and the last error', () => {
    const rows = Object.fromEntries(hostDiagnosticRows(diagnostics, NOW).map((row) => [row.label, row.value]))
    expect(rows.Address).toBe('http://192.168.1.20:4000')
    // WHY: the address that was dialed is shown once; only the others are listed again.
    expect(rows['Other addresses']).toBe('https://raiders.solus.sh (tunnel)')
    expect(rows['Failed dials']).toBe('6')
    expect(rows['Last error']).toStartWith('xhr poll error')
    expect(rows['Host version']).toBe('0.42.0')
    expect(rows['This device']).toBe('Solus 0.43.1')
  })

  test('a host never reached says so instead of a time', () => {
    const rows = hostDiagnosticRows({ ...diagnostics, state: { ...diagnostics.state, lastSeenAt: null }, lastDialError: null }, NOW)
    expect(rows.find((row) => row.label === 'Last seen')?.value).toBe('Not connected from this device yet')
    expect(rows.some((row) => row.label === 'Last error')).toBe(false)
  })

  test('the copied text carries every row and when it was taken', () => {
    const text = hostDiagnosticsText(diagnostics, NOW)
    expect(text.split('\n')[0]).toBe('Solus host diagnostics, 2026-10-23T21:40:00.000Z')
    // WHY: the card's title names the host and its state; a support message has no title.
    expect(text).toContain('Host: Raiders')
    expect(text).toContain('Status: Offline')
    expect(text).toContain('Host ID: raiders')
    expect(text).toContain('Installation ID: inst-1')
  })
})
