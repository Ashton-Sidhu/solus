import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { extractAppRoles } from '@solus/server/apps/app-source'
import shellPackage from '../../packages/app-shell/package.json'
import { createRequire } from '../../packages/app-shell/src/modules'
// @ts-expect-error The skill's scripts are plain JavaScript modules that agents run with Node.
import { collectSources, integrationsOf, SHELL_MODULES } from '../../resources/plugins/solus/skills/apps/scripts/bundle-app.mjs'

/**
 * The apps skill builds an app project on the agent's side; the shell and the
 * server run the result. The two sides share no code, so these tests hold
 * together what each one assumes of the other.
 */
const skillDirectory = join(import.meta.dir, '../../resources/plugins/solus/skills/apps')
const templatePackage: { devDependencies: { [name: string]: string } } = JSON.parse(readFileSync(join(skillDirectory, 'assets/app/package.json'), 'utf8'))
const appTypes = readFileSync(join(skillDirectory, 'assets/app/src/solus-app.d.ts'), 'utf8')

// SAFETY: the shell's module map is read by name only; nothing here calls into the host.
const shellRequire = createRequire({ tools: {} as never, storage: {} as never, server: {} as never })

describe('the apps skill and the shell', () => {
  test('the build leaves to the shell exactly the modules the shell answers', () => {
    // WHY: a module the build leaves out and the shell does not answer is an
    // app that fails when it opens. A module the shell has and the build
    // bundles is a second React in one page.
    for (const name of SHELL_MODULES) expect(() => shellRequire(name), name).not.toThrow()
    expect(() => shellRequire('react-dom/server')).toThrow('cannot import')
  })

  test('the project types what the shell exports from @solus/app, and nothing more', () => {
    // WHY: the project typechecks against this file, not against the shell. A
    // name that is typed and not provided compiles and then fails in the frame.
    const provided = Object.keys(shellRequire('@solus/app')).sort()
    const typed = [...appTypes.matchAll(/^ {2}export (?:const|function) (\w+)/gm)].map((match) => match[1]).sort()
    expect(typed).toEqual(provided)
  })

  test('the kit never fills a hover or a selection with the accent', () => {
    // WHY: in the Solus palette `accent` is the terracotta accent itself, not
    // the hover wash that name means elsewhere. The first kit used it for
    // hover, so every button turned solid terracotta under the pointer.
    const kit = readFileSync(join(import.meta.dir, '../../packages/app-shell/src/ui/index.tsx'), 'utf8')
    expect(kit.match(/(?:hover:|selected[^\n]*)bg-accent(?!-surface)/g)).toBeNull()
    expect(kit).toContain('hover:bg-muted')
    // The quiet tint of the accent is a class an app can write.
    expect(readFileSync(join(import.meta.dir, '../../packages/app-shell/src/theme.css'), 'utf8')).toContain('--color-accent-surface: var(--accent-surface)')
  })

  test('the project installs the major versions of the packages the shell runs', () => {
    // WHY: these packages are types only in the project; the shell's copies run. A different major is a different API.
    const major = (range: string) => range.replace(/^[^\d]*/, '').split('.')[0]
    for (const name of ['react', 'react-dom', '@tanstack/react-query', 'recharts', 'lucide-react'] as const) {
      expect(major(templatePackage.devDependencies[name]), name).toBe(major(shellPackage.dependencies[name]))
    }
  })

  test('the build reads integrations from the sources by the server\'s own rule', () => {
    // WHY: a bundle lists its integrations because the server cannot read them
    // from compiled code. The list must be what the server would have read.
    const code = `
      import { tools } from '@solus/app'
      // tools.github.create_issue is in a comment
      const a = tools.linear.list_issues({}); const b = tools["slack"].post_message; const c = other.tools.jira
    `
    expect(integrationsOf(code)).toEqual(extractAppRoles(code))
    expect(integrationsOf(code)).toEqual(['linear', 'slack'])
  })

  test('a bundle carries the project\'s own sources and not the template\'s files or its packages', async () => {
    // WHY: a later session rebuilds the app from these. The template's files are in every new project already.
    const project = mkdtempSync(join(tmpdir(), 'solus-app-project-'))
    try {
      mkdirSync(join(project, 'src/parts'), { recursive: true })
      mkdirSync(join(project, 'node_modules/pkg'), { recursive: true })
      writeFileSync(join(project, 'package.json'), '{}')
      writeFileSync(join(project, 'server.ts'), 'export async function rows() { return [] }')
      writeFileSync(join(project, 'src/App.tsx'), 'export default function App() { return null }')
      writeFileSync(join(project, 'src/parts/Row.tsx'), 'export function Row() { return null }')
      writeFileSync(join(project, 'src/solus-app.d.ts'), 'declare module "@solus/app" {}')
      writeFileSync(join(project, 'src/logo.png'), 'not text')
      writeFileSync(join(project, 'node_modules/pkg/index.js'), 'module.exports = 1')
      expect(Object.keys(await collectSources(project))).toEqual(['package.json', 'server.ts', 'src/App.tsx', 'src/parts/Row.tsx'])
    } finally {
      rmSync(project, { recursive: true, force: true })
    }
  })
})
