import { expect, test } from 'bun:test'
import { JSDOM } from 'jsdom'
import { revealActiveOutlineRow } from '@solus/workspace-ui/components/document-shell/lib/outline-scroll'

test('following a distant section scrolls only the outline and leaves visible rows still', () => {
  const { window } = new JSDOM('<main><nav><button data-active="true">Section</button></nav></main>')
  const container = window.document.querySelector('nav')!
  const row = window.document.querySelector('button')!
  const documentPane = window.document.querySelector('main')!
  Object.defineProperty(container, 'clientHeight', { value: 300 })
  container.getBoundingClientRect = () => new window.DOMRect(0, 100, 200, 300)
  row.getBoundingClientRect = () => new window.DOMRect(0, 600, 200, 30)
  documentPane.scrollTop = 800

  revealActiveOutlineRow(container)
  expect(container.scrollTop).toBe(230)
  expect(documentPane.scrollTop).toBe(800)

  row.getBoundingClientRect = () => new window.DOMRect(0, 150, 200, 30)
  revealActiveOutlineRow(container)
  expect(container.scrollTop).toBe(230)

  row.getBoundingClientRect = () => new window.DOMRect(0, 50, 200, 30)
  revealActiveOutlineRow(container)
  expect(container.scrollTop).toBe(180)
  window.close()
})

test('hidden mounted outlines do not change their scroll position', () => {
  const { window } = new JSDOM('<nav><button data-active="true">Section</button></nav>')
  const container = window.document.querySelector('nav')!
  container.scrollTop = 120
  revealActiveOutlineRow(container)
  expect(container.scrollTop).toBe(120)
  revealActiveOutlineRow(undefined)
  window.close()
})
