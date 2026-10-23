/**
 * Code block benchmark: a transcript that mounts many code blocks after the
 * tokenizer has loaded, the usual case once a session has shown one block.
 *
 * Run with: bun tests/benchmarks/code-block.ts
 *
 * The script bundles `CodeBlock.svelte` on Svelte's real client runtime into
 * one HTML page and prints its path. Open the page in Chromium: it mounts the
 * blocks for several rounds and prints the medians on the page and in
 * `window.results`. jsdom is no stand-in here: its HTML parser costs more than
 * the lexer, so only a browser gives render numbers. `CODE_BLOCK_SOURCE` names
 * another component source to measure, for a before-and-after comparison.
 * No benchmark touches live Solus data or starts the app.
 */
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { compile } from 'svelte/compiler'

const BLOCKS = 150
const ROUNDS = 7
const root = new URL('../../', import.meta.url)
// Inside node_modules, so the bundler resolves the component's bare imports.
const cache = new URL('node_modules/.cache/', root).pathname
mkdirSync(cache, { recursive: true })
const directory = mkdtempSync(join(cache, 'solus-code-block-bench-'))
const componentPath = process.env.CODE_BLOCK_SOURCE ?? new URL('packages/workspace-ui/src/components/ui/CodeBlock.svelte', root).pathname

function component(source: string, name: string): string {
  const code = compile(source, { filename: `${name}.svelte`, generate: 'client', runes: true }).js.code
    .replaceAll(/import ['"]svelte\/internal\/disclose-version['"];?/g, '')
  const path = join(directory, `${name}.mjs`)
  writeFileSync(path, code)
  return path
}

const icon = component('<span></span>', 'icon')
const highlightModule = new URL('packages/workspace-ui/src/lib/code-highlight.ts', root).pathname
const codeBlock = component(
  readFileSync(componentPath, 'utf8')
    .replace(/import \{ Copy as CopyIcon, Check as CheckIcon \} from "@lucide\/svelte";/, `import CopyIcon from ${JSON.stringify(icon)}; const CheckIcon = CopyIcon;`)
    .replace('"../../lib/code-highlight"', JSON.stringify(highlightModule)),
  'code-block',
)

const text = Array.from({ length: 40 }, (_, line) =>
  `export function demo${line}(items: readonly string[]): string {\n  // Join the items; a template keeps the count readable.\n  return \`\${items.length} items: \${items.join(', ')}\`.trim()\n}`,
).join('\n')

const entry = join(directory, 'entry.mjs')
writeFileSync(entry, `
  import { mount, unmount, flushSync } from 'svelte'
  import CodeBlock from ${JSON.stringify(codeBlock)}
  import { loadCodeHighlighter } from ${JSON.stringify(highlightModule)}

  const BLOCKS = ${BLOCKS}
  const ROUNDS = ${ROUNDS}
  const text = ${JSON.stringify(text)}
  const frame = () => new Promise((resolve) => requestAnimationFrame(() => resolve(performance.now())))
  // Blocks colour in mount order, so the last block's spans mean every block has them.
  const allColoured = (target) => target.lastElementChild?.querySelector('code span[style]') != null

  async function round() {
    const target = document.createElement('div')
    document.body.append(target)
    const start = performance.now()
    const instances = Array.from({ length: BLOCKS }, () => mount(CodeBlock, { target, props: { text, lang: 'ts' } }))
    flushSync()
    const mountTask = performance.now() - start
    const firstFrame = await frame() - start
    while (!allColoured(target)) await frame()
    const coloured = performance.now() - start
    for (const instance of instances) unmount(instance)
    target.remove()
    await frame()
    return { mountTask, firstFrame, coloured }
  }

  const median = (values) => values.toSorted((a, b) => a - b)[Math.floor(values.length / 2)]
  await loadCodeHighlighter('ts')
  await round()
  const samples = []
  for (let i = 0; i < ROUNDS; i++) samples.push(await round())
  const results = {
    blocks: BLOCKS,
    characters: text.length,
    rounds: ROUNDS,
    mountTaskMs: median(samples.map((sample) => sample.mountTask)),
    firstFrameMs: median(samples.map((sample) => sample.firstFrame)),
    colouredMs: median(samples.map((sample) => sample.coloured)),
  }
  window.results = results
  document.body.append(Object.assign(document.createElement('pre'), { id: 'results', textContent: JSON.stringify(results, null, 2) }))
`)

const bundle = await Bun.build({ entrypoints: [entry], target: 'browser', format: 'esm' })
if (!bundle.success) throw new Error(bundle.logs.map((log) => log.message).join('\n'))
const page = join(directory, 'code-block.html')
// A bundled grammar can contain "</script>", which would end the inline script early.
const script = (await bundle.outputs[0]!.text()).replaceAll('</script', '<\\/script').replaceAll('<!--', '<\\!--')
writeFileSync(page, `<!doctype html><html><body><script type="module">${script}</script></body></html>`)
console.log(page)
