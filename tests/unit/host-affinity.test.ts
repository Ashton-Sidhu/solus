import { describe, expect, test } from 'bun:test'
import type { HostReadiness, HostReadinessState } from '@solus/client-core/host-readiness'
import { hostAffinityGlyph } from '@solus/workspace-ui/contexts/connections/host-affinity'
import { Earth as GlobeSimpleIcon } from '@lucide/svelte'
import AppleLogoIcon from '@solus/workspace-ui/components/ui/AppleLogoIcon.svelte'
import LinuxLogoIcon from '@solus/workspace-ui/components/ui/LinuxLogoIcon.svelte'
import WindowsLogoIcon from '@solus/workspace-ui/components/ui/WindowsLogoIcon.svelte'

function state(readiness: HostReadiness): HostReadinessState {
  return { readiness, away: readiness === 'unreachable' || readiness === 'refused' || readiness === 'gone', unreachableReason: readiness === 'unreachable' ? 'no-answer' : null, refusedReason: null, lastSeenAt: null }
}

describe('host affinity badge', () => {
  test('the host you are working on is unmarked', () => {
    // WHY: local is the majority case. A badge "for symmetry" doubles the chrome
    // on every surface and tells the user nothing they didn't already know.
    expect(hostAffinityGlyph({ label: 'This Mac', local: true }, state('ready'))).toBeNull()
    expect(hostAffinityGlyph(null, state('ready'))).toBeNull()
  })

  test('a host that is not ready changes the glyph, not only the colour', () => {
    // WHY: colour alone fails in one theme or the other and for colour-vision
    // deficiency. The one state worth interrupting for has to read by shape.
    const ready = hostAffinityGlyph({ label: 'Studio', local: false }, state('ready'))
    const unreachable = hostAffinityGlyph({ label: 'Studio', local: false }, state('unreachable'))
    expect(unreachable?.icon).not.toBe(ready?.icon)
    expect(unreachable?.statusLabel).toBe('Offline')
  })

  test('remote host badges use the saved operating system icon', () => {
    // WHY: Run On rows and the Environment chip both consume this shared
    // glyph. They must not fall back to a globe once the host reports its OS.
    expect(hostAffinityGlyph({ label: 'Mac', local: false, os: 'macos' }, state('ready'))?.icon).toBe(AppleLogoIcon)
    expect(hostAffinityGlyph({ label: 'PC', local: false, os: 'windows' }, state('ready'))?.icon).toBe(WindowsLogoIcon)
    expect(hostAffinityGlyph({ label: 'Box', local: false, os: 'linux' }, state('ready'))?.icon).toBe(LinuxLogoIcon)
    expect(hostAffinityGlyph({ label: 'Old host', local: false }, state('ready'))?.icon).toBe(GlobeSimpleIcon)
  })

  test('a host inside its grace is not reported as offline', () => {
    // WHY: a host still dialing may answer any moment. Painting it error-red
    // cries wolf before the grace is over.
    const checking = hostAffinityGlyph({ label: 'Bench', local: false }, state('checking'))
    expect(checking?.statusLabel).toBe('Connecting')
    expect(checking?.className).not.toContain('status-error')
  })

  test('the tooltip names the host, because the glyph alone cannot', () => {
    const reconnecting = hostAffinityGlyph({ label: 'Studio', local: false }, state('reconnecting'))
    expect(reconnecting?.tooltip).toBe('Runs on Studio · Reconnecting')
    expect(reconnecting?.className).toContain('animate-pulse')
  })
})
