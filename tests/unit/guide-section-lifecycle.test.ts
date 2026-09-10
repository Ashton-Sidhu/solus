import { expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { compile } from 'svelte/compiler'

test('a large guide section bounds mounted cards, keeps every file reachable, and releases observers', async () => {
  const root = new URL('../../', import.meta.url)
  const directory = mkdtempSync(join(tmpdir(), 'solus-guide-section-'))
  const client = new URL('node_modules/svelte/src/index-client.js', root).href
  const internal = new URL('node_modules/svelte/src/internal/client/index.js', root).href
  function component(source: string, name: string) {
    const code = compile(source, { filename: `${name}.svelte`, generate: 'client' }).js.code
      .replaceAll(/(['"])svelte\/internal\/client\1/g, JSON.stringify(internal))
      .replaceAll(/(['"])svelte\/reactivity\1/g, JSON.stringify(new URL('node_modules/svelte/src/reactivity/index-client.js', root).href))
      .replaceAll(/import ['"]svelte\/internal\/disclose-version['"];?/g, '')
    const path = join(directory, `${name}.mjs`)
    writeFileSync(path, code)
    return path
  }
  try {
    const stub = component('<span></span>', 'stub')
    const button = component('<script>let { children, ...props } = $props();</script><button {...props}>{@render children?.()}</button>', 'button')
    // Keep the actual card loop, bindings, actions and jump commands. The diff
    // and icon renderers do not own card lifecycle and need not run in this test.
    const source = readFileSync(new URL('packages/workspace-ui/src/components/pr-review/guide/GuideSection.svelte', root), 'utf8')
      .replace(/^  import .*?;\n/gm, '')
      .replace('<script lang="ts">', `<script lang="ts">
        import { SvelteSet } from 'svelte/reactivity';
        import Stub from ${JSON.stringify(stub)};
        import Button from ${JSON.stringify(button)};
        const Icon = Stub, ArrowSquareOutIcon = Stub;
        const GuideFileDiff = Stub, GuideExplanation = Stub;
        const ensureIconCollections = () => {};
        const fileTypeIcon = () => null;
        const detectMovedBlocksInPatches = () => null;
        const resolveLedgerRefs = () => [];
      `)
    const section = component(source, 'section')
    const runner = join(directory, 'test.mjs')
    writeFileSync(runner, `
      import assert from 'node:assert/strict';
      import { JSDOM } from ${JSON.stringify(new URL('node_modules/jsdom/lib/api.js', root).href)};
      const dom = new JSDOM('<!doctype html><body></body>');
      for (const key of ['window', 'document', 'Node', 'Element', 'HTMLElement', 'Text', 'Comment', 'Event', 'CustomEvent']) globalThis[key] = dom.window[key];
      let observing = 0;
      globalThis.IntersectionObserver = class {
        active = false;
        observe() { if (!this.active) observing++; this.active = true; }
        disconnect() { if (this.active) observing--; this.active = false; }
      };
      let jumped = null;
      HTMLElement.prototype.scrollIntoView = function () { jumped = this; };
      const { mount, unmount, flushSync } = await import(${JSON.stringify(client)});
      const { default: Section } = await import(${JSON.stringify(section)});
      const files = Array.from({ length: 13000 }, (_, i) => ({ path: 'file-' + i + '.ts', additions: 0, deletions: 0 }));
      const app = mount(Section, { target: document.body, props: {
        section: { id: 'remaining', title: 'Remaining changes', explanation: '', ledgerRefs: [], files },
        records: [], patchByPath: new Map(),
      } });
      flushSync();
      assert.equal(observing, 40);
      assert.equal(document.querySelectorAll('li button').length, 40);
      document.querySelector('li button').click();
      flushSync();
      assert.ok(jumped?.textContent.includes('file-0.ts'));
      const next = [...document.querySelectorAll('nav button')].find(button => button.textContent === 'Next files');
      const previous = [...document.querySelectorAll('nav button')].find(button => button.textContent === 'Previous files');
      assert.equal(previous.disabled, true);
      for (let page = 1; page < 325; page++) {
        next.click();
        flushSync();
        assert.equal(observing, 40);
        assert.ok(document.querySelector('li button').textContent.includes('file-' + (page * 40) + '.ts'));
      }
      assert.equal(next.disabled, true);
      assert.ok(document.querySelector('ul').textContent.includes('file-12999.ts'));
      previous.click();
      flushSync();
      assert.ok(document.querySelector('li button').textContent.includes('file-12920.ts'));
      await unmount(app);
      assert.equal(observing, 0);
      assert.equal(document.body.children.length, 0);
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
}, 60_000)
