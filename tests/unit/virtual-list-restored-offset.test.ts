import { expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { compile } from 'svelte/compiler'

// WHY: list pages remember their scroll offset and hand it back when the list
// mounts again (a return to the Pull requests page, a refresh behind the
// skeleton). The rows drawn must be the rows the scroller shows. Upstream
// svelte-tiny-virtual-list draws the starting offset but never moves the real
// scroller there, so the page opened at the top with an empty band where the
// first rows belong. The fix lives in patches/svelte-tiny-virtual-list@4.0.0.patch.
test('a list mounted at a remembered offset draws the rows its scroller shows', async () => {
  const root = new URL('../../', import.meta.url)
  const directory = mkdtempSync(join(tmpdir(), 'solus-virtual-list-offset-'))
  const client = new URL('node_modules/svelte/src/index-client.js', root).href
  const internal = new URL('node_modules/svelte/src/internal/client/index.js', root).href
  function component(source: string, name: string) {
    const code = compile(source, { filename: `${name}.svelte`, generate: 'client' }).js.code
      .replaceAll(/(['"])svelte\/internal\/client\1/g, JSON.stringify(internal))
      .replaceAll(/(['"])svelte\1/g, JSON.stringify(client))
      .replaceAll(/import ['"]svelte\/internal\/disclose-version['"];?/g, '')
    const path = join(directory, `${name}.mjs`)
    writeFileSync(path, code)
    return path
  }
  try {
    const dependency = new URL('node_modules/svelte-tiny-virtual-list/dist/', root)
    const tiny = component(readFileSync(new URL('VirtualList.svelte', dependency), 'utf8')
      .replace("'./SizeAndPositionManager.js'", JSON.stringify(new URL('SizeAndPositionManager.js', dependency).href))
      .replace("'./constants.js'", JSON.stringify(new URL('constants.js', dependency).href)), 'tiny')
    const list = component(readFileSync(new URL('packages/workspace-ui/src/components/ui/list-page/VirtualList.svelte', root), 'utf8')
      .replace('"svelte-tiny-virtual-list"', JSON.stringify(tiny)), 'list')
    const fixture = component(`<script>
      import VirtualList from ${JSON.stringify(list)};
      let { offset } = $props();
      const items = Array.from({ length: 40 }, (_, key) => ({ key }));
    </script>
    <VirtualList height={200} {items} itemSize={30} keyOf={(item) => item.key} scrollOffset={offset}>
      {#snippet children(item, index, style)}<div data-row={item.key} {style}></div>{/snippet}
    </VirtualList>`, 'fixture')
    const runner = join(directory, 'test.mjs')
    writeFileSync(runner, `
      import assert from 'node:assert/strict';
      import { JSDOM } from ${JSON.stringify(new URL('node_modules/jsdom/lib/api.js', root).href)};
      const dom = new JSDOM('<!doctype html><body></body>');
      for (const key of ['window', 'document', 'Node', 'Element', 'HTMLElement', 'Text', 'Comment', 'Event', 'CustomEvent']) {
        globalThis[key] = dom.window[key];
      }
      globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
      globalThis.requestAnimationFrame = (callback) => setTimeout(callback, 0);
      globalThis.cancelAnimationFrame = (frame) => clearTimeout(frame);
      // jsdom does no layout: model a scroller that clamps to its content, and
      // reports each move with a scroll event as a browser does.
      const scrollTops = new WeakMap();
      Object.defineProperty(HTMLElement.prototype, 'scrollTop', {
        get() { return scrollTops.get(this) ?? 0; },
        set(value) {
          const inner = this.querySelector('.virtual-list-inner');
          const max = Math.max(0, (parseFloat(inner?.style.height) || 0) - (parseFloat(this.style.height) || 0));
          const next = Math.min(Math.max(0, value), max);
          if (next === this.scrollTop) return;
          scrollTops.set(this, next);
          setTimeout(() => this.dispatchEvent(new Event('scroll')), 0);
        },
      });
      HTMLElement.prototype.scroll = function ({ top }) { this.scrollTop = top; };
      const { mount, unmount, flushSync, tick } = await import(${JSON.stringify(client)});
      const { default: Fixture } = await import(${JSON.stringify(fixture)});
      const settle = async () => { flushSync(); await tick(); await new Promise((resolve) => setTimeout(resolve, 5)); flushSync(); };
      const app = mount(Fixture, { target: document.body, props: { offset: 600 } });
      await settle();
      const scroller = document.querySelector('.virtual-list-wrapper');
      const tops = [...document.querySelectorAll('[data-row]')].map((row) => parseFloat(row.style.top));
      assert.equal(scroller.scrollTop, 600);
      assert.ok(Math.min(...tops) <= scroller.scrollTop, 'a row is drawn at the top of the viewport');
      assert.ok(Math.max(...tops) + 30 >= scroller.scrollTop + 200, 'rows are drawn to the bottom of the viewport');
      await settle();
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
