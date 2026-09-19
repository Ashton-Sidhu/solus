import { expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { compile } from 'svelte/compiler'

// Exercise the real outlet with controlled module loads. A route must never
// receive another route's params while its replacement is still loading.
test('pane route changes isolate params and preserve same-route state', async () => {
  const root = new URL('../../', import.meta.url)
  const directory = mkdtempSync(join(tmpdir(), 'solus-pane-route-'))
  const client = new URL('node_modules/svelte/src/index-client.js', root).href
  const internal = new URL('node_modules/svelte/src/internal/client/index.js', root).href
  function component(source: string, name: string) {
    const code = compile(source, { filename: `${name}.svelte`, generate: 'client' }).js.code
      .replaceAll(/(['"])svelte\/internal\/client\1/g, JSON.stringify(internal))
      .replaceAll(/import ['"]svelte\/internal\/disclose-version['"];?/g, '')
    const path = join(directory, `${name}.mjs`)
    writeFileSync(path, code)
    return path
  }
  try {
    const stub = component('<span data-loading></span>', 'stub')
    const files = component(`<script>
      let { params } = $props();
      const root = $derived(params.cwd.indexOf('/'));
    </script><article data-files>{params.cwd}:{root}</article>`, 'files')
    const review = component(`<script>
      let { params } = $props();
      const source = $derived(params.sourceTabId.toUpperCase());
    </script><article data-review>{source}:{params.view}</article>`, 'review')
    const registry = join(directory, 'registry.mjs')
    writeFileSync(registry, `
      import Files from ${JSON.stringify(files)};
      import Review from ${JSON.stringify(review)};
      let resolveReview;
      export const ROUTES = {
        files: { component: () => Promise.resolve({ default: Files }) },
        review: { component: () => new Promise(resolve => { resolveReview = resolve; }) },
      };
      export function finishReview() { resolveReview({ default: Review }); }
    `)
    const source = readFileSync(new URL('packages/workspace-ui/src/components/ui/Pane.svelte', root), 'utf8')
      .replace(/^  import type .*?;\n/gm, '')
      .replace(/^  import \{ .*?;\n/gm, '')
      .replace(/^  import (\w+) from .*?;$/gm, (_, name) => `  import ${name} from ${JSON.stringify(stub)};`)
      .replace('<script lang="ts">', `<script lang="ts">
        import { ROUTES } from ${JSON.stringify(registry)};
        const visibleRef = pane => pane.overlay ?? pane.base;
        const getWorkspaceContext = () => ({ router: { leadingPane: { id: 'main' } } });
        const paneActions = () => ({});
      `)
    const pane = component(source, 'pane')
    const harness = component(`<script>
      import Pane from ${JSON.stringify(pane)};
      let pane = $state({ id: 'aside', base: null, overlay: { name: 'files', params: { serverId: 'host', cwd: '/project' } } });
      export function navigate(name, params) { pane.overlay = { name, params }; }
    </script><Pane {pane} />`, 'harness')
    const runner = join(directory, 'test.mjs')
    writeFileSync(runner, `
      import assert from 'node:assert/strict';
      import { JSDOM } from ${JSON.stringify(new URL('node_modules/jsdom/lib/api.js', root).href)};
      const dom = new JSDOM('<!doctype html><body></body>');
      for (const key of ['window', 'document', 'Node', 'Element', 'HTMLElement', 'Text', 'Comment', 'Event', 'CustomEvent']) globalThis[key] = dom.window[key];
      const { mount, unmount, flushSync, tick } = await import(${JSON.stringify(client)});
      const { default: Harness } = await import(${JSON.stringify(harness)});
      const { finishReview } = await import(${JSON.stringify(registry)});
      const app = mount(Harness, { target: document.body });
      flushSync();
      await tick();
      const files = document.querySelector('[data-files]');
      assert.ok(files);
      app.navigate('files', { serverId: 'host', cwd: '/other' });
      flushSync();
      await tick();
      assert.equal(document.querySelector('[data-files]'), files);
      assert.ok(files.textContent.includes('/other'));
      app.navigate('review', { sourceTabId: 'tab', view: 'diff' });
      flushSync();
      assert.equal(document.querySelector('[data-files]'), null);
      assert.ok(document.querySelector('[data-loading]'));
      finishReview();
      await tick();
      assert.equal(document.querySelector('[data-review]').textContent, 'TAB:diff');
      const review = document.querySelector('[data-review]');
      app.navigate('review', { sourceTabId: 'tab', view: 'guide' });
      flushSync();
      assert.equal(document.querySelector('[data-review]'), review);
      assert.equal(review.textContent, 'TAB:guide');
      app.navigate('files', { serverId: 'host', cwd: '/project' });
      flushSync();
      await tick();
      assert.ok(document.querySelector('[data-files]'));
      assert.equal(document.querySelector('[data-review]'), null);
      await unmount(app);
      dom.window.close();
    `)
    const child = Bun.spawn([process.execPath, runner], { stdout: 'pipe', stderr: 'pipe' })
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ])
    expect({ exitCode, stdout, stderr }).toEqual({ exitCode: 0, stdout: '', stderr: '' })
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
