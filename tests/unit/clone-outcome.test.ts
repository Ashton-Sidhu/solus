import { describe, expect, test } from 'bun:test'
import {
  classifyCloneFailure,
  pushCapabilityNote,
} from '../../src/renderer/components/servers/lib/clone-outcome'

describe('clone failure classification', () => {
  test('an occupied destination is offered as a folder to use, not an error to read', () => {
    // WHY: the folder sitting there is almost always the very checkout being
    // asked for. Naming this case is what turns the dead end into one click.
    const failure = classifyCloneFailure(
      '/srv/projects/solus already exists and is not empty. Choose another folder or remove it first.',
      'Studio',
    )
    expect(failure.kind).toBe('occupied')
    expect(failure.title).toContain('Studio')
  })

  test('every dialect of "you are not allowed in" reads as a credentials problem', () => {
    // WHY: a private repo the host can't see comes back as a plain 404, and the
    // SSH and HTTPS paths each phrase refusal differently. All three are the
    // same actionable fix: give this host credentials.
    for (const message of [
      'fatal: Authentication failed for https://github.com/acme/private.git',
      'fatal: could not read Username for https://github.com: terminal prompts disabled',
      'git@github.com: Permission denied (publickey).',
      'ERROR: Repository not found.',
    ]) {
      expect(classifyCloneFailure(message, 'Studio').kind).toBe('auth')
    }
  })

  test('an unfamiliar failure keeps the host’s own words', () => {
    // WHY: paraphrasing a failure nobody anticipated hides the only clue there is.
    const failure = classifyCloneFailure('fatal: the remote end hung up unexpectedly', 'Studio')
    expect(failure.kind).toBe('other')
    expect(failure.detail).toBe('fatal: the remote end hung up unexpectedly')
  })
})

describe('push capability', () => {
  test('an anonymous clone is flagged at clone time, not at PR time', () => {
    // WHY: a public repo clones with no credentials at all, so the session runs
    // for 25 minutes and then fails at the push. This is the whole reason the
    // clone reports how it authenticated.
    expect(pushCapabilityNote('anonymous', 'Studio')).toContain('can’t push')
  })

  test('a clone that used credentials says nothing', () => {
    expect(pushCapabilityNote('ssh', 'Studio')).toBeNull()
    expect(pushCapabilityNote('token', 'Studio')).toBeNull()
  })
})
