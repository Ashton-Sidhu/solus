import { describe, expect, test } from 'bun:test'
import type { ForwardedHost, SshAddResult, WslDistro } from '@solus/contracts/remote-machines'
import { defaultDistro as webDefaultDistro, wslAddOutcome as webOutcome } from '@solus/workspace-ui/components/servers/lib/add-wsl-distro'
import { defaultDistro as mobileDefaultDistro, distroNote, wslAddOutcome as mobileOutcome } from '../../apps/mobile/src/features/hosts/lib/wsl-add'

// Adding a WSL distro from desktop, web, and the phone (docs/plans/windows.md §13.6).

const distros: WslDistro[] = [
  { name: 'docker-desktop', isDefault: false, isRunning: false, version: 2 },
  { name: 'Ubuntu', isDefault: true, isRunning: true, version: 2 },
]
const host = { installationId: 'inst-wsl', label: 'Ubuntu (WSL)' } as ForwardedHost
const forwarded: SshAddResult = { status: 'forwarded', host, sessionToken: 'tok' }

describe('every client', () => {
  test('preselects the distro wsl runs by default', () => {
    expect(webDefaultDistro(distros)).toBe('Ubuntu')
    expect(mobileDefaultDistro(distros)).toBe('Ubuntu')
    expect(mobileDefaultDistro([])).toBeNull()
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
