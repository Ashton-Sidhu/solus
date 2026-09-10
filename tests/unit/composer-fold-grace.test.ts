import { expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { compileModule } from 'svelte/compiler'
import ts from 'typescript'

/**
 * The fold controller, run for real: the production `useComposerFold` is
 * compiled and driven through a jsdom with a hand-cranked clock, so the
 * assertions are about what the bar does across real focus events, not
 * about which helper it calls.
 */
test('ordinary blur folds without delay while menus, selections and recording stay protected', async () => {
  const root = new URL('../../', import.meta.url)
  const file = new URL('packages/workspace-ui/src/components/input/lib/composer-fold.svelte.ts', root)
  const source = readFileSync(file, 'utf8')
  const ast = ts.createSourceFile('composer-fold.ts', source, ts.ScriptTarget.Latest, true)
  const production = ast.statements
    .filter((statement) => !ts.isImportDeclaration(statement))
    .map((statement) => statement.getText(ast))
    .join('\n')
  const helperUrl = (name: string) =>
    JSON.stringify(new URL(`packages/workspace-ui/src/components/input/lib/${name}.ts`, root).href)
  const harness = `
    import assert from 'node:assert/strict';
    import { untrack, flushSync } from 'svelte';
    import { JSDOM } from 'jsdom';
    import {
      COMPOSER_REFOCUS_GRACE_MS, floatingLayerOf, keyboardHoldsComposerOpen,
      selectionHoldsComposerOpen, shouldCollapseComposer,
    } from ${helperUrl('composer-collapse')};
    import {
      COMPOSER_COLLAPSED_ATTRIBUTE, composerSurfaceOf, measureFold, tweenComposerFold,
    } from ${helperUrl('composer-fold')};

    // ─── A clock the test turns by hand ───
    let now = 0;
    let nextTimer = 1;
    const timers = new Map();
    globalThis.setTimeout = (callback, delay = 0) => {
      const id = nextTimer++;
      timers.set(id, { at: now + delay, callback });
      return id;
    };
    globalThis.clearTimeout = (id) => { timers.delete(id); };
    function advance(ms) {
      const until = now + ms;
      for (;;) {
        let next = null;
        for (const [id, timer] of timers) {
          if (timer.at <= until && (!next || timer.at < next.timer.at)) next = { id, timer };
        }
        if (!next) break;
        timers.delete(next.id);
        now = next.timer.at;
        next.timer.callback();
        flushSync();
      }
      now = until;
    }

    // ─── The page ───
    const dom = new JSDOM(\`
      <div id="transcript" data-conversation-tab-id="tab"><p id="line">hello there</p></div>
      <div id="card" data-composer-surface>
        <div id="bar"><textarea id="editor"></textarea><button id="chip">Model</button></div>
      </div>
      <div id="row" tabindex="0">Task</div>
      <div data-bits-floating-content-wrapper><button id="menu-item">Opus</button></div>
    \`, { pretendToBeVisual: true });
    const { window } = dom;
    const document = window.document;
    globalThis.window = window;
    globalThis.document = document;
    globalThis.Node = window.Node;
    globalThis.CSS = { escape: (value) => value };
    let windowHasFocus = true;
    document.hasFocus = () => windowHasFocus;
    const el = (id) => document.getElementById(id);
    const press = (target) => target.dispatchEvent(new window.Event('pointerdown', { bubbles: true }));
    const release = (target) => target.dispatchEvent(new window.Event('pointerup', { bubbles: true }));

    const getSettingsContext = () => ({ collapseComposerWhenIdle: true });
    const runtime = { shouldSuppressFocus: false };
    ${production}

    // ─── The bar ───
    let recording = $state(false);
    let claims = 0;
    let fold;
    const destroy = $effect.root(() => {
      fold = useComposerFold({
        root: () => el('bar'), tabId: () => 'tab', enabled: () => true,
        recording: () => recording, claimVoice: () => { claims += 1; },
      });
    });
    el('bar').addEventListener('focusin', () => fold.handleFocusIn());
    el('bar').addEventListener('focusout', (event) => fold.handleFocusOut(event));
    // Sampled after every flush: the paint boundaries the user would see.
    const paints = [];
    const flush = () => { flushSync(); paints.push(fold.collapsed); };
    const neverFoldedSince = (index) => assert.deepEqual(paints.slice(index), paints.slice(index).map(() => false));

    // The dock that reserves room for the card reads this flag off the
    // surface to decide whether a measurement may shrink its band, so the
    // card has to publish it in the same flush it changes shape.
    const foldedOnCard = () => el('card').hasAttribute(COMPOSER_COLLAPSED_ATTRIBUTE);

    flush();
    assert.equal(fold.collapsed, true, 'a bar nobody has focused rests folded');
    assert.equal(foldedOnCard(), true, 'the card publishes the fold for the dock to read');
    el('editor').focus(); flush();
    assert.equal(fold.collapsed, false, 'focus opens the bar at once, with no grace');
    assert.equal(foldedOnCard(), false, 'unfolding clears the flag, so the dock may re-measure');
    assert.equal(claims, 1, 'focus claims the mic for this bar');

    // A pointer gesture holds the bar, but its release adds no timed delay.
    let since = paints.length;
    press(el('row')); el('row').focus(); flush();
    advance(COMPOSER_REFOCUS_GRACE_MS * 3); flush();
    assert.equal(fold.collapsed, false, 'a press still in flight holds the bar');
    release(el('row')); flush();
    advance(0); flush();
    assert.equal(fold.collapsed, true, 'release starts collapse without waiting 150ms');
    el('editor').focus(); flush();
    assert.equal(fold.collapsed, false, 'later focus reverses the collapse');

    // A click into the transcript starts collapse after the event completes.
    press(el('line')); el('editor').blur(); flush();
    release(el('line')); flush();
    advance(0); flush();
    assert.equal(fold.collapsed, true, 'a transcript click adds no timed grace');
    el('editor').focus(); flush();

    // Keyboard navigation has no pointer release to wait for.
    el('row').focus(); flush();
    advance(0); flush();
    assert.equal(fold.collapsed, true, 'keyboard blur starts collapse without delay');
    el('editor').focus(); flush();

    // Focus returned within the same event never starts a collapse.
    since = paints.length;
    el('editor').blur();
    el('editor').focus(); flush();
    advance(0); flush();
    neverFoldedSince(since);

    // ─── A menu opened from the bar ───
    since = paints.length;
    el('menu-item').focus(); flush();
    advance(COMPOSER_REFOCUS_GRACE_MS * 3); flush();
    neverFoldedSince(since);
    assert.equal(fold.collapsed, false, 'focus in a floating layer is the bar still in use');
    el('menu-item').blur(); flush();
    advance(50); flush();
    assert.equal(fold.collapsed, false, 'a closing menu can return focus on a later frame');
    el('editor').focus(); flush();
    advance(COMPOSER_REFOCUS_GRACE_MS); flush();
    neverFoldedSince(since);
    el('menu-item').focus(); flush();
    el('menu-item').blur(); flush();
    advance(COMPOSER_REFOCUS_GRACE_MS); flush();
    assert.equal(fold.collapsed, true, 'a menu that lets go without handing back folds the bar');
    el('editor').focus(); flush();

    // ─── The window loses focus ───
    since = paints.length;
    windowHasFocus = false;
    el('editor').blur(); flush();
    advance(COMPOSER_REFOCUS_GRACE_MS * 3); flush();
    neverFoldedSince(since);
    windowHasFocus = true;
    el('editor').focus(); flush();

    // ─── A drag-select in the transcript ───
    since = paints.length;
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(el('line'));
    press(el('line')); el('editor').blur(); flush();
    selection.addRange(range);
    release(el('line')); flush();
    advance(COMPOSER_REFOCUS_GRACE_MS * 3); flush();
    neverFoldedSince(since);
    selection.removeAllRanges();
    document.dispatchEvent(new window.Event('selectionchange'));
    advance(0); flush();
    assert.equal(fold.collapsed, true, 'selection release adds no timed delay');

    // ─── The mic ───
    // Dictating with the keyboard elsewhere: the mic alone holds the bar,
    // and when it lets go the editor is handed the keyboard a frame later.
    el('editor').focus(); flush();
    since = paints.length;
    recording = true; flush();
    el('editor').blur(); flush();
    advance(COMPOSER_REFOCUS_GRACE_MS * 3); flush();
    assert.equal(fold.collapsed, false, 'a live mic holds the bar whatever focus does');
    recording = false; flush();
    advance(COMPOSER_REFOCUS_GRACE_MS - 1); flush();
    el('editor').focus(); flush();
    advance(COMPOSER_REFOCUS_GRACE_MS * 3); flush();
    neverFoldedSince(since);
    // With nobody to hand the keyboard back, the mic letting go is a leave.
    recording = true; flush();
    el('editor').blur(); flush();
    recording = false; flush();
    assert.equal(fold.collapsed, false, 'the mic letting go is not itself a leave');
    advance(COMPOSER_REFOCUS_GRACE_MS); flush();
    assert.equal(fold.collapsed, true, 'it folds once the grace is up and the keyboard is still elsewhere');

    destroy();
    assert.equal(timers.size, 0, 'nothing is left ticking after the bar unmounts');
  `
  const directory = mkdtempSync(join(tmpdir(), 'solus-composer-fold-grace-'))
  try {
    const transpiler = new Bun.Transpiler({ loader: 'ts' })
    const compiled = compileModule(transpiler.transformSync(harness), {
      filename: 'composer-fold.svelte.js', generate: 'client',
    }).js.code
      .replaceAll(/(['"])svelte\/internal\/client\1/g, JSON.stringify(new URL('node_modules/svelte/src/internal/client/index.js', root).href))
      .replaceAll(/(['"])svelte\1/g, JSON.stringify(new URL('node_modules/svelte/src/index-client.js', root).href))
      .replaceAll(/(['"])jsdom\1/g, JSON.stringify(new URL('node_modules/jsdom/lib/api.js', root).href))
    const path = join(directory, 'fold.mjs')
    writeFileSync(path, compiled)
    const child = Bun.spawn([process.execPath, path], { stdout: 'pipe', stderr: 'pipe' })
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ])
    expect({ exitCode, stdout, stderr }).toEqual({ exitCode: 0, stdout: '', stderr: '' })
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
