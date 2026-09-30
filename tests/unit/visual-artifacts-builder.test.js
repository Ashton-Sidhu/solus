import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initArtifact } from '../../resources/plugins/solus/skills/visual-artifacts/scripts/init-artifact.mjs'
import { assembleHtml, bundleArtifact } from '../../resources/plugins/solus/skills/visual-artifacts/scripts/bundle-artifact.mjs'

const shell = '<!doctype html><html><head><title>Test artifact</title><!-- artifact:styles --></head><body><div id="root"></div><!-- artifact:script --></body></html>'
const directories = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

const dependencyFixture = process.env.SOLUS_ARTIFACT_TEST_PROJECT

test.skipIf(!dependencyFixture)('the complete pipeline embeds assets and preserves the last good bundle on failure', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'solus-artifact-pipeline-'))
  directories.push(directory)
  const projectDirectory = await initArtifact(join(directory, 'source'), { install: false })
  await symlink(join(dependencyFixture, 'node_modules'), join(projectDirectory, 'node_modules'), 'dir')
  await writeFile(join(projectDirectory, 'src/icon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0h10v10H0z"/></svg>')
  await writeFile(join(projectDirectory, 'src/App.tsx'), `import icon from '@/icon.svg'
export default function App() { return <img src={icon} alt="Embedded test icon" className="grid gap-5" /> }
`)
  const { output, bytes } = await bundleArtifact(projectDirectory)
  const html = await readFile(output, 'utf8')
  expect(bytes).toBeGreaterThan(0)
  expect(html).toContain('data:image/svg+xml')
  expect(html).toContain('.gap-5')
  expect(html).not.toContain('<!-- artifact:script -->')
  expect(html).not.toMatch(/<script[^>]+src=/i)
  await writeFile(join(projectDirectory, 'src/App.tsx'), 'export default function App() { const amount: number = "invalid"; return amount }')
  await expect(bundleArtifact(projectDirectory)).rejects.toThrow()
  expect(await readFile(output, 'utf8')).toBe(html)
}, 30000)

test.skipIf(!dependencyFixture)('the compiled starter renders and keeps controls and copy-back output in sync', async () => {
  const { JSDOM } = await import('jsdom')
  const directory = await mkdtemp(join(tmpdir(), 'solus-artifact-runtime-'))
  directories.push(directory)
  const projectDirectory = await initArtifact(join(directory, 'source'), { install: false })
  await symlink(join(dependencyFixture, 'node_modules'), join(projectDirectory, 'node_modules'), 'dir')
  const { output } = await bundleArtifact(projectDirectory)
  const html = await readFile(output, 'utf8')
  const dom = new JSDOM(html, { runScripts: 'outside-only' })
  const document = dom.window.document
  const waitForOutput = expected => new Promise(resolve => {
    const observer = new dom.window.MutationObserver(() => {
      if (document.querySelector('output')?.textContent !== expected) return
      observer.disconnect()
      resolve()
    })
    observer.observe(document.getElementById('root'), { childList: true, subtree: true, characterData: true })
  })
  try {
    const firstRender = waitForOutput('50%')
    dom.window.eval(document.querySelector('script').textContent)
    await firstRender
    expect(document.querySelector('h1').textContent).toBe('Allocation explorer')
    const input = document.querySelector('input')
    const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set
    const changed = waitForOutput('75%')
    setter.call(input, '75')
    input.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
    await changed
    expect(document.querySelector('textarea').value).toContain('75 percent')
    expect(document.querySelector('meter').value).toBe(75)
    const reset = waitForOutput('50%')
    document.querySelector('button').click()
    await reset
    expect(document.querySelector('textarea').value).toContain('50 percent')
    expect(document.querySelector('input').value).toBe('50')
  } finally {
    dom.window.close()
  }
}, 10000)

describe('artifact output is safe to place in an HTML frame', () => {
  test('script and style closing sequences cannot terminate their elements', () => {
    const html = assembleHtml(shell, 'const label = "</ScRiPt><p>data</p>";', 'p::after { content: "</StYlE>"; }')
    expect(html.match(/<\/script>/gi)).toHaveLength(1)
    expect(html.match(/<\/style>/gi)).toHaveLength(1)
    expect(html).toContain('<\\/script>')
    expect(html).toContain('<\\/style>')
  })

  test('replacement metacharacters remain literal source text', () => {
    const html = assembleHtml(shell, 'const label = "$& $` $\'";', 'p { content: "$&"; }')
    expect(html).toContain('const label = "$& $` $\'";')
    expect(html).toContain('content: "$&";')
  })

  test('HTML comment and script text cannot swallow the rest of the page', async () => {
    const { JSDOM } = await import('jsdom')
    const value = '<!--<script></script>'
    const html = assembleHtml(shell, `window.artifactLabel = ${JSON.stringify(value)};`, '')
    const dom = new JSDOM(html, { runScripts: 'outside-only' })
    try {
      dom.window.eval(dom.window.document.querySelector('script').textContent)
      expect(dom.window.artifactLabel).toBe(value)
      expect(dom.window.document.querySelector('script').nextSibling).toBeNull()
    } finally {
      dom.window.close()
    }
  })

  test('broken entry points and external shell assets fail before delivery', () => {
    expect(() => assembleHtml(shell.replace('<!-- artifact:script -->', ''), '', '')).toThrow('exactly one')
    expect(() => assembleHtml(shell.replace('<title>Test artifact</title>', '<title></title>'), '', '')).toThrow('non-empty title')
    expect(() => assembleHtml(shell.replace('</head>', '<script src="./app.js"></script></head>'), '', '')).toThrow('external assets')
  })
})

describe('artifact setup does not replace user files', () => {
  test('an existing directory is refused without changing its contents', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'solus-artifact-existing-'))
    directories.push(directory)
    await writeFile(join(directory, 'owned.txt'), 'user content')
    await expect(initArtifact(directory, { install: false })).rejects.toThrow()
    expect(await readFile(join(directory, 'owned.txt'), 'utf8')).toBe('user content')
  })

  test('new source includes a local build command and bundle markers', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'solus-artifact-new-'))
    directories.push(directory)
    const projectDirectory = await initArtifact(join(directory, 'source'), { install: false })
    const manifest = JSON.parse(await readFile(join(projectDirectory, 'package.json'), 'utf8'))
    expect(manifest.scripts.bundle).toBe('node .artifact/bundle-artifact.mjs')
    const html = await readFile(join(projectDirectory, 'index.html'), 'utf8')
    expect(() => assembleHtml(html, '', '')).not.toThrow()
    expect(await readFile(join(projectDirectory, '.artifact/bundle-artifact.mjs'), 'utf8')).toContain('bundleArtifact')
  })
})
