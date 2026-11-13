import { describe, expect, test } from 'bun:test'
import { sshConfigHostCandidates, type SshConfigEntry } from '@solus/server/remote-machines/ssh-targets'

// WHY: docs/plans/host-fleet.md D7. Discover lists the machines in the owner's
// ~/.ssh/config as machines to add over SSH. A pattern names no machine and a git
// host is not one, so neither may show up as something to add.

describe('the machines ~/.ssh/config names', () => {
  test('each entry is one target, with its user and port, named by its first plain alias', () => {
    const entries: SshConfigEntry[] = [
      { hosts: ['devbox', 'devbox-alt'], hostname: 'devbox.internal', user: 'ada' },
      { hosts: ['pi'], port: 2222 },
    ]
    expect(sshConfigHostCandidates(entries)).toEqual([
      { target: 'ada@devbox', label: 'devbox -> devbox.internal', source: 'ssh-config' },
      { target: 'pi:2222', label: 'pi', source: 'ssh-config' },
    ])
  })

  test('a pattern entry and a git host are not machines', () => {
    const entries: SshConfigEntry[] = [
      { hosts: ['*'], user: 'ada' },
      { hosts: ['*.corp', 'jump-?'] },
      { hosts: ['github.com'], user: 'git' },
      { hosts: ['work-git'], hostname: 'GitHub.com', user: 'git' },
      { hosts: ['build'] },
    ]
    expect(sshConfigHostCandidates(entries).map((candidate) => candidate.target)).toEqual(['build'])
  })

  test('two entries that name the same target list it once', () => {
    expect(sshConfigHostCandidates([{ hosts: ['box'] }, { hosts: ['box'] }])).toHaveLength(1)
  })
})
