import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'

const webAppSource = readFileSync(join(import.meta.dir, '../../client/src/App.svelte'), 'utf8')

describe('tab refresh restoration', () => {
  test('the web snapshot persists the selected session tab', () => {
    expect(webAppSource).toContain('activeTabId: session.activeTabId')
    expect(webAppSource).not.toContain('activeTabId: session.durableActiveTabId')
  })
})
