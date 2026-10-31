import { expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { compile } from 'svelte/compiler'
import { render } from 'svelte/server'

// A pending search can have no cached rows. It must say that it is loading,
// then show the empty state only after the request has finished.
test('the PR list distinguishes pending, empty, and populated answers', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'solus-pr-loading-'))
  const root = new URL('../../', import.meta.url)
  const internal = new URL('node_modules/svelte/src/internal/server/index.js', root).href
  const writeComponent = (name: string, source: string, imports: Map<string, string> = new Map()) => {
    let code = compile(source, { generate: 'server' }).js.code
      .replaceAll(/(['"])svelte\/internal\/server\1/g, JSON.stringify(internal))
    for (const [from, to] of imports) code = code.replaceAll(JSON.stringify(from), JSON.stringify(to)).replaceAll(`'${from}'`, JSON.stringify(to))
    const path = join(directory, `${name}.mjs`)
    writeFileSync(path, code)
    return pathToFileURL(path).href
  }
  try {
    const stub = writeComponent('stub', '<script>let {title, children} = $props();</script><p>{title ?? ""}</p>{@render children?.()}')
    const loading = writeComponent('loading', readFileSync(new URL('packages/workspace-ui/src/components/prs/PrListLoading.svelte', root), 'utf8'))
    const icons = pathToFileURL(join(directory, 'icons.mjs')).href
    writeFileSync(new URL(icons), 'export const CircleAlert = null, GitPullRequest = null, RefreshCw = null;')
    const button = pathToFileURL(join(directory, 'button.mjs')).href
    writeFileSync(new URL(button), `export { default as Button } from ${JSON.stringify(stub)};`)
    const errors = pathToFileURL(join(directory, 'errors.mjs')).href
    writeFileSync(new URL(errors), 'export const prUnavailableTitle = () => "Unavailable";')
    const states = writeComponent('states', readFileSync(new URL('packages/workspace-ui/src/components/prs/PrListStates.svelte', root), 'utf8'), new Map([
      ['@lucide/svelte', icons], ['../ui/button', button], ['../ui/PageEmpty.svelte', stub],
      ['./GithubConnectionRequired.svelte', stub], ['./PrListLoading.svelte', loading], ['./lib/pr-surface-error', errors],
    ]))
    const harness = writeComponent('harness', `<script>import States from 'STATES'; let { loading, hasItems } = $props();</script>
      <States allProjects={true} hasScope={true} scopeError={null} scopeLabel={null} serverId={null}
        projectsFailure={{kind: 'none'}} {loading} {hasItems} onRetry={() => {}} onShowAll={() => {}}>
        Existing pull requests
      </States>`, new Map([['STATES', states]]))
    const { default: Harness } = await import(harness)
    const pending = render(Harness, { props: { loading: true, hasItems: false } }).body
    expect(pending).toContain('Loading pull requests')
    expect(pending).not.toContain('No pull requests yet.')
    expect(pending).not.toContain('Large repositories can take longer')
    const empty = render(Harness, { props: { loading: false, hasItems: false } }).body
    expect(empty).toContain('No pull requests yet.')
    expect(empty).not.toContain('Loading pull requests')
    const refreshing = render(Harness, { props: { loading: true, hasItems: true } }).body
    expect(refreshing).toContain('Existing pull requests')
    expect(refreshing).not.toContain('No pull requests yet.')
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
