import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

describe('code-intelligence reference virtualization', () => {
  test('uses the shared virtual list with a stable viewport height', () => {
    // WHY: measuring the virtual list through the element it resizes can create
    // a render loop when the ready symbol card opens with many references. The
    // shared list accepts a numeric height, so this feature must use that contract
    // instead of adding another virtualizer or measuring its own list host.
    const component = readFileSync(
      new URL('../../packages/workspace-ui/src/components/code-intel/CodeIntelReferenceList.svelte', import.meta.url),
      'utf8',
    )
    expect(component).toContain('../ui/list-page/VirtualList.svelte')
    expect(component).toContain('height={referenceListHeight}')
    expect(component).not.toContain('bind:clientHeight')
    expect(component).not.toContain('referenceWindow')
  })
})
