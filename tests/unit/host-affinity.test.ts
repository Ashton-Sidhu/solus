import { describe, expect, test } from 'bun:test'
import {
  hostAffinityGlyph,
  hostStatusLabel,
} from '../../src/renderer/components/servers/lib/host-affinity'

describe('host affinity badge', () => {
  test('every host surface shares one availability vocabulary', () => {
    // WHY: Connections, the server switcher, and the Run On picker describe the
    // same host state. Synonyms make one host look like it has multiple states.
    expect([
      hostStatusLabel('online'),
      hostStatusLabel('connecting'),
      hostStatusLabel('offline'),
      hostStatusLabel('saved'),
    ]).toEqual(['Online', 'Connecting', 'Offline', 'Not checked'])
  })

  test('the host you are working on is unmarked', () => {
    // WHY: local is the majority case. A badge "for symmetry" doubles the chrome
    // on every surface and tells the user nothing they didn't already know.
    expect(hostAffinityGlyph({ label: 'This Mac', local: true }, 'online')).toBeNull()
    expect(hostAffinityGlyph(null, 'online')).toBeNull()
  })

  test('offline changes the glyph, not only the colour', () => {
    // WHY: colour alone fails in one theme or the other and for colour-vision
    // deficiency. The one state worth interrupting for has to read by shape.
    const online = hostAffinityGlyph({ label: 'Studio', local: false }, 'online')
    const offline = hostAffinityGlyph({ label: 'Studio', local: false }, 'offline')
    expect(offline?.icon).not.toBe(online?.icon)
    expect(offline?.statusLabel).toBe('Offline')
  })

  test('a host nobody has dialled is not reported as offline', () => {
    // WHY: "saved" means unprobed. Painting it error-red cries wolf about a host
    // that may be perfectly reachable.
    const unprobed = hostAffinityGlyph({ label: 'Bench', local: false }, 'saved')
    const offline = hostAffinityGlyph({ label: 'Bench', local: false }, 'offline')
    expect(unprobed?.statusLabel).toBe('Not checked')
    expect(unprobed?.icon).not.toBe(offline?.icon)
    expect(unprobed?.className).not.toContain('status-error')
  })

  test('the tooltip names the host, because the glyph alone cannot', () => {
    const connecting = hostAffinityGlyph({ label: 'Studio', local: false }, 'connecting')
    expect(connecting?.tooltip).toBe('Runs on Studio · Connecting')
    expect(connecting?.className).toContain('animate-pulse')
  })
})
