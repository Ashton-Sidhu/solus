import { expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { compile } from 'svelte/compiler'

test('the sixth inline guide chip follows its section through diff layout until the reader scrolls', async () => {
  const root = new URL('../../', import.meta.url)
  const directory = mkdtempSync(join(tmpdir(), 'solus-guide-rail-'))
  const client = new URL('node_modules/svelte/src/index-client.js', root).href
  const internal = new URL('node_modules/svelte/src/internal/client/index.js', root).href
  function component(source: string, name: string) {
    const code = compile(source, { filename: `${name}.svelte`, generate: 'client', runes: true }).js.code
      .replaceAll(/(['"])svelte\/internal\/client\1/g, JSON.stringify(internal))
      .replaceAll(/from "svelte"/g, 'from ' + JSON.stringify(client))
      .replaceAll(/(['"])svelte\/reactivity\1/g, JSON.stringify(new URL('node_modules/svelte/src/reactivity/index-client.js', root).href))
      .replaceAll(/import ['"]svelte\/internal\/disclose-version['"];?/g, '')
    const path = join(directory, `${name}.mjs`)
    writeFileSync(path, code)
    return path
  }
  try {
    const feature = 'packages/workspace-ui/src/components/'
    const rail = component(readFileSync(new URL(feature + 'ui/navigation-rail/NavigationRail.svelte', root), 'utf8'), 'rail')
    const source = readFileSync(new URL(feature + 'pr-review/guide/GuideRail.svelte', root), 'utf8')
      .replace('"../../ui/navigation-rail/NavigationRail.svelte"', JSON.stringify(rail))
      .replace('"./lib/guide-scroll"', JSON.stringify(new URL(feature + 'pr-review/guide/lib/guide-scroll.ts', root).href))
    const guide = component(source, 'guide')
    const runner = join(directory, 'test.mjs')
    writeFileSync(runner, `
      import assert from 'node:assert/strict';
      import { JSDOM } from ${JSON.stringify(new URL('node_modules/jsdom/lib/api.js', root).href)};
      const dom = new JSDOM('<body><main data-conversation-tab-id><aside></aside><article></article></main></body>');
      for (const key of ['window','document','Node','Element','HTMLElement','HTMLMediaElement','Text','Comment','Event','CustomEvent','AbortController']) globalThis[key] = dom.window[key];
      globalThis.CSS = { escape: s => s };
      window.matchMedia = () => ({ matches: false });
      const frames = new Map();
      let frameId = 0;
      globalThis.requestAnimationFrame = fn => { frames.set(++frameId, fn); return frameId; };
      globalThis.cancelAnimationFrame = id => frames.delete(id);
      const observers = [];
      globalThis.ResizeObserver = class {
        constructor(fn) { this.fn = fn; }
        observe(node) { observers.push([node, this.fn]); }
        disconnect() {}
      };
      const { mount, unmount, flushSync } = await import(${JSON.stringify(client)});
      const { default: Guide } = await import(${JSON.stringify(guide)});
      const viewport = document.querySelector('article');
      viewport.getBoundingClientRect = () => ({ top: -100 });
      Object.defineProperties(viewport, { clientHeight: { value: 500 }, scrollHeight: { value: 6000 } });
      viewport.scrollTo = ({ top }) => { viewport.scrollTop = top; };
      const items = Array.from({ length: 6 }, (_, i) => ({ id: 'section-' + i, label: 'Section ' + (i + 1) }));
      let growth = 0;
      const sections = items.map((item, i) => {
        const node = viewport.appendChild(document.createElement('section'));
        node.dataset.guideSectionId = item.id;
        node.getBoundingClientRect = () => ({ top: -100 + i * 500 + (i === 5 ? growth : 0) - viewport.scrollTop });
        return node;
      });
      const app = mount(Guide, { target: document.querySelector('aside'), props: { items, scrollEl: viewport } });
      flushSync();
      document.querySelector('[aria-label="Section 6"]').click();
      assert.equal(sections[5].getBoundingClientRect().top, 32);
      function expandEarlierDiff() {
        growth += 800;
        observers.find(([node]) => node === sections[4])[1]();
        for (const [id, callback] of frames) { frames.delete(id); callback(); }
        flushSync();
      }
      expandEarlierDiff();
      assert.equal(sections[5].getBoundingClientRect().top, 32);
      assert.equal(document.querySelector('[aria-current="location"]').ariaLabel, 'Section 6');
      viewport.dispatchEvent(new Event('wheel'));
      viewport.scrollTop = 200;
      expandEarlierDiff();
      assert.equal(viewport.scrollTop, 200);
      assert.equal(document.querySelector('main').scrollTop, 0);
      viewport.className = 'artifact-frame expanded';
      document.querySelector('[aria-label="Section 6"]').click();
      assert.equal(sections[5].getBoundingClientRect().top - viewport.getBoundingClientRect().top, 32);
      await unmount(app);
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
