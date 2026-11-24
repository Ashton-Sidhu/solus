import { expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { JSDOM } from 'jsdom'
import { compile } from 'svelte/compiler'
import { render } from 'svelte/server'
import type { ActivityEvent } from '@solus/workspace-ui/components/pr-review/lib/activity-data'

test('screen readers can find PR reviews and comments by heading in Activity', async () => {
  const root = new URL('../../', import.meta.url)
  const components = new URL('packages/workspace-ui/src/components/', root)
  const directory = mkdtempSync(join(import.meta.dir, '.pr-headings-'))
  const libraries = new Map([
    ['../ui/octicons', 'icons.mjs'],
    ['@lucide/svelte', 'icons.mjs'],
    ['../ui/button', 'controls.mjs'],
    ['../ui/skeleton', 'controls.mjs'],
    ['../ui/comment-composer', 'controls.mjs'],
    ['@solus/workspace-ui/components/ui/tooltip', 'tooltip.mjs'],
    ['../../lib/inputFocus', 'interaction.mjs'],
    ['../../lib/toasts', 'interaction.mjs'],
  ])
  const write = (name: string, source: string) => writeFileSync(join(directory, name), source)
  const compileComponent = (path: string) => {
    const source = new URL(path, components)
    const output = compile(readFileSync(source, 'utf8'), { generate: 'server' }).js.code
    write(path.split('/').at(-1)!.replace('.svelte', '.mjs'), output.replace(/(['"])([^'"]+)\1/g, (literal, _quote, specifier: string) => {
      if (libraries.has(specifier)) return JSON.stringify(`./${libraries.get(specifier)}`)
      if (specifier === './PrThreadCard.svelte' || specifier === '../prs/PrReviewStateBadge.svelte') {
        return JSON.stringify(`./${specifier.split('/').at(-1)?.replace('.svelte', '.mjs')}`)
      }
      if (specifier.endsWith('.svelte')) return '"./empty.mjs"'
      if (specifier.startsWith('./lib/') || specifier.startsWith('../../lib/')) {
        return JSON.stringify(new URL(`${specifier}.ts`, source).href)
      }
      return literal
    }))
  }
  try {
    write('empty.mjs', 'export default () => {}')
    write('interaction.mjs', 'export const requestInputFocus = () => {}, toasts = {}')
    const icons = [
      'GitPullRequestIcon', 'ChevronDown', 'ChevronRight', 'ChevronUp', 'Circle', 'CircleAlert',
      'CircleCheck', 'CircleDashed', 'CircleMinus', 'Ellipsis', 'MessageCircle', 'GitCommitHorizontal',
      'LayoutTemplate', 'LoaderCircle', 'RefreshCcw', 'Reply', 'Tag', 'Trash2',
    ]
    write('icons.mjs', icons.map((name) => `export const ${name} = () => {}`).join('\n'))
    write('controls.mjs', 'export const Button = () => {}, Skeleton = () => {}, CommentComposer = () => {}')
    write('tooltip.mjs', 'export const Root = (r, p) => p.children(r), Trigger = (r, p) => p.child(r, { props: {} }), Content = () => {}')
    compileComponent('prs/PrReviewStateBadge.svelte')
    compileComponent('pr-review/PrThreadCard.svelte')
    compileComponent('pr-review/ActivityTimeline.svelte')
    const { default: Timeline } = await import(pathToFileURL(join(directory, 'ActivityTimeline.mjs')).href)
    const createdAt = '2026-01-01T12:00:00Z'
    const ts = Date.parse(createdAt)
    const events: ActivityEvent[] = [
      { kind: 'comment', ts, comment: { id: '1', kind: 'comment', author: 'Alice', body: 'Looks good', createdAt }, threads: [] },
      { kind: 'comment', ts, comment: { id: '2', kind: 'review', author: 'Bob', reviewState: 'APPROVED', body: '', createdAt }, threads: [] },
      { kind: 'thread', ts, thread: {
        id: '3', filePath: 'src/example.ts', line: 4, side: 'RIGHT', isResolved: true, isOutdated: false,
        comments: [{ id: '4', author: 'Carol', body: 'Fixed', createdAt }],
      } },
      { kind: 'commits', ts, commits: [{ sha: 'abc', author: 'Dana', message: 'A commit', committedAt: createdAt }] },
    ]
    const html = render(Timeline, {
      props: { events, authorName: 'Owner', openedAt: null, viewerLogin: '', deletingCommentIds: new Set() },
    }).body
    const dom = new JSDOM(html)
    const headings = Array.from(dom.window.document.querySelectorAll('h3, h4'), (element) => element.textContent.trim())
    expect(headings).toHaveLength(3)
    expect(headings[0]).toMatch(/^Alice\s*commented/)
    expect(headings[1]).toMatch(/^Bob\s*reviewed.*Approved/s)
    expect(headings[2]).toMatch(/^Carol\s+commented on/)
    expect(dom.window.document.querySelector('h3 button[aria-expanded="false"]')).not.toBeNull()
  } finally {
    rmSync(directory, { force: true, recursive: true })
  }
})
