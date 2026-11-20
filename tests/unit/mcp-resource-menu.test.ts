import { describe, expect, test } from 'bun:test'
import { findAnchor, readTrigger } from '@solus/workspace-ui/components/editor/unified-autocomplete/trigger'
import { buildRows, fileMenuItem, resourceMenuItem, type RowInput } from '@solus/workspace-ui/components/editor/unified-autocomplete/rows'

/** The `@` menu's MCP resource band; the controller is left out because it needs the workspace. */
function input(text: string, overrides: Partial<RowInput> = {}): RowInput {
  const trigger = readTrigger(text, findAnchor(text))
  if (!trigger) throw new Error(`no trigger in ${text}`)
  const empty = { plan: [], doc: [], pr: [], session: [], task: [], automation: [], host: [] }
  return { trigger, commands: [], openFiles: [], worktreeFiles: [], worktreeFileCount: null, byKind: empty, linked: [], linkedLabel: '', counts: { plan: 0, doc: 0, pr: 0, session: 0, task: 0, automation: 0, host: 0 }, ...overrides }
}

describe('MCP resources under @ (mcp-first-class.md §11.3)', () => {
  const docs = { name: 'Docs', slug: 'docs' }
  const wiki = { name: 'Wiki', slug: 'wiki' }
  const resources = [
    resourceMenuItem({ integrationId: 'int-docs', uri: 'docs://notes', name: 'notes', title: 'Release notes' }, docs),
    resourceMenuItem({ integrationId: 'int-docs', uri: 'docs://spec', name: 'spec' }, docs),
    resourceMenuItem({ integrationId: 'int-wiki', uri: 'wiki://home', name: 'home' }, wiki),
  ]
  const labels = (rows: ReturnType<typeof buildRows>) => rows.filter((row) => row.type === 'label').map((row) => row.label)
  const titles = (rows: ReturnType<typeof buildRows>) => rows.flatMap((row) => (row.type === 'item' ? [row.item.title] : []))

  test('a matching resource shows under its own band after the files', () => {
    const rows = buildRows(input('@spec', {
      worktreeFiles: [fileMenuItem('spec.md', false)],
      mcpResources: resources,
    }))
    expect(labels(rows)).toEqual(['Files', 'MCP resources'])
    expect(titles(rows)).toEqual(['spec.md', 'spec'])
  })

  test('a URI matches, and no resource band shows when none matches', () => {
    expect(titles(buildRows(input('@wiki://', { mcpResources: resources })))).toEqual(['home'])
    expect(labels(buildRows(input('@zzz', { mcpResources: resources })))).toEqual([])
  })

  test('@<slug>: lists only that server', () => {
    const rows = buildRows(input('@docs:', { mcpResources: resources }))
    expect(titles(rows)).toEqual(['Release notes', 'spec'])
    expect(titles(buildRows(input('@docs:spe', { mcpResources: resources })))).toEqual(['spec'])
  })

  test('a slug no server has is an ordinary file query', () => {
    const rows = buildRows(input('@src:', { mcpResources: resources }))
    expect(rows.some((row) => row.type === 'item' && row.item.resource)).toBe(false)
  })
})
