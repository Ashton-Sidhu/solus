import { afterAll, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { compileModule } from 'svelte/compiler'
import ts from 'typescript'

const root = new URL('../../', import.meta.url)
const directory = mkdtempSync(join(tmpdir(), 'solus-outer-scrollbar-'))
const transpiler = new Bun.Transpiler({ loader: 'ts' })

afterAll(() => rmSync(directory, { recursive: true, force: true }))

test.each([
  ['project rail', 'project-panel/ProjectPanel.svelte', 'sectionsElement'],
  ['conversation', 'conversation/ConversationView.svelte', 'scrollEl'],
])('registering the %s does not subscribe its effect to the parent target list', async (_name, component, elementName) => {
  // WHY: register reads and writes the parent's reactive array. If those reads
  // escape untrack, one mount repeatedly registers and cleans itself up until
  // Svelte stops the renderer with effect_update_depth_exceeded.
  const source = readFileSync(
    new URL(`packages/workspace-ui/src/components/${component}`, root),
    'utf8',
  )
  const script = source.slice(source.indexOf('>') + 1, source.indexOf('</script>'))
  const ast = ts.createSourceFile(component, script, ts.ScriptTarget.Latest, true)
  const lifecycle = ast.statements.find((statement) =>
    ts.isExpressionStatement(statement)
    && statement.getText(ast).includes(`outerScrollbar.register(${elementName})`),
  )
  if (!lifecycle) throw new Error('Missing outer scrollbar registration lifecycle')

  const harness = `
    import assert from 'node:assert/strict';
    import { flushSync, untrack } from 'svelte';
    let sectionsElement = $state(null);
    let isVisible = $state(true);
    const outerScrollTargets = $state([]);
    let registrations = 0;
    let cleanups = 0;
    const outerScrollbar = {
      register(element) {
        registrations += 1;
        if (!outerScrollTargets.includes(element)) outerScrollTargets.push(element);
        return () => {
          cleanups += 1;
          const index = outerScrollTargets.indexOf(element);
          if (index !== -1) outerScrollTargets.splice(index, 1);
        };
      }
    };
    const destroy = $effect.root(() => { ${lifecycle.getText(ast).replaceAll(elementName, "sectionsElement")} });
    const first = {};
    sectionsElement = first;
    flushSync();
    assert.equal(registrations, 1);
    assert.equal(outerScrollTargets.length, 1);
    assert.equal(outerScrollTargets[0], sectionsElement);
    const second = {};
    sectionsElement = second;
    flushSync();
    assert.equal(registrations, 2);
    assert.equal(cleanups, 1);
    assert.equal(outerScrollTargets.length, 1);
    assert.equal(outerScrollTargets[0], sectionsElement);
    ${elementName === 'scrollEl' ? `
    isVisible = false;
    flushSync();
    assert.equal(cleanups, 2);
    assert.equal(outerScrollTargets.length, 0);
    isVisible = true;
    flushSync();
    assert.equal(registrations, 3);
    assert.equal(outerScrollTargets.length, 1);
    ` : ''}
    destroy();
    assert.equal(cleanups, ${elementName === 'scrollEl' ? 3 : 2});
    assert.deepEqual([...outerScrollTargets], []);
  `
  const compiled = compileModule(transpiler.transformSync(harness), {
    filename: 'outer-scrollbar.svelte.js',
    generate: 'client',
  }).js.code
    .replaceAll(
      /(['"])svelte\/internal\/client\1/g,
      JSON.stringify(new URL('node_modules/svelte/src/internal/client/index.js', root).href),
    )
    .replaceAll(
      /(['"])svelte\1/g,
      JSON.stringify(new URL('node_modules/svelte/src/index-client.js', root).href),
    )
    .replaceAll(/import ['"]svelte\/internal\/disclose-version['"];?/g, '')
  const path = join(directory, 'outer-scrollbar.mjs')
  writeFileSync(path, compiled)
  const child = Bun.spawn([process.execPath, path], { stdout: 'pipe', stderr: 'pipe' })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  expect({ exitCode, stdout, stderr }).toEqual({ exitCode: 0, stdout: '', stderr: '' })
})
