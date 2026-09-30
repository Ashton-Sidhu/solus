import { expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { compile } from 'svelte/compiler'

/**
 * Mounts the list-page `VirtualList` (TanStack Virtual underneath) in jsdom and
 * drives it the way the list pages and pickers do. jsdom does no layout, so the
 * runner models the three facts the list reads from a browser: a box is as tall
 * as its inline height, a scroller clamps to its content, and every move fires a
 * scroll event a moment later.
 */
async function runInList(size: string, script: string) {
  const root = new URL('../../', import.meta.url)
  const directory = mkdtempSync(join(tmpdir(), 'solus-virtual-list-'))
  const client = new URL('node_modules/svelte/src/index-client.js', root).href
  const internal = new URL('node_modules/svelte/src/internal/client/index.js', root).href
  const store = new URL('node_modules/svelte/src/store/index-client.js', root).href
  function write(name: string, code: string) {
    const path = join(directory, name)
    writeFileSync(path, code)
    return path
  }
  function component(source: string, name: string) {
    const code = compile(source, { filename: `${name}.svelte`, generate: 'client' }).js.code
      .replaceAll(/(['"])svelte\/internal\/client\1/g, JSON.stringify(internal))
      .replaceAll(/(['"])svelte\1/g, JSON.stringify(client))
      .replaceAll(/import ['"]svelte\/internal\/disclose-version['"];?/g, '')
    return write(`${name}.mjs`, code)
  }
  try {
    const adapter = write('svelte-virtual.mjs', readFileSync(new URL('node_modules/@tanstack/svelte-virtual/dist/index.js', root), 'utf8')
      .replaceAll("'@tanstack/virtual-core'", JSON.stringify(new URL('node_modules/@tanstack/virtual-core/dist/esm/index.js', root).href))
      .replaceAll("'svelte/store'", JSON.stringify(store)))
    const list = component(readFileSync(new URL('packages/workspace-ui/src/components/ui/list-page/VirtualList.svelte', root), 'utf8')
      .replace('"@tanstack/svelte-virtual"', JSON.stringify(adapter))
      .replace('"./virtual-list"', JSON.stringify(new URL('packages/workspace-ui/src/components/ui/list-page/virtual-list.ts', root).href)), 'list')
    const fixture = component(`<script>
      import VirtualList from ${JSON.stringify(list)};
      let { offset = 0 } = $props();
      let items = $state(Array.from({ length: 40 }, (_, key) => ({ key })));
      let activeKey = $state(null);
      let scrollOffset = $state(offset);
      export function replace(next) { items = next; }
      export function select(key) { activeKey = key; }
      export function scrollTo(next) { scrollOffset = next; }
      export function truncate(length) { items.splice(length); }
    </script>
    {#if items.length > 0}
    <VirtualList height={200} {items} itemSize={${size}} keyOf={(item) => item.key} {activeKey}
      {scrollOffset} onScroll={(next) => (scrollOffset = next)}>
      {#snippet children(item, index, style)}<div data-row={item.key} {style}>{item.key}</div>{/snippet}
    </VirtualList>
    {/if}`, 'fixture')
    const runner = write('test.mjs', `
      import assert from 'node:assert/strict';
      import { JSDOM } from ${JSON.stringify(new URL('node_modules/jsdom/lib/api.js', root).href)};
      const dom = new JSDOM('<!doctype html><body></body>', { pretendToBeVisual: true });
      for (const key of ['window', 'document', 'Node', 'Element', 'HTMLElement', 'Text', 'Comment', 'Event', 'CustomEvent', 'HTMLMediaElement', 'requestAnimationFrame', 'cancelAnimationFrame']) {
        globalThis[key] = dom.window[key];
      }
      const px = (value) => parseFloat(value) || 0;
      Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { get() { return px(this.style.height); } });
      Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { get() { return 300; } });
      Object.defineProperty(HTMLElement.prototype, 'clientHeight', { get() { return px(this.style.height); } });
      Object.defineProperty(HTMLElement.prototype, 'scrollHeight', {
        get() { return Math.max(px(this.style.height), px(this.firstElementChild?.style.height)); },
      });
      const scrollTops = new WeakMap();
      Object.defineProperty(HTMLElement.prototype, 'scrollTop', {
        get() { return scrollTops.get(this) ?? 0; },
        set(value) {
          const next = Math.min(Math.max(0, value), this.scrollHeight - this.clientHeight);
          if (next === this.scrollTop) return;
          scrollTops.set(this, next);
          setTimeout(() => this.dispatchEvent(new Event('scroll')), 0);
        },
      });
      HTMLElement.prototype.scrollTo = function ({ top }) { this.scrollTop = top; };
      const { mount, unmount, flushSync } = await import(${JSON.stringify(client)});
      const { default: Fixture } = await import(${JSON.stringify(fixture)});
      const settle = async () => { flushSync(); await new Promise((resolve) => setTimeout(resolve, 40)); flushSync(); };
      const rows = () => [...document.querySelectorAll('[data-row]')];
      const scroller = () => document.querySelector('[data-virtual-list]');
      /** The rows drawn reach from the top of the viewport to its bottom. */
      const coversViewport = () => {
        const tops = rows().map((row) => px(row.style.top));
        const bottoms = rows().map((row) => px(row.style.top) + px(row.style.height));
        return Math.min(...tops) <= scroller().scrollTop && Math.max(...bottoms) >= scroller().scrollTop + 200;
      };
      ${script}
      dom.window.close();
    `)
    const child = Bun.spawn([process.execPath, runner], { stdout: 'pipe', stderr: 'pipe' })
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ])
    return { exitCode, stdout, stderr }
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

const passed = { exitCode: 0, stdout: '', stderr: '' }

test.each([
  ['fixed', '() => 30', 30],
  ['grouped', '(index) => typeof items[index].key === "string" ? 20 : 40', 40],
])('%s virtual lists safely shrink and preserve surviving row identity', async (_sizing, size, rowOneHeight) => {
  expect(await runInList(size, `
    const app = mount(Fixture, { target: document.body });
    await settle();
    assert.ok(rows().length > 2);
    const first = document.querySelector('[data-row="0"]');
    app.replace([{ key: 0 }, { key: 1 }]);
    await settle();
    assert.equal(rows().length, 2);
    assert.equal(document.querySelector('[data-row="0"]'), first);
    // A regroup with the same count must update row positions and heights.
    app.replace([{ key: 'header' }, { key: 1 }]); await settle();
    app.replace([{ key: 1 }, { key: 'header' }]); await settle();
    assert.equal(document.querySelector('[data-row="header"]').style.top, '${rowOneHeight}px');
    // Refreshes can shorten the list while it is scrolled and has a selection.
    app.replace(Array.from({ length: 40 }, (_, key) => ({ key })));
    app.select(39); app.scrollTo(1500); await settle();
    assert.ok(document.querySelector('[data-row="39"]'));
    app.truncate(2); await settle();
    assert.equal(rows().length, 2);
    assert.equal(document.querySelector('[data-row="39"]'), null);
    app.replace([]); await settle();
    assert.equal(rows().length, 0);
    app.replace([{ key: 'restored' }]); await settle();
    assert.equal(rows()[0].textContent, 'restored');
    // Project switches remount the list with a selected row and a reset offset.
    // The selected row must be visible even when it starts below the viewport.
    app.replace([]); await settle();
    app.select(39); app.scrollTo(0);
    app.replace(Array.from({ length: 40 }, (_, key) => ({ key }))); await settle();
    assert.ok(document.querySelector('[data-row="39"]'));
    await unmount(app);
  `)).toEqual(passed)
}, 30_000)

// WHY: list pages remember their scroll offset and hand it back when the list
// mounts again (a return to the Pull requests page, a refresh behind the
// skeleton). The rows drawn must be the rows the scroller shows: the previous
// library drew the remembered rows but left the scroller at zero, so the page
// opened at the top with an empty band where the first rows belong.
test('a list mounted at a remembered offset draws the rows its scroller shows', async () => {
  expect(await runInList('() => 30', `
    const app = mount(Fixture, { target: document.body, props: { offset: 600 } });
    await settle();
    assert.equal(scroller().scrollTop, 600);
    assert.ok(coversViewport(), 'rows fill the viewport');
    await unmount(app);
  `)).toEqual(passed)
}, 30_000)

test('a remembered offset past the end of a shorter list lands on its last rows', async () => {
  // 40 rows of 30px in a 200px viewport scroll at most 1000px.
  expect(await runInList('() => 30', `
    const app = mount(Fixture, { target: document.body, props: { offset: 5000 } });
    await settle();
    assert.equal(scroller().scrollTop, 1000);
    assert.ok(coversViewport(), 'rows fill the viewport');
    assert.ok(document.querySelector('[data-row="39"]'));
    await unmount(app);
  `)).toEqual(passed)
}, 30_000)
