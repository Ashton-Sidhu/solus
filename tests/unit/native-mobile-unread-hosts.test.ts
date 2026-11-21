import { describe, expect, test } from 'bun:test'
import { unreadHosts } from '../../apps/mobile/src/features/hosts/lib/unread-hosts'

// plans/033 §3 Q2: the phone keeps no copy of the host list or the directory, so
// each host picker says which read it waits for, or which read failed, with Try
// again, as the desktop and web pickers do (`serversStore.unreadHosts`).

describe('the reads a mobile host picker waits for', () => {
  test('both reads answered: the picker shows only its hosts', () => {
    expect(unreadHosts('ready', 'ready')).toEqual([])
  })

  test('before the first reads, the picker says it is reading the list and Solus Cloud', () => {
    expect(unreadHosts('loading', 'loading')).toEqual([
      { answer: 'list', state: 'loading', text: 'Reading your host list…' },
      { answer: 'directory', state: 'loading', text: 'Reading Solus Cloud…' },
    ])
  })

  test('a failed read is named, so Try again reads only that answer', () => {
    // WHY: a picker that hides a failed read looks like the person has no hosts.
    expect(unreadHosts('ready', 'failed')).toEqual([{ answer: 'directory', state: 'failed', text: 'Solus Cloud could not be read' }])
    expect(unreadHosts('failed', 'ready')).toEqual([{ answer: 'list', state: 'failed', text: 'Your host list could not be read' }])
  })
})
