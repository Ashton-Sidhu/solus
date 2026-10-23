/**
 * Diff highlight benchmark: how soon a file shows its colours through the
 * shared worker pool, with and without main-thread highlighting for small
 * files (`mainThreadMaxCharacters`).
 *
 * Run with: bun tests/benchmarks/diff-highlight.ts
 *
 * The script bundles `@pierre/diffs`, its worker, and the Highlights backend
 * into one HTML page and prints its path. Open the page in Chromium: it
 * renders files of two sizes through each pool for several rounds and prints
 * the medians on the page and in `window.results`. A worker needs an origin,
 * so pass `--serve` to host the page on a loopback port instead of opening
 * the file. No benchmark touches live Solus data or starts the app.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const ROUNDS = 7
const root = new URL('../../', import.meta.url)
// Inside node_modules, so the bundler resolves the bare imports.
const cache = new URL('node_modules/.cache/', root).pathname
mkdirSync(cache, { recursive: true })
const directory = mkdtempSync(join(cache, 'solus-diff-highlight-bench-'))

const line = 'export function demo(items: readonly string[]): string {\n  // Join the items; a template keeps the count readable.\n  return `${items.length} items: ${items.join(\', \')}`.trim()\n}\n'
const small = line.repeat(20) // about 3 KB, a typical source file in a diff
const large = line.repeat(200) // about 30 KB

const worker = await Bun.build({ entrypoints: [new URL('node_modules/@pierre/diffs/dist/worker/worker.js', root).pathname], target: 'browser', format: 'esm' })
if (!worker.success) throw new Error(worker.logs.map((log) => log.message).join('\n'))

const entry = join(directory, 'entry.mjs')
writeFileSync(entry, `
  import { File } from '@pierre/diffs'
  import { WorkerPoolManager } from '@pierre/diffs/worker'

  const ROUNDS = ${ROUNDS}
  const files = { small: ${JSON.stringify(small)}, large: ${JSON.stringify(large)} }
  const workerCode = ${JSON.stringify(await worker.outputs[0]!.text())}
  const workerFactory = () => new Worker(URL.createObjectURL(new Blob([workerCode], { type: 'text/javascript' })), { type: 'module' })
  window.benchError = null
  window.addEventListener('error', (event) => { window.benchError = String(event.message) })
  window.addEventListener('unhandledrejection', (event) => { window.benchError = String(event.reason) })
  const frame = () => new Promise((resolve) => requestAnimationFrame(() => resolve(performance.now())))

  // The plain-text pass paints every span in the theme foreground, one colour;
  // the highlighted pass has several.
  function highlighted(node) {
    const colours = new Set()
    for (const span of node.querySelectorAll?.('span[style*="color"]') ?? []) {
      colours.add(span.getAttribute('style'))
      if (colours.size > 1) return true
    }
    for (const element of node.querySelectorAll?.('*') ?? []) if (element.shadowRoot && highlighted(element.shadowRoot)) return true
    return false
  }

  let serial = 0
  async function round(pool, contents) {
    const container = document.createElement('div')
    document.body.append(container)
    const file = new File({ theme: 'github-dark-default', themeType: 'dark', overflow: 'wrap', disableFileHeader: true }, pool)
    const start = performance.now()
    file.render({ file: { name: \`file-\${serial++}.ts\`, contents }, containerWrapper: container })
    const renderCall = performance.now() - start
    const firstFrame = await frame() - start
    while (!highlighted(container)) await frame()
    const coloured = performance.now() - start
    file.cleanUp()
    container.remove()
    await frame()
    return { renderCall, firstFrame, coloured }
  }

  const median = (values) => values.toSorted((a, b) => a - b)[Math.floor(values.length / 2)]
  const results = {}
  for (const [variant, poolOptions] of [
    ['workers only', {}],
    ['main thread up to 100 KB', { mainThreadMaxCharacters: 100_000 }],
  ]) {
    const pool = new WorkerPoolManager(
      { poolSize: 2, totalASTLRUCacheSize: 100, workerFactory, onWorkerError: (event) => { window.benchError = 'worker: ' + (event.message ?? event.type) }, ...poolOptions },
      { theme: 'github-dark-default', preferredHighlighter: 'highlights' },
    )
    await pool.initialize()
    for (const [size, contents] of Object.entries(files)) {
      await round(pool, contents)
      const samples = []
      for (let i = 0; i < ROUNDS; i++) samples.push(await round(pool, contents))
      results[\`\${variant}, \${size} file (\${contents.length} chars)\`] = {
        renderCallMs: median(samples.map((sample) => sample.renderCall)),
        firstFrameMs: median(samples.map((sample) => sample.firstFrame)),
        colouredMs: median(samples.map((sample) => sample.coloured)),
      }
    }
    pool.terminate()
  }
  window.results = results
  window.bench = { File, WorkerPoolManager, workerFactory, highlighted }
  document.body.append(Object.assign(document.createElement('pre'), { id: 'results', textContent: JSON.stringify(results, null, 2) }))
`)

const bundle = await Bun.build({ entrypoints: [entry], target: 'browser', format: 'esm' })
if (!bundle.success) throw new Error(bundle.logs.map((log) => log.message).join('\n'))
const page = join(directory, 'diff-highlight.html')
// A bundled grammar can contain "</script>", which would end the inline script early.
const script = (await bundle.outputs[0]!.text()).replaceAll('</script', '<\\/script').replaceAll('<!--', '<\\!--')
const html = `<!doctype html><html><body><script type="module">${script}</script></body></html>`
writeFileSync(page, html)
console.log(page)
// A worker needs an origin, which a page opened from a file does not have:
// `--serve` hosts the page on a loopback port until the process is stopped.
if (process.argv.includes('--serve')) {
  const server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response(html, { headers: { 'content-type': 'text/html' } }) })
  console.log(`serving http://127.0.0.1:${server.port}/ (pid ${process.pid})`)
}
