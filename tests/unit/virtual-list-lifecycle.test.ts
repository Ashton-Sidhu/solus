import { expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { compile } from 'svelte/compiler'

test.each(['fixed', 'grouped', 'picker-fixed', 'picker-grouped'])('%s virtual lists safely shrink and preserve surviving row identity', async (sizing) => {
  const root = new URL('../../', import.meta.url)
  const directory = mkdtempSync(join(tmpdir(), 'solus-virtual-list-'))
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
    const isPicker = sizing.startsWith('picker-')
    const isGrouped = sizing.endsWith('grouped')
    const size = isGrouped ? '(index) => typeof items[index].key === "string" ? 20 : 40' : '30'
    const fixture = component(`<script>
      import VirtualList from ${JSON.stringify(isPicker ? tiny : list)};
      let items = $state(Array.from({ length: 40 }, (_, key) => ({ key })));
      let activeKey = $state(null);
      let scrollOffset = $state(0);
      export function replace(next) { items = next; }
      export function select(key) { activeKey = key; }
      export function scrollTo(offset) { scrollOffset = offset; }
      export function truncate(length) { items.splice(length); }
    </script>
    {#if items.length > 0}
    <VirtualList height={200} {scrollOffset}
      ${isPicker
        ? `itemCount={items.length} itemSize={${isGrouped ? 'items.map(item => typeof item.key === "string" ? 20 : 40)' : '30'}} scrollToIndex={activeKey === null ? undefined : Math.max(0, items.findIndex(item => item.key === activeKey))} scrollToAlignment="auto"`
        : `{items} itemSize={${size}} keyOf={item => item.key} {activeKey}`}>
      ${isPicker ? '{#snippet item({ index, style })}{@const item = items[index]}' : '{#snippet children(item, index, style)}'}
        <div data-row={item.key} {style}>{item.key}</div>
      {/snippet}
    </VirtualList>
    {/if}`, 'fixture')
    const runner = join(directory, 'test.mjs')
    writeFileSync(runner, `
      import assert from 'node:assert/strict';
      import { JSDOM } from ${JSON.stringify(new URL('node_modules/jsdom/lib/api.js', root).href)};
      const dom = new JSDOM('<!doctype html><body></body>');
      for (const key of ['window', 'document', 'Node', 'Element', 'HTMLElement', 'Text', 'Comment', 'Event', 'CustomEvent']) {
        globalThis[key] = dom.window[key];
      }
      globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
      HTMLElement.prototype.scroll = function () {};
      const { mount, unmount, flushSync } = await import(${JSON.stringify(client)});
      const { default: Fixture } = await import(${JSON.stringify(fixture)});
      const app = mount(Fixture, { target: document.body });
      flushSync();
      assert.ok(document.querySelectorAll('[data-row]').length > 2);
      const first = document.querySelector('[data-row="0"]');
      app.replace([{ key: 0 }, { key: 1 }]);
      flushSync();
      assert.equal(document.querySelectorAll('[data-row]').length, 2);
      assert.equal(document.querySelector('[data-row="0"]'), first);
      // String keys resembling fallback keys must remain distinct from stale slots.
      app.replace([{ key: 'missing:1' }]);
      flushSync();
      assert.equal(document.querySelector('[data-row]').textContent, 'missing:1');
      // A regroup with the same count must update row positions and heights.
      app.replace([{ key: 'header' }, { key: 1 }]); flushSync();
      app.replace([{ key: 1 }, { key: 'header' }]); flushSync();
      assert.equal(document.querySelector('[data-row="header"]').style.top, '${isGrouped ? 40 : 30}px');
      // Refreshes can shorten the list while it is scrolled and has a selection.
      app.replace(Array.from({ length: 40 }, (_, key) => ({ key })));
      app.select(39); app.scrollTo(1500); flushSync();
      assert.ok(document.querySelector('[data-row="39"]'));
      app.truncate(2); flushSync();
      assert.equal(document.querySelectorAll('[data-row]').length, 2);
      assert.equal(document.querySelector('[data-row="39"]'), null);
      app.replace([]); flushSync();
      assert.equal(document.querySelectorAll('[data-row]').length, 0);
      app.replace([{ key: 'restored' }]); flushSync();
      assert.equal(document.querySelector('[data-row]').textContent, 'restored');
      // Project switches remount the list with a selected row and a reset offset.
      // The selected row must be visible even when it starts below the viewport.
      app.replace([]); flushSync();
      app.select(39); app.scrollTo(0);
      app.replace(Array.from({ length: 40 }, (_, key) => ({ key }))); flushSync();
      assert.ok(document.querySelector('[data-row="39"]'));
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
