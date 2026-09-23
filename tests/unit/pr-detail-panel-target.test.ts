import { expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { compile } from 'svelte/compiler'

// The review below the PRs page's detail panel loads its Activity — checks
// included — each time its `target` changes. A detail read gives the pull
// request's `baseRepo` a new object with the same values, so a `target` that
// followed that object restarted the load on every read, which read the detail
// again: the checks RPC ran without end. And the panel's `ctx` is rebuilt on
// every event of the active tab, which must not ask the host for the review
// again while the first request is still on its way.
test('the detail panel reloads the review only when the pull request changes', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'solus-pr-detail-panel-'))
  const root = new URL('../../', import.meta.url)
  const client = new URL('node_modules/svelte/src/index-client.js', root).href
  const internal = new URL('node_modules/svelte/src/internal/client/index.js', root).href
  const reactivity = new URL('node_modules/svelte/src/reactivity/index-client.js', root).href
  const toModule = (source: string, imports: Record<string, string> = {}): string => {
    let code = compile(source, { generate: 'client', dev: false }).js.code
      .replaceAll(/(['"])svelte\/internal\/client\1/g, JSON.stringify(internal))
      .replaceAll(/(['"])svelte\/reactivity\1/g, JSON.stringify(reactivity))
      .replaceAll(/(['"])svelte\1/g, JSON.stringify(client))
      .replaceAll(/import ['"]svelte\/internal\/disclose-version['"];?/g, '')
    for (const [from, to] of Object.entries(imports)) {
      code = code.replaceAll(`'${from}'`, JSON.stringify(to)).replaceAll(JSON.stringify(from), JSON.stringify(to))
    }
    return code
  }
  const write = (name: string, code: string): string => {
    const path = join(directory, name)
    writeFileSync(path, code)
    return path
  }
  try {
    // Stands in for PrReviewPane, keyed on `target` the way its Activity tab is.
    const reviewPane = write('review-pane.mjs', toModule(`<script>
      let { target } = $props();
      $effect(() => { void target.number; globalThis.targetLoads++; });
    </script>`))
    const contexts = write('contexts.mjs', 'export const getWorkspaceContext = () => globalThis.workspace;')
    const toasts = write('toasts.mjs', 'export const toasts = { error() {} };')
    const surfaceError = write('surface-error.mjs', "export const prSurfaceError = () => ({ kind: 'other' });")
    const panelSource = readFileSync(new URL('packages/workspace-ui/src/components/prs/PrDetailPanel.svelte', root), 'utf8')
    const panel = write('panel.mjs', toModule(panelSource, {
      '../../contexts': contexts,
      '../../lib/toasts': toasts,
      './lib/pr-surface-error': surfaceError,
      '../pr-review/PrReviewPane.svelte': reviewPane,
    }))
    const harness = write('harness.mjs', toModule(`<script>
      import Panel from 'PANEL';
      let { control } = $props();
      let baseRepo = $state({ host: 'github.com', owner: 'acme', repo: 'app' });
      let ctx = $state({ session: { projectPath: '/repo' } });
      control.setBaseRepo = (next) => (baseRepo = next);
      control.setCtx = (next) => (ctx = next);
    </script>
    <Panel number={7} api={{}} serverId="s1" {ctx} title="Fix" {baseRepo} fullScreen={false} onClose={() => {}} onStep={() => {}} />`, { PANEL: panel }))
    const runner = write('run.mjs', `
      import assert from 'node:assert/strict';
      import { JSDOM } from ${JSON.stringify(new URL('node_modules/jsdom/lib/api.js', root).href)};
      const dom = new JSDOM('<!doctype html><body></body>');
      for (const key of ['window', 'document', 'Node', 'Element', 'HTMLElement', 'Text', 'Comment', 'Event', 'MutationObserver', 'getComputedStyle', 'navigator']) globalThis[key] = dom.window[key];
      const { flushSync, mount, unmount } = await import(${JSON.stringify(client)});
      const { default: Harness } = await import(${JSON.stringify(harness)});
      globalThis.targetLoads = 0;
      let prepareCalls = 0;
      globalThis.workspace = {
        tabOrder: [],
        sessionFor: () => undefined,
        prReview: { preparePrReview: () => { prepareCalls++; return new Promise(() => {}); } },
      };
      const control = {};
      const app = mount(Harness, { target: document.body, props: { control } });
      flushSync();
      assert.equal(globalThis.targetLoads, 1);
      assert.equal(prepareCalls, 1);

      // A detail read: the same repository, as a new object.
      control.setBaseRepo({ host: 'github.com', owner: 'acme', repo: 'app' });
      flushSync();
      assert.equal(globalThis.targetLoads, 1, 'an unchanged repository must not reload the review');

      // An event on the active tab rebuilds the context while the review is still opening.
      control.setCtx({ session: { projectPath: '/repo' } });
      flushSync();
      assert.equal(prepareCalls, 1, 'a rebuilt context must not open the review again');

      // A real change still reaches the review.
      control.setBaseRepo({ host: 'github.com', owner: 'acme', repo: 'other' });
      flushSync();
      assert.equal(globalThis.targetLoads, 2);

      unmount(app); flushSync(); dom.window.close();
    `)
    const child = Bun.spawn([process.execPath, runner], { stdout: 'pipe', stderr: 'pipe' })
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ])
    expect({ stdout, stderr, exitCode }).toEqual({ stdout: '', stderr: '', exitCode: 0 })
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
