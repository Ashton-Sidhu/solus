import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

/**
 * Every row of a session's background work (the work the agent started, an
 * MCP task, a resource watch) stops the same way and in the same place. Two
 * copies of the Stop button already drifted once: only one of them had the
 * touch target, so the same control was harder to hit on one row.
 */

const source = (name: string) => readFileSync(new URL(`../../packages/workspace-ui/src/components/conversation/${name}.svelte`, import.meta.url), 'utf8')

test('each background row draws its Stop with the one shared button', () => {
  for (const row of ['BackgroundWorkRow', 'BackgroundItemRow']) {
    const markup = source(row)
    expect(markup).toContain('<BackgroundStopButton')
    // A row with its own stop icon has its own copy of the button.
    expect(markup).not.toContain('Square as StopIcon')
  }
})

test('the shared Stop has the touch target on a coarse pointer', () => {
  expect(source('BackgroundStopButton')).toContain('pointer-coarse:tap-area')
})
