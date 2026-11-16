export function tailscaleServePreview(url: string | null, port: number): string | null {
  if (!url || !Number.isInteger(port) || port < 1 || port > 65535) return null
  try {
    const parsed = new URL(url)
    parsed.port = port === 443 ? '' : String(port)
    return parsed.origin
  } catch { return null }
}

export function tailscaleServeStateText(state: 'off' | 'ready' | 'active' | 'other' | 'error'): string {
  switch (state) {
    case 'off': return 'Off'
    case 'ready': return 'Waiting for Tailscale'
    case 'active': return 'On'
    case 'other': return 'Port in use'
    case 'error': return 'Needs attention'
  }
}
