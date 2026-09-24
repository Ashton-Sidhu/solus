import { describe, expect, test } from 'bun:test'
import { findCardPercentWidths } from '../../scripts/check-layout-discipline'

const PATH = 'packages/workspace-ui/src/components/conversation/Card.svelte'

describe('card-percent-width', () => {
  test('rejects a card centred at a percentage of the column', () => {
    const failures = findCardPercentWidths('<div class="card mx-auto w-[88%] rounded-2xl"></div>', PATH)
    expect(failures.map((failure) => failure.rule)).toEqual(['card-percent-width'])
  })

  test('accepts a full-width card and an inner percentage bar', () => {
    const source = '<div class="tx-card w-full"><span class="h-1 w-[70%]"></span></div>'
    expect(findCardPercentWidths(source, PATH)).toEqual([])
  })

  test('ignores a percentage width behind a breakpoint, which is not a centred card', () => {
    const source = '<div class="mx-auto md:w-[88%]"></div>'
    expect(findCardPercentWidths(source, PATH)).toEqual([])
  })
})
