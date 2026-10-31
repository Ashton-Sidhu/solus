import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { parse } from 'svelte/compiler'

const source = readFileSync(new URL('../../packages/workspace-ui/src/components/workspace/WorkspacePage.svelte', import.meta.url), 'utf8')
const ast = parse(source, { modern: true })

// Run the callback passed to each card. Selection must change before opening,
// so the highlight and the next keyboard action use the card just clicked.
function cardOpener(snippetName: string) {
  const snippet = ast.fragment.nodes.find((node) => node.type === 'SnippetBlock' && node.expression.name === snippetName)
  if (!snippet || snippet.type !== 'SnippetBlock') throw new Error(`Missing ${snippetName}`)
  const card = snippet.body.nodes.find((node) => node.type === 'Component')
  if (!card || card.type !== 'Component') throw new Error('Missing card')
  const attribute = card.attributes.find((attribute) => attribute.type === 'Attribute' && attribute.name === 'onOpen')
  if (!attribute || attribute.type !== 'Attribute' || typeof attribute.value !== 'object' || Array.isArray(attribute.value) || attribute.value.type !== 'ExpressionTag') {
    throw new Error('Missing card opener')
  }
  const expression = attribute.value.expression
  return new Function('ledger', 'index', 'item', 'stacked', 'isHtmlArtifact', 'peek', 'openItem', 'openSharedSession', `return (${source.slice(expression.start, expression.end)})`)
}

for (const scenario of [
  { name: 'a work in a wide pane', snippet: 'workCard', stacked: false, html: false, action: 'open' },
  { name: 'a document preview in a narrow pane', snippet: 'workCard', stacked: true, html: false, action: 'peek' },
  { name: 'an HTML artifact in a narrow pane', snippet: 'workCard', stacked: true, html: true, action: 'open' },
  { name: 'a shared session', snippet: 'sessionCard', stacked: false, html: false, action: 'session' },
]) {
  test(`clicking ${scenario.name} selects it before opening`, () => {
    const ledger = { selectedIndex: 0 }
    const item = { id: 'clicked' }
    const actions: string[] = []
    const open = (action: string) => (opened: typeof item) => {
      expect(ledger.selectedIndex).toBe(3)
      expect(opened).toBe(item)
      actions.push(action)
    }
    const click = cardOpener(scenario.snippet)(
      ledger, 3, item, scenario.stacked, () => scenario.html,
      { raise: open('peek') }, open('open'), open('session'),
    )
    click()
    expect(ledger.selectedIndex).toBe(3)
    expect(actions).toEqual([scenario.action])
  })
}
