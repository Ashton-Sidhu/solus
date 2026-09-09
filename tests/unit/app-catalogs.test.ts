import { expect, test } from 'bun:test'
import { normalizeHostCapabilities } from '@solus/client-core/host-capabilities'
import { EDITOR_IDS } from '@solus/contracts/types'

test('the client keeps every editor id a host can advertise', () => {
  // WHY: this is the bug that shipped. A second hand-written copy of the id
  // list validated the host's capability advertisement and silently dropped
  // every id it had not heard of, so newly added editors reached the host and
  // never the Settings dropdown — with no error anywhere.
  const normalized = normalizeHostCapabilities({ editors: [...EDITOR_IDS] })

  expect(normalized.editors).toEqual([...EDITOR_IDS])
})

test('still drops an id from a newer host rather than blanking the record', () => {
  const normalized = normalizeHostCapabilities({ editors: ['vscode', 'editor-from-the-future'] })

  expect(normalized.editors).toEqual(['vscode'])
})
