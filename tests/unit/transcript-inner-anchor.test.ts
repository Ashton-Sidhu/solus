import { afterAll, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { compileModule } from 'svelte/compiler'

const directory = mkdtempSync(join(tmpdir(), 'solus-transcript-anchor-'))
afterAll(() => rmSync(directory, { recursive: true, force: true }))
const root = new URL('../../', import.meta.url)
const region = 'packages/workspace-ui/src/components/conversation/lib/'
const transpiler = new Bun.Transpiler({ loader: 'ts' })

test('a render that loads inside the top row does not move what the reader sees', async () => {
  // WHY: the virtualizer held the top row's top edge still. Scrolling up into
  // a turn, its render loaded and grew, and the text the reader was on was
  // pushed down: the transcript "jumped to the top of the artifact". Anchoring
  // a render by its bottom was no better: the frame draws from its top, so
  // the reader was then scrolled across the render as it grew.
  const geometryPath = join(directory, 'geometry.mjs')
  writeFileSync(geometryPath, transpiler.transformSync(readFileSync(new URL(region + 'transcript-geometry.ts', root), 'utf8')))
  const internal = new URL('node_modules/svelte/src/internal/client/index.js', root).href
  const client = new URL('node_modules/svelte/src/index-client.js', root).href
  const controllerPath = join(directory, 'controller.mjs')
  writeFileSync(controllerPath, compileModule(transpiler.transformSync(
    readFileSync(new URL(region + 'transcript-virtualizer.svelte.ts', root), 'utf8')
      .replace("'./transcript-geometry'", JSON.stringify(geometryPath)),
  ), { filename: 'controller.svelte.js', generate: 'client' }).js.code
    .replaceAll(/(['"])svelte\/internal\/client\1/g, JSON.stringify(internal))
    .replaceAll(/(['"])svelte\1/g, JSON.stringify(client))
    .replaceAll(/import ['"]svelte\/internal\/disclose-version['"];?/g, ''))
  const testPath = join(directory, 'run.mjs')
  writeFileSync(testPath, `
    import assert from 'node:assert/strict';
    import { JSDOM } from ${JSON.stringify(new URL('node_modules/jsdom/lib/api.js', root).href)};
    const dom = new JSDOM('<!doctype html><body></body>');
    for (const key of ['window', 'document', 'Node', 'Element', 'HTMLElement']) globalThis[key] = dom.window[key];
    const frames = [];
    globalThis.requestAnimationFrame = (fn) => frames.push(fn);
    globalThis.cancelAnimationFrame = () => {};
    let deliver;
    globalThis.ResizeObserver = class { constructor(cb) { deliver = cb; } observe() {} unobserve() {} disconnect() {} };
    const { tick } = await import(${JSON.stringify(client)});
    const { TranscriptVirtualizer } = await import(${JSON.stringify(controllerPath)});

    // Three turns stacked; the middle one is text, a render, text.
    const scroll = document.createElement('div');
    const content = document.createElement('div');
    scroll.append(content); document.body.append(scroll);
    const make = (parent) => { const el = document.createElement('div'); parent.append(el); return el; };
    const rows = [make(content), make(content), make(content)];
    const [before, frame, after] = [make(rows[1]), make(rows[1]), make(rows[1])];
    const heights = new Map([[rows[0], 500], [before, 200], [frame, 120], [after, 200], [rows[2], 2000]]);
    const layout = new Map();
    let gap = 0;
    function place() {
      let y = 0;
      for (const row of rows) {
        const top = y;
        if (row === rows[1]) for (const child of row.children) { layout.set(child, { top: y, h: heights.get(child) }); y += heights.get(child) + gap; }
        else y += heights.get(row);
        layout.set(row, { top, h: y - top });
      }
      layout.set(content, { top: 0, h: y });
    }
    place();
    let scrollTop = 0;
    Object.defineProperty(scroll, 'clientHeight', { get: () => 800 });
    Object.defineProperty(scroll, 'scrollTop', { get: () => scrollTop, set(v) { scrollTop = Math.max(0, Math.min(v, layout.get(content).h - 800)); } });
    Element.prototype.getBoundingClientRect = function() {
      if (this === scroll) return { top: 0, bottom: 800, height: 800 };
      const box = layout.get(this) ?? { top: 0, h: 0 };
      return { top: box.top - scrollTop, bottom: box.top + box.h - scrollTop, height: box.h };
    };

    const virtualizer = new TranscriptVirtualizer();
    virtualizer.setKeys(['a', 'b', 'c']);
    rows.forEach((row, index) => virtualizer.row(row, 'abc'[index]));
    virtualizer.connect(scroll, content);
    const measure = () => deliver(rows.map((row) => ({ target: row, borderBoxSize: [{ blockSize: layout.get(row).h }] })));
    measure(); await tick();
    const read = async (top) => { scrollTop = top; scroll.dispatchEvent(new window.Event('scroll')); for (const fn of frames.splice(0)) fn(); await tick(); };
    const grow = async (height) => { heights.set(frame, height); place(); measure(); await tick(); };

    // Reader's top edge is in the text below the render (500 + 200 + 120 + 30).
    await read(850);
    await grow(1000);
    assert.equal(scrollTop, 850 + 880, 'a render growing above the reader moves the scroll with it');

    // Reader's top edge is inside the render. An iframe draws from its top, so
    // its top stays still and the growth goes below what the reader sees.
    await grow(120);
    await read(750);
    await grow(1000);
    assert.equal(scrollTop, 750, 'the part of the render the reader sees stays in place');

    // Reader's top edge is in the text above the render: the render grows below.
    await grow(120);
    await read(550);
    await grow(1000);
    assert.equal(scrollTop, 550, 'growth below the reader leaves the scroll alone');

    // Reader's top edge is in the row's trailing margin, below its last
    // child: nothing inside the row starts below it. The next row must anchor.
    await grow(120);
    gap = 20; place(); measure(); await tick();
    await read(1070);
    heights.set(before, 300); place(); measure(); await tick();
    assert.equal(scrollTop, 1170, 'text growing above the margin the reader is in moves the scroll with it');
  `)
  const child = Bun.spawn([process.execPath, testPath], { stdout: 'pipe', stderr: 'pipe' })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ])
  expect({ exitCode, stderr, stdout }).toEqual({ exitCode: 0, stderr: '', stdout: '' })
})
