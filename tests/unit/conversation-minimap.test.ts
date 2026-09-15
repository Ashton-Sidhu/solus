import { describe, expect, test } from 'bun:test'
import { JSDOM } from 'jsdom'
import { createNavItemBuilder, indexMinimapNodes, pickActiveIndex } from '@solus/workspace-ui/components/conversation/lib/minimap'

describe('conversation minimap active marker', () => {
  test('moves through mounted rows after an unmounted transcript prefix', () => {
    // WHY: the transcript keeps all prompts in the rail but mounts only its
    // tail. Missing prefix nodes are above the viewport, not below the active
    // line; treating them as below leaves the first marker active forever.
    const tops: Array<number | null> = [null, null, -40, 60, 180]
    expect(pickActiveIndex(tops.length, (index) => tops[index], 2)).toBe(3)
  })

  test('stops before missing rows after the mounted window', () => {
    const tops: Array<number | null> = [null, -40, 180, null]
    expect(pickActiveIndex(tops.length, (index) => tops[index], 1)).toBe(1)
  })

  test('scroll reads are bounded by mounted rows, not historical prompts', () => {
    const dom = new JSDOM('<main><div data-nav-msg-id="500"></div><div data-nav-msg-id="501"></div></main>')
    const container = dom.window.document.querySelector('main')!
    const items = Array.from({ length: 502 }, (_, i) => ({ id: String(i), preview: '' }))
    const index = indexMinimapNodes(container, items)
    let reads = 0
    for (let frame = 0; frame < 10; frame++) {
      const active = pickActiveIndex(items.length, (i) => {
        reads++
        return index.nodes.has(items[i].id) ? (i === 500 ? 20 : 180) : null
      }, index.firstMountedIndex)
      expect(active).toBe(500)
    }
    expect(reads).toBe(20)
    dom.window.close()
  })

  test('paging rebuilds missing nodes even when the navigation list is unchanged', () => {
    const dom = new JSDOM('<main><div data-nav-msg-id="tail"></div></main>')
    const container = dom.window.document.querySelector('main')!
    const items = [{ id: 'older', preview: '' }, { id: 'tail', preview: '' }]
    const before = indexMinimapNodes(container, items)
    expect(before.firstMountedIndex).toBe(1)
    expect(before.nodes.has('older')).toBe(false)
    container.insertAdjacentHTML('afterbegin', '<div data-nav-msg-id="older"></div>')
    const after = indexMinimapNodes(container, items)
    expect(after.firstMountedIndex).toBe(0)
    expect(after.nodes.get('older')?.isConnected).toBe(true)
    dom.window.close()
  })
})

describe('minimap nav item builder', () => {
  const userMessage = (id: string, content: string) => ({ id, role: 'user', content })

  test('hands back the same array when only non-user rows arrive', () => {
    // WHY: the component re-indexes every mounted transcript row whenever
    // `items` changes identity. A turn appends a tool row per call, so a
    // fresh-but-equal array makes a long turn re-walk the DOM once per row.
    const build = createNavItemBuilder()
    const first = userMessage('u1', 'do the thing')
    const before = build([first])
    const after = build([first, { id: 't1', role: 'tool', content: 'ran' }])
    expect(after).toBe(before)
  })

  test('reuses a preview rather than re-deriving it per rebuild', () => {
    const build = createNavItemBuilder()
    const first = userMessage('u1', '  spread   out  ')
    const before = build([first])
    const after = build([first, userMessage('u2', 'second')])
    expect(after[0]).toBe(before[0])
    expect(after[0]?.preview).toBe('spread out')
  })

  test('rebuilds when a user row is added', () => {
    const build = createNavItemBuilder()
    const first = userMessage('u1', 'one')
    const before = build([first])
    const after = build([first, userMessage('u2', 'two')])
    expect(after).not.toBe(before)
    expect(after.map((item) => item.id)).toEqual(['u1', 'u2'])
  })

  test('rebuilds when a user row is removed', () => {
    const build = createNavItemBuilder()
    const first = userMessage('u1', 'one')
    const second = userMessage('u2', 'two')
    const before = build([first, second])
    const after = build([first])
    expect(after).not.toBe(before)
    expect(after).toHaveLength(1)
  })

  test('re-derives the preview when an existing message is edited', () => {
    // An edit keeps the row's identity, so identity alone cannot decide this.
    const build = createNavItemBuilder()
    const message = { id: 'u1', role: 'user', content: 'before' }
    expect(build([message])[0]?.preview).toBe('before')
    message.content = 'after'
    expect(build([message])[0]?.preview).toBe('after')
  })
})
