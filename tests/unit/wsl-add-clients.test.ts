import { describe, expect, test } from 'bun:test'
import type { ForwardedHost, SshAddResult, WslDistro } from '@solus/contracts/remote-machines'
import { unaddedDistros } from '@solus/client-core/wsl-distros'
import { wslAddOutcome as webOutcome, wslBridgePhase } from '@solus/workspace-ui/components/servers/lib/add-wsl-distro'
import { distroNote, wslAddOutcome as mobileOutcome } from '../../apps/mobile/src/features/hosts/lib/wsl-add'

// Adding a WSL distro from desktop, web, and the phone (docs/plans/windows.md §13.6).

const distros: WslDistro[] = [
  { name: 'docker-desktop', isDefault: false, isRunning: false, version: 2 },
  { name: 'Ubuntu', isDefault: true, isRunning: true, version: 2 },
]
const host = { installationId: 'inst-wsl', label: 'Ubuntu (WSL)' } as ForwardedHost
const forwarded: SshAddResult = { status: 'forwarded', host, sessionToken: 'tok' }

describe('every client', () => {
  test('offers only the distros the Windows host does not reach yet', () => {
    // WHY: a distro the host forwards to is a host already; offering it again would install a second copy.
    expect(unaddedDistros(distros, []).map((distro) => distro.name)).toEqual(['docker-desktop', 'Ubuntu'])
    expect(unaddedDistros(distros, [{ sshTarget: 'wsl:Ubuntu' }]).map((distro) => distro.name)).toEqual(['docker-desktop'])
    // A machine over SSH that happens to share the name is not the distro.
    expect(unaddedDistros(distros, [{ sshTarget: 'Ubuntu' }])).toHaveLength(2)
  })

  test('desktop saves the distro it forwards to; another client is told only the Windows host reaches it', () => {
    // WHY: a forward is a loopback port on the Windows host; only that machine can dial it.
    expect(webOutcome(forwarded, true, 'DESKTOP-PC').kind).toBe('save-forwarded')
    expect(webOutcome(forwarded, false, 'DESKTOP-PC')).toEqual({ kind: 'forwarded-elsewhere', message: 'Ubuntu (WSL) is added. It is reachable only from DESKTOP-PC, which lists it.' })
    expect(mobileOutcome(forwarded, 'DESKTOP-PC')).toMatchObject({ kind: 'forwarded', note: expect.stringContaining('only from DESKTOP-PC') })
  })

  test('names the version and the default in a distro row', () => {
    expect(distroNote(distros[1])).toBe('Default · WSL 2')
  })
})

describe('the add in the add-host dialog', () => {
  test('draws the bridge any host add draws, from the add to the added host', () => {
    // WHY: a WSL distro is one more host to add; it must not look like a different flow.
    expect(wslBridgePhase('running')).toBe('pairing')
    expect(wslBridgePhase('failed')).toBe('error')
    expect(wslBridgePhase('done')).toBe('paired')
  })
})
