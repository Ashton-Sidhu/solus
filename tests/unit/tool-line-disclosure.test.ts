import { expect, test } from 'bun:test'
import { SvelteRunes } from './helpers/svelte-runes'

test('several tool lines of one group stay open together, beside the conversation view state', async () => {
  // WHY: one open line per group meant the person could not compare the images
  // of two calls. The open lines belong to the conversation's disclosure, which
  // `ConversationViewState` owns, not to the mounted row, so they are there
  // again after a tab switch.
  const runes = new SvelteRunes()
  try {
    const disclosurePath = runes.source('disclosure', 'packages/workspace-ui/src/components/conversation/lib/transcript-disclosure.svelte.ts')
    const linesPath = runes.source('open-tool-lines', 'packages/workspace-ui/src/components/conversation/lib/open-tool-lines.ts', {
      'svelte/reactivity': SvelteRunes.file('node_modules/svelte/src/reactivity/index-client.js'),
    })
    const { TranscriptDisclosure } = await import(disclosurePath)
    const { openToolLines, openToolLine, toolGroupKey } = await import(linesPath)
    const disclosure = new TranscriptDisclosure()
    const lines = openToolLines(disclosure, toolGroupKey('t1'))
    lines.add('t1')
    lines.add('t2')
    // A row mounted again reads the same lines from the same disclosure.
    expect([...openToolLines(disclosure, toolGroupKey('t1'))]).toEqual(['t1', 't2'])
    lines.delete('t1')
    expect(openToolLines(disclosure, toolGroupKey('t1')).has('t2')).toBe(true)
    // Another conversation has its own lines.
    expect(openToolLines(new TranscriptDisclosure(), toolGroupKey('t1')).size).toBe(0)

    // A strip chip opens the folded group and the line of its call.
    openToolLine(disclosure, toolGroupKey('t9'), 't10')
    expect(disclosure.forKey(toolGroupKey('t9')).expanded).toBe(true)
    expect([...openToolLines(disclosure, toolGroupKey('t9'))]).toEqual(['t10'])
  } finally {
    runes.dispose()
  }
})
